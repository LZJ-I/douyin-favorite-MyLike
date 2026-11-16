export type SavedGroupKind = 'mix' | 'series' | 'recommend'
export interface SavedGroup {
  id: string
  kind: SavedGroupKind
  title: string
  author: string
  coverUrl: string | null
  episodes: number
}
export interface SavedGroupTask {
  id: string
  kind: SavedGroupKind
  mode: 'sync' | 'remove'
  status: 'running' | 'stopped' | 'completed' | 'paused'
  received: number
  success: number
  pending: number
  unknown: number
  reason: string | null
}
export interface SavedGroupLibrary {
  items: SavedGroup[]
  task: SavedGroupTask | null
  complete: boolean
  cursor: string
}
export const groupLabels = { mix: '合集', series: '短剧', recommend: '推荐视频' } as const
