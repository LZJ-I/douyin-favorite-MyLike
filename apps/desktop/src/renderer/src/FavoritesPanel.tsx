import { CollectionActions } from './CollectionActions'
import { useEffect, useState } from 'react'
import type { FavoriteFolder, FavoritesTask, Snapshot } from '../../shared/contracts'
import type { RecoveryState } from '../../shared/recovery-state'
import { taskRecovery } from '../../shared/task-recovery'
import { call, type Perform } from './api'
import { Select } from './Select'

export function FavoriteIssues({ task }: { task: FavoritesTask | null }) {
  return task?.issues?.length ? (
    <details className="favorite-sync-issues">
      <summary>未完成的收藏夹（{task.issues.length}）</summary>
      <ul>
        {task.issues.map((issue) => (
          <li key={issue.folderId}>
            <strong>{issue.title}</strong>
            <small>
              {taskRecovery(issue.errorCode)?.message ?? '暂时未能同步这个收藏夹，可以稍后重试。'}
            </small>
            <details className="runtime-details">
              <summary>诊断详情</summary>
              <small>{'ID ' + issue.folderId + ' · ' + issue.reason}</small>
            </details>
          </li>
        ))}
      </ul>
    </details>
  ) : null
}
export function useFavoriteFolders(accountId: string | null, revision: number) {
  const [result, setResult] = useState<{
    accountId: string
    folders: FavoriteFolder[]
    error: string
  } | null>(null)
  useEffect(() => {
    if (!accountId) return
    let current = true
    void call(window.mylike.invoke('favoriteFolders', { accountId })).then(
      (folders) => {
        if (current) setResult({ accountId, folders, error: '' })
      },
      (error) => {
        if (current) setResult({ accountId, folders: [], error: error.message })
      }
    )
    return () => {
      current = false
    }
  }, [accountId, revision])
  return result?.accountId === accountId
    ? { ...result, loaded: true }
    : { folders: [], error: '', loaded: false }
}
export function FavoritesPanel({
  accountId,
  task,
  busy,
  perform,
  folders,
  folderId,
  setFolderId,
  error,
  compact = false,
  snapshot
}: {
  snapshot: Snapshot | null
  accountId: string | null
  task: FavoritesTask | null
  busy: boolean
  perform: Perform
  start: () => void
  folders?: FavoriteFolder[]
  folderId?: string | null
  setFolderId?: (id: string | null) => void
  error?: string
  compact?: boolean
  updateTask?: FavoritesTask | null
  recovery?: readonly RecoveryState[]
  login?: () => void
  accessChecks?: readonly { accountId: string; operation: string; at: number }[]
}) {
  const latest = snapshot?.favoritesUpdate
  const progress =
    latest && (latest.status === 'running' || latest.updatedAt > (task?.updatedAt ?? 0)) ? latest : task
  return (
    <section className={compact ? 'favorites-toolbar' : 'panel'} aria-label="收藏同步">
      {!compact && <h2>收藏与收藏夹</h2>}
      {setFolderId && (
        <Select
          label="收藏夹筛选"
          value={folderId ?? ''}
          onChange={(value) => setFolderId(value || null)}
          options={[
            { value: '', label: '全部收藏' },
            ...(folders ?? []).map((folder) => ({
              value: folder.id,
              label: folder.title + ' · ' + folder.localCount
            }))
          ]}
        />
      )}
      {progress && (
        <span className="favorites-progress" role="status">
          {(progress.status === 'running'
            ? '进行中'
            : progress.status === 'completed'
              ? '已完成'
              : progress.status === 'partial'
                ? progress.foldersTotal > 0 &&
                  progress.foldersDone === progress.foldersTotal &&
                  !progress.foldersDeferred &&
                  progress.incomplete === 1
                  ? '收藏夹接口已遍历 · 全部收藏存在空页，成员完整性待核对'
                  : '部分完成 · 有收藏夹或条目待复查'
                : '已停止') +
            ' · 本次新增 ' +
            progress.added +
            ' 条' +
            (progress.mode === 'update'
              ? ' · 更新顶部'
              : ' · 收藏夹 ' + progress.foldersDone + '/' + progress.foldersTotal)}
        </span>
      )}
      <div className="panel-actions">
        <CollectionActions
          snapshot={snapshot}
          accountId={accountId}
          source="favorites"
          busy={busy}
          perform={perform}
        />
      </div>
      {error && (
        <p role="alert" className="task-error">
          {error}
        </p>
      )}

      <FavoriteIssues task={task} />
      {(folders ?? []).some((folder) => folder.localCount < folder.remoteCount) && (
        <p className="task-error" role="status">
          收藏夹成员数量尚未对齐：
          {(folders ?? [])
            .filter((folder) => folder.localCount < folder.remoteCount)
            .map((folder) => `${folder.title}（本地 ${folder.localCount} / 平台 ${folder.remoteCount}）`)
            .join('、')}
          。接口末尾不能证明成员齐全，数量未对齐的收藏夹暂停用于批量排除。
        </p>
      )}
    </section>
  )
}
