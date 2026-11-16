import { randomUUID } from 'node:crypto'
import type { Account, UnlikeTask, UnlikeItem } from '../shared/contracts'
import type { Database } from './storage/client'
import type { DouyinEngine } from './douyin/engine'
import { parseFavoriteState, parseLikeState, parseUnlikeResult } from './douyin/parse'
import { AppError } from './errors'
import { parseUnlikeBatchResult } from './douyin/unlike-batch'

type Run = <T>(
  accountId: string,
  action: (check: () => void) => Promise<T>,
  background?: boolean
) => Promise<T>
// One durable task, one request at a time. A stop waits for the current bounded write;
// it never cancels a write and then automatically retries it.
export class UnlikeService {
  private loop: Promise<void> | null = null
  private stopped = false
  private wake: (() => void) | null = null
  constructor(
    private readonly db: Database,
    private readonly engine: Pick<DouyinEngine, 'request'> & Partial<Pick<DouyinEngine, 'assertAvailable'>>,
    private readonly run: Run,
    private readonly identity: (accountId: string, check: () => void) => Promise<Account>,
    private readonly changed: (committed?: boolean) => void,
    private readonly interval = 2000,
    private readonly verifyWrites = true
  ) {}
  get running(): boolean {
    return this.loop !== null
  }
  async start(
    accountId: string,
    workIds: string[],
    mode: 'single' | 'batch',
    source: UnlikeTask['source'] = 'likes',
    allLikes = false
  ): Promise<UnlikeTask> {
    if (this.running) throw new AppError('BUSY', '请先停止当前取消点赞或收藏任务。')
    const task = await this.db.call('unlikeCreate', {
      accountId,
      workIds,
      mode,
      source,
      allLikes,
      id: randomUUID()
    })
    this.launch(task)
    return task
  }
  async resume(accountId: string, taskId: string): Promise<UnlikeTask> {
    if (this.running) throw new AppError('BUSY', '请先停止当前取消点赞或收藏任务。')
    const task = await this.db.call('unlikeUpdate', { accountId, taskId, status: 'running', reason: null })
    this.launch(task)
    return task
  }
  async stop(): Promise<void> {
    this.stopped = true
    this.wake?.()
    await this.loop
  }
  private async waitNext(): Promise<void> {
    if (this.stopped) return
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        this.wake = null
        resolve()
      }
      const timer = setTimeout(finish, this.interval)
      this.wake = finish
    })
  }
  private launch(task: UnlikeTask): void {
    this.stopped = false
    this.loop = this.process(task).finally(() => {
      this.loop = null
      this.changed()
    })
    // The task error is persisted in process; a failing database must still reach
    // the caller of stop(), without creating an unhandled rejection meanwhile.
    void this.loop.catch(() => {})
    this.changed()
  }
  private async process(task: UnlikeTask): Promise<void> {
    const scope = { accountId: task.accountId, taskId: task.id }
    const favorite = task.source === 'favorites'
    try {
      while (!this.stopped) {
        if (task.mode === 'batch' && task.total >= 50) {
          const batch = await this.db.call('unlikeBatchNext', scope)
          if (batch.length >= 2) {
            if (!(await this.processBatch(task, batch))) return
            await this.waitNext()
            continue
          }
        }
        const item = await this.db.call('unlikeNext', scope)
        if (!item) {
          const current = await this.db.call('unlikeTask', scope)
          await this.db.call('unlikeUpdate', {
            ...scope,
            status: 'completed',
            reason: current?.unknown
              ? '未发送项已处理；结果未知项需单独核验。'
              : '本轮已处理完成，请查看逐条结果。'
          })
          return
        }
        let reserved = false,
          sent = false
        try {
          await this.run(
            task.accountId,
            async (check) => {
              if (this.stopped) return
              const account = await this.identity(task.accountId, check)
              check()
              if (account.remoteId !== task.remoteId)
                throw new AppError('IDENTITY_MISMATCH', '当前登录身份与任务不符，未发送请求。')
              if (this.stopped) return
              let awemeType = '0'
              let itemType = '0'
              if (favorite) {
                const detail = await this.engine.request(task.accountId, 'detail', { aweme_id: item.workId })
                check()
                if (this.stopped) return
                const state = parseFavoriteState(detail, item.workId)
                awemeType = state.type
                if (!state.collected) {
                  await this.db.call('unlikeReserve', { ...scope, workId: item.workId })
                  reserved = true
                  await this.db.call('unlikeFinish', {
                    ...scope,
                    workId: item.workId,
                    status: 'success',
                    errorCode: null,
                    reason: '已核验当前未收藏，已同步本地记录，未重复发送取消请求。'
                  })
                  reserved = false
                  this.changed(true)
                  return
                }
              }
              const typedRetry =
                !favorite && (await this.db.call('unlikeNeedsTypeCheck', { ...scope, workId: item.workId }))
              if (!favorite && (!item.platformSeen || typedRetry)) {
                const detail = await this.engine
                  .request(task.accountId, 'detail', { aweme_id: item.workId })
                  .catch((error) => {
                    // A user's own confirmed reaction can be removed without viewing
                    // an unavailable post. Only an explicitly reselected known failure
                    // with a prior platform-seen owner record gets this single attempt.
                    if (
                      typedRetry &&
                      item.platformSeen &&
                      error instanceof AppError &&
                      error.code === 'CONTENT_UNAVAILABLE'
                    )
                      return null
                    throw error
                  })
                check()
                if (this.stopped) return
                if (detail && !parseLikeState(detail, item.workId)) {
                  await this.db.call('unlikeReserve', { ...scope, workId: item.workId })
                  reserved = true
                  await this.db.call('unlikeFinish', {
                    ...scope,
                    workId: item.workId,
                    status: typedRetry ? 'success' : 'failed',
                    errorCode: typedRetry ? null : 'NOT_LIKED',
                    reason: typedRetry
                      ? '已核验当前未点赞，已同步本地记录，未重复发送请求。'
                      : '已核验当前账号未点赞，未发送取消请求；本地记录保留。'
                  })
                  reserved = false
                  this.changed()
                  return
                }
                // The web client maps XgVideo (aweme_type=107) to item_type=1;
                // regular Douyin videos and image posts use item_type=0.
                itemType = Number(detail?.aweme_detail?.aweme_type) === 107 ? '1' : '0'
              }
              await this.db.call('unlikeReserve', { ...scope, workId: item.workId })
              reserved = true
              // No await between reservation and issuing the write. From here onward,
              // any unconfirmed result is unknown, including a page navigation.
              sent = true
              const result = await this.engine.request(
                task.accountId,
                favorite ? 'favoriteRemove' : 'unlike',
                {
                  aweme_id: item.workId,
                  ...(favorite ? { aweme_type: awemeType } : itemType === '1' ? { item_type: itemType } : {})
                }
              )
              parseUnlikeResult(result)
              if (this.verifyWrites) await this.verifyRemoval(task, item.workId)
              await this.db.call('unlikeFinish', {
                ...scope,
                workId: item.workId,
                status: 'success',
                errorCode: null,
                reason: favorite ? '平台已确认取消收藏。' : '平台已确认取消点赞。'
              })
              reserved = false
              this.changed(true)
            },
            true
          )
        } catch (error) {
          if (this.stopped && !reserved && !sent) break
          const code = error instanceof AppError ? error.code : 'STORAGE_ERROR'
          if (favorite && code === 'CONTENT_UNAVAILABLE') {
            const reason = `${error instanceof AppError ? error.message : '作品不可访问。'} 已跳过并保留本地记录，未自动重发。`
            if (reserved)
              await this.db.call('unlikeFinish', {
                ...scope,
                workId: item.workId,
                status: 'failed',
                errorCode: 'ITEM_SKIPPED',
                reason
              })
            else
              await this.db.call('unlikeSkip', {
                ...scope,
                workId: item.workId,
                reason
              })
            this.changed()
            await this.waitNext()
            continue
          }
          const rejected = sent && code === 'API_REJECTED'
          if (reserved)
            await this.db.call('unlikeFinish', {
              ...scope,
              workId: item.workId,
              status: sent && !rejected ? 'unknown' : 'failed',
              errorCode: code,
              reason: rejected
                ? '平台已明确拒绝，本地条目保留，未自动重发。'
                : sent
                  ? '请求已发出但结果未明确确认，本地条目保留，未自动重发。'
                  : '请求未发送，请查看任务原因。'
            })
          await this.db.call('unlikeUpdate', {
            ...scope,
            status: 'paused',
            errorCode: code,
            reason: rejected
              ? '平台拒绝了请求，后续条目已暂停，请检查账号或作品状态。'
              : sent
                ? '请求结果未知，后续条目已暂停；请重新核验。'
                : error instanceof AppError
                  ? `${item.title || '作品'}（ID ${item.workId}）：${error.message}`.slice(0, 600)
                  : '保存或读取失败，任务已暂停。'
          })
          this.changed()
          return
        }
        await this.waitNext()
      }
      await this.db.call('unlikeUpdate', {
        ...scope,
        status: 'stopped',
        reason: '已停止后续未发送项；已发出请求的结果已单独保存。'
      })
    } catch (error) {
      await this.db.call('unlikeUpdate', {
        ...scope,
        status: 'paused',
        errorCode: 'STORAGE_ERROR',
        reason: '任务状态未能完整保存，已停止后续请求；重启后核对逐条结果。'
      })
      throw error
    } finally {
      this.changed()
    }
  }
  private async processBatch(task: UnlikeTask, items: UnlikeItem[]): Promise<boolean> {
    const scope = { accountId: task.accountId, taskId: task.id }
    const reserved = new Set<string>()
    let sent = false
    try {
      return await this.run(
        task.accountId,
        async (check) => {
          if (this.stopped) return true
          this.engine.assertAvailable?.(
            task.accountId,
            task.source === 'favorites' ? 'favoriteBatch' : 'unlikeBatch'
          )
          const account = await this.identity(task.accountId, check)
          check()
          if (account.remoteId !== task.remoteId)
            throw new AppError('IDENTITY_MISMATCH', '账号身份已变化，本批请求未发送。')
          if (this.stopped) return true
          for (const item of items) {
            await this.db.call('unlikeReserve', { ...scope, workId: item.workId })
            reserved.add(item.workId)
          }
          if (this.stopped) {
            for (const workId of reserved)
              await this.db.call('unlikeFinish', {
                ...scope,
                workId,
                status: 'failed',
                errorCode: 'CANCELLED',
                reason: '已停止，本批请求未发送。'
              })
            reserved.clear()
            return true
          }
          const ids = items.map((item) => item.workId)
          sent = true
          const reply = await this.engine.request(
            task.accountId,
            task.source === 'favorites' ? 'favoriteBatch' : 'unlikeBatch',
            {
              aweme_ids: ids.join(','),
              [task.source === 'favorites' ? 'aweme_type_map' : 'item_type_map']: JSON.stringify(
                Object.fromEntries(ids.map((id) => [id, 0]))
              ),
              sec_user_id: account.remoteId!
            }
          )
          const failed = parseUnlikeBatchResult(reply, ids)
          for (const workId of ids) {
            if (this.verifyWrites && !failed.has(workId)) await this.verifyRemoval(task, workId)
            await this.db.call('unlikeFinish', {
              ...scope,
              workId,
              status: failed.has(workId) ? 'failed' : 'success',
              errorCode: failed.has(workId) ? 'API_REJECTED' : null,
              reason: failed.has(workId)
                ? '平台明确返回此条取消失败，保留本地记录。'
                : `平台批量接口已确认取消${task.source === 'favorites' ? '收藏' : '点赞'}。`
            })
            reserved.delete(workId)
          }
          this.changed(true)
          if (failed.size) {
            await this.db.call('unlikeUpdate', {
              ...scope,
              status: 'paused',
              errorCode: 'API_REJECTED',
              reason: `本批有 ${failed.size} 条被平台拒绝，已保存逐条结果并暂停。`
            })
            return false
          }
          return true
        },
        true
      )
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'STORAGE_ERROR'
      for (const workId of reserved)
        await this.db.call('unlikeFinish', {
          ...scope,
          workId,
          status: sent && code !== 'API_REJECTED' ? 'unknown' : 'failed',
          errorCode: code,
          reason:
            sent && code !== 'API_REJECTED'
              ? '本批请求结果不明确，未自动重发。'
              : '本批请求未成功，保留本地记录。'
        })
      await this.db.call('unlikeUpdate', {
        ...scope,
        status: 'paused',
        errorCode: code,
        reason: sent
          ? '本批结果已保存，后续请求暂停；未知项须先核验，未自动重发。'
          : '账号或任务状态需要检查，本批请求未发送。'
      })
      this.changed()
      return false
    }
  }
  private async verifyRemoval(task: UnlikeTask, workId: string): Promise<void> {
    const detail = await this.engine.request(task.accountId, 'detail', { aweme_id: workId })
    const active =
      task.source === 'favorites'
        ? parseFavoriteState(detail, workId).collected
        : parseLikeState(detail, workId)
    if (active)
      throw new AppError(
        'UNKNOWN_RESULT',
        '取消请求已返回，但重新读取仍显示原状态；本地记录保留，未计为成功。'
      )
  }
  async verify(accountId: string, taskId: string, workId: string): Promise<UnlikeTask> {
    if (this.running) throw new AppError('BUSY', '请先停止正在运行的取消点赞或收藏任务。')
    const task = await this.db.call('unlikeTask', { accountId, taskId })
    if (!task) throw new AppError('TASK_CHANGED', '任务不存在。')
    return this.run(accountId, async (check) => {
      const account = await this.identity(accountId, check)
      if (account.remoteId !== task.remoteId)
        throw new AppError('IDENTITY_MISMATCH', '当前登录身份与任务不符。')
      const detail = await this.engine.request(accountId, 'detail', { aweme_id: workId })
      check()
      const result = await this.db.call('unlikeResolve', {
        accountId,
        taskId,
        workId,
        liked:
          task.source === 'favorites'
            ? parseFavoriteState(detail, workId).collected
            : parseLikeState(detail, workId)
      })
      this.changed(true)
      return result
    })
  }
}
