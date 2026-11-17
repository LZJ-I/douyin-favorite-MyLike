import { randomUUID } from 'node:crypto'
import type { Account } from '../shared/contracts'
import type { SavedGroupKind, SavedGroupLibrary } from '../shared/saved-groups'
import { groupLabels } from '../shared/saved-groups'
import type { Database } from './storage/client'
import type { DouyinEngine } from './douyin/engine'
import { AppError, publicError } from './errors'
import { EndConfirmation, PageProgress, MAX_EMPTY_PAGE_CURSORS } from './read-recovery'
import { assertSavedGroupRemoval, parseSavedGroups } from './douyin/saved-groups'

type Runner = <T>(id: string, fn: (check: () => void) => Promise<T>, background?: boolean) => Promise<T>
export class SavedGroupsService {
  private loop: Promise<void> | null = null
  private preparation: Promise<SavedGroupLibrary> | null = null
  private stopped = false
  private reading = false
  private currentAccount: string | null = null
  private wake: (() => void) | null = null
  constructor(
    private readonly db: Pick<Database, 'call'>,
    private readonly engine: Pick<DouyinEngine, 'request' | 'cancel'>,
    private readonly run: Runner,
    private readonly identify: (id: string, check: () => void) => Promise<Account>,
    private readonly changed: () => void,
    private readonly cadence: { read: number; write: number; confirm?: number } = { read: 350, write: 1500 }
  ) {}
  get running() {
    return !!this.loop || !!this.preparation
  }
  async stop(accountId?: string) {
    if (accountId && this.currentAccount !== accountId) return
    this.stopped = true
    this.wake?.()
    if (this.reading) this.engine.cancel()
    await this.preparation?.catch(() => {})
    await this.loop
  }
  private wait(ms: number) {
    if (this.stopped) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        this.wake = null
        resolve()
      }
      const timer = setTimeout(finish, ms)
      this.wake = finish
    })
  }
  async start(
    accountId: string,
    kind: SavedGroupKind,
    mode: 'sync' | 'remove',
    ids?: string[],
    excludedFolderIds: string[] = []
  ) {
    if (this.running) throw new AppError('BUSY', '请先停止当前合集或短剧任务。')
    const taskId = randomUUID()
    this.stopped = false
    this.currentAccount = accountId
    this.preparation = this.run(accountId, async (check) => {
      if (this.stopped) throw new AppError('CANCELLED', '任务已停止，未发送新的请求。')
      this.reading = true
      try {
        const account = await this.identify(accountId, check)
        check()
        if (this.stopped) throw new AppError('CANCELLED', '任务已停止，未发送新的请求。')
        if (excludedFolderIds.length) {
          if (kind !== 'recommend') throw new AppError('INVALID_INPUT', '仅视频推荐可按收藏夹排除。')
          const protectedIds = new Set(
            await this.db.call('favoriteProtectedIds', { accountId, folderIds: excludedFolderIds })
          )
          if (ids?.some((id) => protectedIds.has(id)))
            throw new AppError('FOLDER_SELECTION_CHANGED', '选择中包含保留收藏夹的视频，请重新选择。')
        }
        return await this.db.call('savedGroupsBegin', {
          accountId,
          taskId,
          kind,
          mode,
          ids,
          remoteId: account.remoteId!
        })
      } finally {
        this.reading = false
      }
    })
    let initial: SavedGroupLibrary
    try {
      initial = await this.preparation
    } catch (error) {
      this.currentAccount = null
      throw error
    } finally {
      this.preparation = null
    }
    if (this.stopped)
      return this.db.call('savedGroupsFinish', {
        accountId,
        taskId,
        status: 'stopped',
        reason: '任务已停止，未发送新的请求。'
      })
    this.loop = this.process(accountId, taskId, kind, mode, initial.cursor, [...excludedFolderIds]).finally(
      () => {
        this.loop = null
        this.currentAccount = null
        this.reading = false
        this.changed()
      }
    )
    this.changed()
    return initial
  }
  private async process(
    accountId: string,
    taskId: string,
    kind: SavedGroupKind,
    mode: 'sync' | 'remove',
    initialCursor: string,
    excludedFolderIds: string[]
  ) {
    const scope = { accountId, taskId }
    const ending = new EndConfirmation(),
      progress = new PageProgress(),
      visited = new Set<string>()
    let cursor = initialCursor
    let unavailablePages = 0
    try {
      while (!this.stopped) {
        if (mode === 'sync') {
          const page = await this.run(
            accountId,
            async (check) => {
              this.reading = true
              try {
                const account = await this.identify(accountId, check)
                check()
                if (this.stopped) throw new AppError('CANCELLED', '同步已停止。')
                const response = await this.engine.request(
                  accountId,
                  kind === 'recommend' ? 'recommendations' : kind === 'mix' ? 'savedMixes' : 'savedSeries',
                  kind === 'recommend'
                    ? {
                        sec_user_id: account.remoteId!,
                        max_cursor: cursor,
                        min_cursor: '0',
                        count: '20',
                        from: '1'
                      }
                    : { cursor, count: '12' }
                )
                check()
                if (this.stopped) throw new AppError('CANCELLED', '同步已停止。')
                const page = parseSavedGroups(response, kind)
                const unavailableOnly = !page.items.length && page.unavailableCount > 0
                if (
                  page.hasMore &&
                  ((!page.items.length && !page.unavailableCount) ||
                    visited.has(page.cursor) ||
                    page.cursor === cursor)
                )
                  throw new AppError('CURSOR_STALLED', '列表返回空页或重复游标，已保留当前列表和断点。')
                if (
                  !ending.check(
                    cursor,
                    unavailableOnly
                      ? [page.cursor, String(page.unavailableCount)]
                      : page.items.map((i) => i.id),
                    page.hasMore && !unavailableOnly
                  )
                )
                  return null
                if (unavailableOnly && unavailablePages >= MAX_EMPTY_PAGE_CURSORS)
                  throw new AppError(
                    'EMPTY_PAGE_LIMIT',
                    '连续不可见推荐页已达探查上限，未确认末尾，已保留列表和断点。'
                  )
                progress.check(
                  kind,
                  page.items.map((i) => i.id),
                  page.hasMore
                )
                await this.db.call('savedGroupsPage', {
                  ...scope,
                  remoteId: account.remoteId!,
                  requestCursor: cursor,
                  ...page
                })
                return page
              } finally {
                this.reading = false
              }
            },
            true
          )
          if (page) {
            unavailablePages = !page.items.length && page.unavailableCount ? unavailablePages + 1 : 0
            visited.add(cursor)
            cursor = page.cursor
            this.changed()
            if (!page.hasMore) break
          }
          await this.wait(page ? this.cadence.read : (this.cadence.confirm ?? 3000))
        } else {
          const id = await this.db.call('savedGroupsNext', scope)
          if (!id) break
          let reserved = false,
            sent = false
          try {
            await this.run(accountId, async (check) => {
              const account = await this.identify(accountId, check)
              check()
              const task = await this.db.call('savedGroupsScope', scope)
              if (task.remoteId !== account.remoteId)
                throw new AppError('IDENTITY_MISMATCH', '账号身份已变化，取消请求未发送。')
              if (this.stopped) return
              if (excludedFolderIds.length) {
                const protectedIds = await this.db.call('favoriteProtectedIds', {
                  accountId,
                  folderIds: excludedFolderIds
                })
                if (protectedIds.includes(id))
                  throw new AppError(
                    'FOLDER_SELECTION_CHANGED',
                    '收藏夹内容已变化，该视频已保留，后续取消已暂停。'
                  )
              }
              if (this.stopped) return
              await this.db.call('savedGroupsWrite', { ...scope, id, status: 'sending' })
              reserved = true
              // Use the web client's explicit cancellation endpoint, one durable item per request.
              sent = true
              const reply = await this.engine.request(
                accountId,
                kind === 'recommend' ? 'recommendRemove' : kind === 'mix' ? 'mixRemove' : 'seriesRemove',
                kind === 'recommend'
                  ? { item_id: id, sec_user_id: account.remoteId! }
                  : {
                      [kind === 'mix' ? 'mix_ids' : 'series_ids']: id
                    }
              )
              assertSavedGroupRemoval(reply, kind)
              await this.db.call('savedGroupsWrite', { ...scope, id, status: 'success' })
              this.changed()
            })
          } catch (error) {
            if (reserved)
              await this.db.call('savedGroupsWrite', {
                ...scope,
                id,
                status:
                  sent && !(error instanceof AppError && error.code === 'API_REJECTED')
                    ? 'unknown'
                    : 'failed',
                reason: publicError(error).message
              })
            throw error
          }
          await this.wait(this.cadence.write)
        }
      }
      await this.db.call('savedGroupsFinish', {
        ...scope,
        status: this.stopped ? 'stopped' : 'completed',
        reason: this.stopped
          ? '已停止，未发送项保留；不会自动继续。'
          : `${groupLabels[kind]}${mode === 'sync' ? '已读到网页接口末尾；仅覆盖接口可返回的内容，不能确认账号全部内容已读取。' : '本次所选内容的取消任务已完成，不代表账号已清空。'}`
      })
    } catch (error) {
      try {
        await this.db.call('savedGroupsFinish', {
          ...scope,
          status: this.stopped ? 'stopped' : 'paused',
          reason: this.stopped ? '已停止并保留断点。' : publicError(error).message
        })
      } catch {
        console.error('[MyLike] Group task could not save its final state.')
      }
    }
  }
}
