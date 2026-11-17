import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { SavedGroupKind, SavedGroupLibrary } from '../../shared/saved-groups'
import { groupLabels } from '../../shared/saved-groups'
import { MAX_BATCH_SIZE } from '../../shared/contracts'
import { call, type Perform } from './api'
import { ConfirmDialog } from './ConfirmDialog'
import { FolderSelectionDialog } from './FolderSelectionDialog'
import type { useFavoriteFolders } from './FavoritesPanel'
import './saved-groups.css'

export function SavedGroupsView({
  accountId,
  kind,
  header,
  busy,
  perform,
  favoriteFolders
}: {
  accountId: string | null
  kind: SavedGroupKind
  header: ReactNode
  busy: boolean
  perform: Perform
  favoriteFolders?: ReturnType<typeof useFavoriteFolders>
}) {
  const [library, setLibrary] = useState<SavedGroupLibrary | null>(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [shown, setShown] = useState(100)
  const [selected, setSelected] = useState(new Set<string>())
  const [confirm, setConfirm] = useState<string[] | null>(null)
  const [working, setWorking] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [foldersOpen, setFoldersOpen] = useState(false)
  const [excludedFolderIds, setExcludedFolderIds] = useState<string[]>([])
  const [protectedIds, setProtectedIds] = useState(new Set<string>())
  const seq = useRef(0)
  const label = groupLabels[kind]
  const recommendation = kind === 'recommend'
  const actionLabel = recommendation ? '取消推荐' : `取消${label}收藏`
  const listLabel = recommendation ? '推荐视频列表' : `收藏${label}列表`
  useEffect(() => {
    if (!accountId) return
    let live = true,
      loading = false
    const refresh = async () => {
      if (loading) return
      loading = true
      const token = ++seq.current
      try {
        const value = await call(window.mylike.invoke('savedGroupsList', { accountId, kind }))
        if (live && seq.current === token) {
          setLibrary(value)
        }
      } catch (error) {
        if (live) setError(error instanceof Error ? error.message : '列表读取失败。')
      } finally {
        loading = false
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 750)
    return () => {
      live = false
      seq.current++
      clearInterval(timer)
    }
  }, [accountId, kind])
  const items = (library?.items ?? []).filter(
    (item) =>
      !search || `${item.title}\n${item.author}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())
  )
  const task = library?.task
  const eligible = items.filter((item) => !protectedIds.has(item.id))
  const running = task?.status === 'running'
  const disabled = busy || working || !!running
  return (
    <div className="panel-scroll saved-groups-view">
      {header}
      <section
        className="saved-groups-toolbar"
        aria-label={recommendation ? '推荐视频操作' : `收藏${label}操作`}
      >
        <div>
          <strong>
            本地已同步 {library?.items.length ?? 0} 个{label}
          </strong>
          <span>
            {library?.complete ? '已读到网页接口末尾 · 账号完整性未确认' : '尚未读到接口末尾，可继续读取'}
          </span>
          {!!library?.unavailableCount && (
            <span>本轮平台明确标记 {library.unavailableCount} 条记录不可见，未列入可操作视频。</span>
          )}
          <span>取消后再次扫描不会找回已取消的内容；无效记录与网页未返回的内容无法在这里批量操作。</span>
        </div>
        <div className="panel-actions">
          <input
            type="search"
            aria-label={recommendation ? '搜索推荐视频' : `搜索收藏${label}`}
            placeholder={`搜索${label}名称或作者`}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setShown(100)
              setSelected(new Set())
            }}
          />
          <button
            disabled={!accountId || disabled}
            onClick={() =>
              accountId &&
              void perform(`同步收藏${label}`, async () => {
                const next = await call(window.mylike.invoke('savedGroupsSync', { accountId, kind }))
                setLibrary(next)
                setSelected(new Set())
                setExcludedFolderIds([])
                setProtectedIds(new Set())
              })
            }
          >
            {library?.complete ? '重新同步' : '读取 / 继续同步'}
          </button>
          <button
            disabled={!running || stopping}
            onClick={async () => {
              if (!accountId) return
              setStopping(true)
              try {
                await call(window.mylike.invoke('savedGroupsStop', { accountId }))
              } catch (error) {
                setError((error as Error).message)
              } finally {
                setStopping(false)
              }
            }}
          >
            {stopping ? '正在停止…' : '停止任务'}
          </button>
        </div>
      </section>
      {error && (
        <p role="alert" className="task-error">
          {error}
        </p>
      )}
      {task && (
        <section className="saved-groups-task" aria-label={`${label}任务`} role="status">
          <strong>
            {task.mode === 'sync' ? '同步列表' : recommendation ? '取消推荐' : '取消收藏'} ·{' '}
            {task.status === 'running'
              ? '进行中'
              : task.status === 'completed'
                ? '已完成'
                : task.status === 'paused'
                  ? '已暂停'
                  : '已停止'}
          </strong>
          <span>
            {task.mode === 'sync'
              ? `本轮读到 ${task.received} 个`
              : `成功 ${task.success} · 待处理 ${task.pending} · 结果待核对 ${task.unknown}`}
          </span>
          {task.reason && <small>{task.reason}</small>}
          {!!task.unknown && <small>请重新同步完整列表核对结果；不会自动重发取消请求。</small>}
        </section>
      )}
      <div className="batch-bar" aria-label={`${label}批量选择`}>
        <strong>
          已选 {selected.size} 个{label}
        </strong>
        <button
          disabled={disabled || !items.length}
          onClick={() => setSelected(new Set(eligible.slice(0, MAX_BATCH_SIZE).map((item) => item.id)))}
        >
          {items.length > MAX_BATCH_SIZE ? `选择前 ${MAX_BATCH_SIZE} 个` : '全选筛选结果'}
        </button>
        <button
          disabled={disabled || !items.length}
          onClick={() =>
            setSelected(new Set(eligible.filter((item) => !selected.has(item.id)).map((item) => item.id)))
          }
        >
          反选
        </button>
        <button
          disabled={disabled || (!selected.size && !excludedFolderIds.length)}
          onClick={() => {
            setSelected(new Set())
            setExcludedFolderIds([])
            setProtectedIds(new Set())
          }}
        >
          清空选择
        </button>
        {recommendation && favoriteFolders && (
          <button disabled={disabled || !accountId} onClick={() => setFoldersOpen(true)}>
            按收藏夹选择
          </button>
        )}
        {!!excludedFolderIds.length && <span>已保留 {excludedFolderIds.length} 个收藏夹的视频</span>}
        <button
          className="danger-button"
          disabled={disabled || !selected.size || selected.size > MAX_BATCH_SIZE}
          onClick={() => setConfirm([...selected])}
        >
          {recommendation ? '取消所选推荐' : `取消所选${label}收藏`}
        </button>
        {selected.size > MAX_BATCH_SIZE && <span>一次最多 {MAX_BATCH_SIZE} 个，请缩小选择范围。</span>}
      </div>
      {!accountId ? (
        <p>请先选择抖音账号。</p>
      ) : !library && !error ? (
        <p role="status">正在读取本地列表…</p>
      ) : !items.length ? (
        <p className="saved-groups-empty">
          {search
            ? '没有匹配的内容。'
            : library?.complete
              ? recommendation
                ? '网页接口未返回可操作的推荐视频；不能据此确认账号推荐已清空。'
                : `平台未返回已收藏的${label}。`
              : `点击“读取 / 继续同步”，获取你${recommendation ? '推荐的视频' : `收藏的${label}`}。`}
        </p>
      ) : (
        <div className="saved-groups-list" aria-label={listLabel}>
          {items.slice(0, shown).map((item) => (
            <label key={item.id} className="saved-group-row">
              <input
                type="checkbox"
                aria-label={`选择${label} ${item.title}`}
                disabled={disabled || protectedIds.has(item.id)}
                checked={selected.has(item.id)}
                onChange={() =>
                  setSelected((old) => {
                    const next = new Set(old)
                    if (next.has(item.id)) next.delete(item.id)
                    else next.add(item.id)
                    return next
                  })
                }
              />
              <div>
                <strong>{item.title}</strong>
                <small>
                  {item.author || '作者未返回'}
                  {item.episodes ? ` · 已更新 ${item.episodes} 集` : ''}
                </small>
              </div>
              <span>{label}</span>
            </label>
          ))}
          {items.length > shown && (
            <button onClick={() => setShown((old) => old + 100)}>
              显示更多（已显示 {shown} / {items.length} 条）
            </button>
          )}
        </div>
      )}
      {foldersOpen && favoriteFolders && (
        <FolderSelectionDialog
          {...favoriteFolders}
          selected={excludedFolderIds}
          close={() => setFoldersOpen(false)}
          apply={async (folderIds, mode) => {
            if (!accountId) return
            const members = new Set(
              await call(window.mylike.invoke('favoriteProtectedIds', { accountId, folderIds }))
            )
            if (mode === 'include') {
              setExcludedFolderIds([])
              setProtectedIds(new Set())
              setSelected(
                new Set(
                  items
                    .filter((item) => members.has(item.id))
                    .slice(0, MAX_BATCH_SIZE)
                    .map((item) => item.id)
                )
              )
            } else {
              setExcludedFolderIds(folderIds)
              setProtectedIds(members)
              setSelected((old) => new Set([...old].filter((id) => !members.has(id))))
            }
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={actionLabel}
          busy={working}
          cancel={() => setConfirm(null)}
          confirmLabel={
            recommendation ? `确认取消 ${confirm.length} 条推荐` : `确认取消 ${confirm.length} 个${label}收藏`
          }
          confirm={() => {
            if (!accountId) return
            setWorking(true)
            setError('')
            void call(
              window.mylike.invoke('savedGroupsRemove', {
                accountId,
                kind,
                ids: confirm,
                excludedFolderIds: recommendation ? excludedFolderIds : undefined
              })
            )
              .then(
                (next) => {
                  setLibrary(next)
                  setSelected(new Set())
                  setConfirm(null)
                },
                (error) => setError(error.message)
              )
              .finally(() => setWorking(false))
          }}
        >
          {recommendation ? (
            <>
              <p>将取消 {confirm.length} 条视频的推荐。</p>
              <p>仅修改推荐状态，视频的喜欢、收藏及收藏夹归属保留。</p>
            </>
          ) : (
            <>
              <p>
                将取消 {confirm.length} 个完整{label}的收藏。
              </p>
              <p>这会修改抖音账号的{label}收藏状态。单条视频的喜欢、收藏及收藏夹归属不会因此删除。</p>
            </>
          )}
          {!!excludedFolderIds.length && <p>已排除 {excludedFolderIds.length} 个保留收藏夹的视频。</p>}
          <p>可停止后续未发送项；结果不明确时会保留记录，等待重新同步核对。</p>
          {error && (
            <p className="task-error" role="alert">
              {error}
            </p>
          )}
        </ConfirmDialog>
      )}
    </div>
  )
}
