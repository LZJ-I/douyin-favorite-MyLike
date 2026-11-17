import type { DatabaseSync } from 'node:sqlite'
import type { SavedGroup, SavedGroupKind, SavedGroupLibrary, SavedGroupTask } from '../../shared/saved-groups'
import { AppError } from '../errors'

// Additive tables keep the existing works, favorites, account sessions and cursors intact.
export const savedGroupsSchema = `
CREATE TABLE IF NOT EXISTS saved_group_page_coverage(accountId TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,kind TEXT NOT NULL,runId TEXT NOT NULL,cursor TEXT NOT NULL,unavailable INTEGER NOT NULL,PRIMARY KEY(accountId,kind,runId,cursor));
CREATE TABLE IF NOT EXISTS saved_groups(accountId TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,kind TEXT NOT NULL,id TEXT NOT NULL,title TEXT NOT NULL,author TEXT NOT NULL,coverUrl TEXT,episodes INTEGER NOT NULL,seenRun TEXT NOT NULL,PRIMARY KEY(accountId,kind,id));
CREATE TABLE IF NOT EXISTS saved_group_scans(accountId TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,kind TEXT NOT NULL,runId TEXT NOT NULL,cursor TEXT NOT NULL,complete INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(accountId,kind));
CREATE TABLE IF NOT EXISTS saved_group_tasks(accountId TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,id TEXT NOT NULL,kind TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,remoteId TEXT NOT NULL,received INTEGER NOT NULL DEFAULT 0,reason TEXT);
CREATE TABLE IF NOT EXISTS saved_group_writes(accountId TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,kind TEXT NOT NULL,id TEXT NOT NULL,taskId TEXT NOT NULL,position INTEGER NOT NULL,status TEXT NOT NULL,reason TEXT,PRIMARY KEY(accountId,kind,id));
UPDATE saved_group_writes SET status='unknown',reason='应用中断，结果未知，未自动重发。' WHERE status='sending';
UPDATE saved_group_tasks SET status='stopped',reason='上次任务已停止，保留列表和断点；未发送项不会自动执行。' WHERE status='running';
`
export class SavedGroupsStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: <T>(fn: () => T) => T
  ) {}
  private identity(accountId: string, remoteId: string) {
    if (this.db.prepare('SELECT remoteId FROM accounts WHERE id=?').get(accountId)?.remoteId !== remoteId)
      throw new AppError('IDENTITY_MISMATCH', '当前账号身份不匹配，合集及短剧操作未执行。')
  }
  library(accountId: string, kind: SavedGroupKind): SavedGroupLibrary {
    const task = this.db
      .prepare(
        'SELECT id,kind,mode,status,received,reason FROM saved_group_tasks WHERE accountId=? AND kind=?'
      )
      .get(accountId, kind)
    const counts = task
      ? this.db
          .prepare(
            "SELECT coalesce(sum(status='success'),0) AS success,coalesce(sum(status='pending'),0) AS pending,coalesce(sum(status IN ('unknown','sending')),0) AS unknown FROM saved_group_writes WHERE accountId=? AND taskId=?"
          )
          .get(accountId, task.id!)
      : {}
    const scan = this.db
      .prepare('SELECT cursor,complete,runId FROM saved_group_scans WHERE accountId=? AND kind=?')
      .get(accountId, kind)
    return {
      items: this.db
        .prepare(
          'SELECT id,kind,title,author,coverUrl,episodes FROM saved_groups WHERE accountId=? AND kind=? ORDER BY title,id'
        )
        .all(accountId, kind) as unknown as SavedGroup[],
      task: task ? ({ ...task, ...counts } as unknown as SavedGroupTask) : null,
      complete: !!scan?.complete,
      unavailableCount: Number(
        this.db
          .prepare(
            'SELECT coalesce(sum(unavailable),0) AS n FROM saved_group_page_coverage WHERE accountId=? AND kind=? AND runId=?'
          )
          .get(accountId, kind, scan?.runId ?? '')?.n ?? 0
      ),
      cursor: String(scan?.cursor ?? '0')
    }
  }
  begin(input: {
    accountId: string
    kind: SavedGroupKind
    taskId: string
    remoteId: string
    mode: 'sync' | 'remove'
    ids?: string[]
  }) {
    this.identity(input.accountId, input.remoteId)
    return this.transaction(() => {
      const { accountId, kind, taskId, mode } = input
      if (mode === 'sync') {
        const old = this.db
          .prepare('SELECT * FROM saved_group_scans WHERE accountId=? AND kind=?')
          .get(accountId, kind)
        const unresolved = this.db
          .prepare("SELECT 1 FROM saved_group_writes WHERE accountId=? AND kind=? AND status='unknown'")
          .get(accountId, kind)
        if (!old || old.complete || unresolved)
          this.db
            .prepare(
              'INSERT INTO saved_group_scans VALUES(?,?,?,?,0) ON CONFLICT(accountId,kind) DO UPDATE SET runId=excluded.runId,cursor=excluded.cursor,complete=0'
            )
            .run(accountId, kind, taskId, '0')
      } else {
        const ids = [...new Set(input.ids ?? [])]
        if (!ids.length || ids.length > 1000)
          throw new AppError('INVALID_INPUT', '请选择1至1000个合集或短剧。')
        for (const id of ids) {
          if (
            !this.db
              .prepare('SELECT 1 FROM saved_groups WHERE accountId=? AND kind=? AND id=?')
              .get(accountId, kind, id)
          )
            throw new AppError('GROUP_CHANGED', '所选合集或短剧已变化，请重新读取列表。')
          if (
            this.db
              .prepare(
                "SELECT 1 FROM saved_group_writes WHERE accountId=? AND kind=? AND id=? AND status IN ('sending','unknown')"
              )
              .get(accountId, kind, id)
          )
            throw new AppError(
              'UNRESOLVED_WRITE',
              '所选内容有结果未知的请求，请先同步完整列表核对结果，未重复发送。'
            )
        }
        const insert = this.db.prepare(
          "INSERT INTO saved_group_writes VALUES(?,?,?,?,?,'pending',NULL) ON CONFLICT(accountId,kind,id) DO UPDATE SET taskId=excluded.taskId,position=excluded.position,status='pending',reason=NULL"
        )
        ids.forEach((id, i) => insert.run(accountId, kind, id, taskId, i))
      }
      this.db
        .prepare(
          'INSERT INTO saved_group_tasks VALUES(?,?,?,?,? ,?,0,NULL) ON CONFLICT(accountId) DO UPDATE SET id=excluded.id,kind=excluded.kind,mode=excluded.mode,status=excluded.status,remoteId=excluded.remoteId,received=0,reason=NULL'
        )
        .run(accountId, taskId, kind, mode, 'running', input.remoteId)
      return this.library(accountId, kind)
    })
  }
  scope(accountId: string, taskId: string) {
    const task = this.db
      .prepare('SELECT * FROM saved_group_tasks WHERE accountId=? AND id=?')
      .get(accountId, taskId)
    if (!task) throw new AppError('TASK_CHANGED', '合集或短剧任务已变化。')
    return task as unknown as {
      kind: SavedGroupKind
      remoteId: string
      mode: 'sync' | 'remove'
      status: string
    }
  }
  page(input: {
    unavailableCount?: number
    accountId: string
    taskId: string
    remoteId: string
    requestCursor: string
    cursor: string
    hasMore: boolean
    items: SavedGroup[]
  }) {
    this.identity(input.accountId, input.remoteId)
    return this.transaction(() => {
      const task = this.scope(input.accountId, input.taskId)
      if (task.mode !== 'sync' || task.status !== 'running')
        throw new AppError('TASK_CHANGED', '同步任务已停止。')
      const scan = this.db
        .prepare('SELECT * FROM saved_group_scans WHERE accountId=? AND kind=?')
        .get(input.accountId, task.kind)!
      if (scan.cursor !== input.requestCursor)
        throw new AppError('CURSOR_STALLED', '合集或短剧断点已变化，未提交旧页面。')
      const unavailable = input.unavailableCount ?? 0
      if (!Number.isSafeInteger(unavailable) || unavailable < 0)
        throw new AppError('INVALID_INPUT', '不可见记录数量无效。')
      this.db
        .prepare(
          'INSERT INTO saved_group_page_coverage VALUES(?,?,?,?,?) ON CONFLICT(accountId,kind,runId,cursor) DO UPDATE SET unavailable=excluded.unavailable'
        )
        .run(input.accountId, task.kind, scan.runId!, input.requestCursor, unavailable)
      const insert = this.db.prepare(
        'INSERT INTO saved_groups VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(accountId,kind,id) DO UPDATE SET title=excluded.title,author=excluded.author,coverUrl=excluded.coverUrl,episodes=excluded.episodes,seenRun=excluded.seenRun'
      )
      for (const item of input.items) {
        if (item.kind !== task.kind) throw new AppError('INVALID_INPUT', '收藏类型不匹配。')
        insert.run(
          input.accountId,
          task.kind,
          item.id,
          item.title,
          item.author,
          item.coverUrl,
          item.episodes,
          scan.runId!
        )
      }
      this.db
        .prepare('UPDATE saved_group_scans SET cursor=?,complete=? WHERE accountId=? AND kind=?')
        .run(input.cursor, +!input.hasMore, input.accountId, task.kind)
      this.db
        .prepare('UPDATE saved_group_tasks SET received=received+? WHERE accountId=?')
        .run(input.items.length, input.accountId)
      const unavailableTotal = Number(
        this.db
          .prepare(
            'SELECT coalesce(sum(unavailable),0) AS n FROM saved_group_page_coverage WHERE accountId=? AND kind=? AND runId=?'
          )
          .get(input.accountId, task.kind, scan.runId!)?.n ?? 0
      )
      // An unavailable page is not evidence that a previously stored item or
      // an uncertain cancellation disappeared. Preserve both for verification.
      if (!input.hasMore && !unavailableTotal) {
        this.db
          .prepare('DELETE FROM saved_groups WHERE accountId=? AND kind=? AND seenRun<>?')
          .run(input.accountId, task.kind, scan.runId!)
        this.db
          .prepare(
            "UPDATE saved_group_writes SET status=CASE WHEN EXISTS(SELECT 1 FROM saved_groups g WHERE g.accountId=saved_group_writes.accountId AND g.kind=saved_group_writes.kind AND g.id=saved_group_writes.id) THEN 'failed' ELSE 'success' END,reason='已通过完整同步核对上次结果；未自动重发。' WHERE accountId=? AND kind=? AND status='unknown'"
          )
          .run(input.accountId, task.kind)
      }
      return this.library(input.accountId, task.kind)
    })
  }
  next(accountId: string, taskId: string): string | null {
    this.scope(accountId, taskId)
    return (
      (this.db
        .prepare(
          "SELECT id FROM saved_group_writes WHERE accountId=? AND taskId=? AND status='pending' ORDER BY position LIMIT 1"
        )
        .get(accountId, taskId)?.id as string) ?? null
    )
  }
  write(input: {
    accountId: string
    taskId: string
    id: string
    status: 'sending' | 'success' | 'failed' | 'unknown'
    reason?: string
  }) {
    return this.transaction(() => {
      const task = this.scope(input.accountId, input.taskId)
      if (task.mode !== 'remove' || task.status !== 'running')
        throw new AppError('TASK_CHANGED', '取消任务已停止，未重复发送。')
      this.identity(input.accountId, task.remoteId)
      const expected = input.status === 'sending' ? 'pending' : 'sending'
      const changed = this.db
        .prepare(
          'UPDATE saved_group_writes SET status=?,reason=? WHERE accountId=? AND taskId=? AND id=? AND kind=? AND status=?'
        )
        .run(input.status, input.reason ?? null, input.accountId, input.taskId, input.id, task.kind, expected)
      if (!changed.changes) throw new AppError('TASK_CHANGED', '该合集或短剧请求已被处理，未重复发送。')
      if (input.status === 'success')
        this.db
          .prepare('DELETE FROM saved_groups WHERE accountId=? AND kind=? AND id=?')
          .run(input.accountId, task.kind, input.id)
      return null
    })
  }
  finish(accountId: string, taskId: string, status: SavedGroupTask['status'], reason: string | null) {
    const task = this.scope(accountId, taskId)
    this.db
      .prepare('UPDATE saved_group_tasks SET status=?,reason=? WHERE accountId=? AND id=?')
      .run(status, reason, accountId, taskId)
    return this.library(accountId, task.kind)
  }
}
