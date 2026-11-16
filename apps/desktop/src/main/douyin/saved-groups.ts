import type { SavedGroup, SavedGroupKind } from '../../shared/saved-groups'
import { AppError } from '../errors'
import { numericId, safeMediaUrl, parseWork } from './parse'
import { assertBusinessResponse } from './response-policy'
import { groupLabels } from '../../shared/saved-groups'

export function assertSavedGroupRemoval(data: Record<string, any>, kind: SavedGroupKind) {
  assertBusinessResponse(data, {
    operation: kind === 'recommend' ? 'recommendRemove' : kind === 'mix' ? 'mixRemove' : 'seriesRemove'
  })
  if (String(data.status_code) !== '0' || data.second_verify_type)
    throw new AppError('UNKNOWN_RESULT', '平台未明确确认取消结果，请同步完整列表核对；未自动重发。')
  for (const key of ['fatal_ids', 'unprocessed_ids']) {
    if (data[key] != null && !Array.isArray(data[key]))
      throw new AppError('UNKNOWN_RESULT', '取消结果结构不明确，未自动重发。')
    if (data[key]?.length)
      throw new AppError('API_REJECTED', '平台返回取消失败或未处理，已保留本地记录并暂停。')
  }
}

export function parseSavedGroups(data: Record<string, any>, kind: SavedGroupKind) {
  const label = groupLabels[kind]
  assertBusinessResponse(data, {
    operation: kind === 'recommend' ? 'recommendations' : kind === 'mix' ? 'savedMixes' : 'savedSeries'
  })
  const field = kind === 'recommend' ? 'aweme_list' : kind === 'mix' ? 'mix_infos' : 'series_infos'
  const raw = data[field]
  if (![true, false, 0, 1, '0', '1'].includes(data.has_more))
    throw new AppError('UPSTREAM_CHANGED', `${label}列表结构不明确，已保留现有列表和断点。`)
  const hasMore = [true, 1, '1'].includes(data.has_more)
  // Recommendation pages can contain only explicitly unavailable records.
  // They are gaps in the feed, not an end marker or a missing response.
  let unavailableCount = 0
  if (
    kind === 'recommend' &&
    String(data.status_code) === '0' &&
    raw === null &&
    Number.isSafeInteger(data.invalid_item_count) &&
    data.invalid_item_count > 0 &&
    Array.isArray(data.invalid_item_id_list) &&
    data.invalid_item_id_list.length === data.invalid_item_count
  ) {
    const ids = data.invalid_item_id_list.map(numericId)
    if (new Set(ids).size === ids.length) unavailableCount = ids.length
  }
  const list = Array.isArray(raw)
    ? raw
    : unavailableCount ||
        (raw == null && Object.hasOwn(data, field) && !hasMore && String(data.status_code) === '0')
      ? []
      : null
  if (!list) throw new AppError('UPSTREAM_CHANGED', `${label}列表结构不明确，已保留现有列表和断点。`)
  const cursor = numericId(
    (kind === 'recommend' ? data.max_cursor : data.cursor) ?? (hasMore ? undefined : '0')
  )
  if (hasMore && /^0+$/.test(cursor))
    throw new AppError('CURSOR_STALLED', `仍有更多${label}但游标归零，已保留断点。`)
  const items: SavedGroup[] = list.map((entry: any) => {
    if (kind === 'recommend') {
      const work = parseWork(entry)
      return {
        id: work.id,
        kind,
        title: work.title || `视频 ${work.id}`,
        author: work.author,
        coverUrl: work.coverUrl,
        episodes: 0
      }
    }
    if (!entry || typeof entry !== 'object') throw new AppError('UPSTREAM_CHANGED', '合集或短剧条目无效。')
    const id = numericId(kind === 'mix' ? entry.mix_id : entry.series_id)
    const title = kind === 'mix' ? entry.mix_name : entry.series_name
    if (typeof title !== 'string' || !title.trim())
      throw new AppError('UPSTREAM_CHANGED', '合集或短剧缺少名称，未跳过条目。')
    const stats = kind === 'mix' ? entry.statis : entry.stats
    return {
      id,
      kind,
      title: title.slice(0, 1000),
      author: typeof entry.author?.nickname === 'string' ? entry.author.nickname.slice(0, 500) : '',
      coverUrl: safeMediaUrl(entry.cover_url?.url_list?.[0] ?? entry.cover?.url_list?.[0]),
      episodes: Number.isSafeInteger(stats?.updated_to_episode) ? Math.max(0, stats.updated_to_episode) : 0
    }
  })
  return { items, cursor, hasMore, unavailableCount }
}
