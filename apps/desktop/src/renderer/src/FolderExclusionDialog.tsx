import { useEffect, useRef, useState } from 'react'
import type { FavoriteFolder } from '../../shared/contracts'
import './folder-exclusion.css'

export function FolderExclusionDialog({
  folders,
  loaded,
  error,
  selected,
  selecting,
  apply,
  close
}: {
  folders: FavoriteFolder[]
  loaded: boolean
  error: string
  selected: string[]
  selecting: boolean
  apply: (ids: string[]) => Promise<void>
  close: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [chosen, setChosen] = useState(new Set(selected))
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  const toggle = (id: string) =>
    setChosen((old) => {
      const next = new Set(old)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  return (
    <dialog
      ref={ref}
      className="modal folder-exclusion-dialog"
      aria-label={selecting ? '排除收藏夹' : '当前收藏夹'}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) close()
      }}
    >
      <h2>{selecting ? '选择要保留的收藏夹' : '当前收藏夹'}</h2>
      <p>
        {selecting
          ? '勾选的收藏夹会被保留。属于其中任意一个夹的作品都会从当前选择中排除，再次全选时也会跳过。'
          : '以下是当前账号已同步的收藏夹。进入“批量选择”后，可以按收藏夹排除要保留的作品。'}
      </p>
      <p className="folder-exclusion-hint">
        数量为已同步 / 抖音显示。排除前请完成“向下采集”；在抖音修改收藏夹后，请重新同步。
      </p>
      {selecting && (
        <div className="folder-exclusion-actions">
          <button
            disabled={busy || !loaded || !!error}
            onClick={() => setChosen(new Set(folders.map((f) => f.id)))}
          >
            全选收藏夹
          </button>
          <button
            disabled={busy || !loaded || !!error}
            onClick={() => setChosen(new Set(folders.filter((f) => !chosen.has(f.id)).map((f) => f.id)))}
          >
            反选收藏夹
          </button>
          <button disabled={busy} onClick={() => setChosen(new Set())}>
            清空勾选
          </button>
        </div>
      )}
      {!loaded && <p role="status">正在读取收藏夹…</p>}
      {loaded && !error && !folders.length && <p>尚无已同步的收藏夹，请先在收藏页点击“向下采集”。</p>}
      <div className="folder-exclusion-list" aria-label="当前收藏夹列表">
        {folders.map((folder) => (
          <label key={folder.id} className="folder-exclusion-row">
            {selecting && (
              <input
                type="checkbox"
                aria-label={`保留 ${folder.title}`}
                checked={chosen.has(folder.id)}
                disabled={busy}
                onChange={() => toggle(folder.id)}
              />
            )}
            <span>{folder.title}</span>
            <small>
              {folder.localCount} / {folder.remoteCount}
            </small>
          </label>
        ))}
      </div>
      {(error || failure) && (
        <p className="task-error" role="alert">
          {error || failure}
        </p>
      )}
      <div className="panel-actions">
        <button autoFocus disabled={busy} onClick={close}>
          {selecting ? '取消' : '完成'}
        </button>
        {selecting && (
          <button
            className="primary"
            disabled={busy || !loaded || !!error}
            onClick={async () => {
              setBusy(true)
              setFailure('')
              try {
                await apply([...chosen])
                close()
              } catch (error) {
                setFailure(error instanceof Error ? error.message : '排除失败，请重试。')
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? '正在排除…' : `应用排除（${chosen.size} 个夹）`}
          </button>
        )}
      </div>
    </dialog>
  )
}
