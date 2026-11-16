import { AppError } from '../errors'
import { assertBusinessResponse } from './response-policy'
import { numericId } from './parse'

export function parseUnlikeBatchResult(data: Record<string, any>, ids: string[]): Set<string> {
  assertBusinessResponse(data, { operation: 'unlikeBatch' })
  if (String(data.status_code) !== '0' || data.second_verify_type)
    throw new AppError('UNKNOWN_RESULT', '平台没有明确确认本批结果，未自动重发。')
  const failed = new Set<string>()
  for (const field of ['fatal_ids', 'unprocessed_ids']) {
    const raw = data[field]
    if (raw == null) continue
    if (!Array.isArray(raw)) throw new AppError('UNKNOWN_RESULT', '批量结果结构不明确，未自动重发。')
    for (const value of raw) {
      const id = numericId(value)
      if (!ids.includes(id)) throw new AppError('UNKNOWN_RESULT', '批量响应包含其他目标，未确认本批结果。')
      failed.add(id)
    }
  }
  return failed
}
