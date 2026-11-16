import { useEffect, useRef, useState } from 'react'
import type { FavoriteFolder } from '../../shared/contracts'
import './folder-exclusion.css'

export function FolderSelectionDialog({
  folders,
  loaded,
  error,
  selected,
  apply,
  close
}: {
  folders: FavoriteFolder[]
  loaded: boolean
  error: string
  selected: string[]
  apply: (ids: string[], mode: 'include' | 'exclude') => Promise<void>
  close: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [chosen, setChosen] = useState(new Set(selected))
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  const submit = async (mode: 'include' | 'exclude') => {
    setBusy(true)
    setFailure('')
    try {
      await apply([...chosen], mode)
      close()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '选择失败，请重试。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <dialog
      ref={ref}
      className="modal folder-exclusion-dialog"
      aria-label="按收藏夹选择视频"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) close()
      }}
    >
      <h2>按收藏夹选择视频</h2>
      <p>
        勾选收藏夹后，可选择夹内的视频，或从当前选择中排除夹内视频。多个夹按视频去重，只操作当前列表及搜索范围内的内容。
      </p>
      <p className="folder-exclusion-hint">
        数量为已同步 / 抖音显示。请先完成收藏与收藏夹同步；选择只改变勾选状态，确认取消后才会修改抖音。
      </p>
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
      {!loaded && <p role="status">正在读取收藏夹…</p>}
      {loaded && !error && !folders.length && <p>暂无已同步的收藏夹，请先在收藏页点击“向下采集”。</p>}
      <div className="folder-exclusion-list" aria-label="可选收藏夹">
        {folders.map((folder) => (
          <label key={folder.id} className="folder-exclusion-row">
            <input
              type="checkbox"
              aria-label={`选择收藏夹 ${folder.title}`}
              checked={chosen.has(folder.id)}
              disabled={busy}
              onChange={() =>
                setChosen((old) => {
                  const next = new Set(old)
                  if (next.has(folder.id)) next.delete(folder.id)
                  else next.add(folder.id)
                  return next
                })
              }
            />
            <span>{folder.title}</span>
            <small>
              {folder.localCount} / {folder.remoteCount}
            </small>
          </label>
        ))}
      </div>
      {(error || failure) && (
        <p role="alert" className="task-error">
          {error || failure}
        </p>
      )}
      <div className="panel-actions">
        <button autoFocus disabled={busy} onClick={close}>
          取消
        </button>
        <button disabled={busy || !loaded || !!error || !chosen.size} onClick={() => void submit('include')}>
          选择夹内视频（{chosen.size} 个夹）
        </button>
        <button
          className="primary"
          disabled={busy || !loaded || !!error}
          onClick={() => void submit('exclude')}
        >
          排除夹内视频（{chosen.size} 个夹）
        </button>
      </div>
    </dialog>
  )
}
