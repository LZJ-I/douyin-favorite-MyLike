import { expect, it, vi } from 'vitest'
import { ScanIdentity } from '../../src/main/scan-identity'
import { collectionPolicy, scanPolicy, scanNeedsRecycle } from '../../src/main/collection-policy'
import { appPreferencesSchema, appPreferencesPatchSchema } from '../../src/shared/preferences'
import type { Account } from '../../src/shared/contracts'

const account = (id: string) => ({ id, remoteId: 'remote-' + id }) as Account

it('reuses identity for 100 hidden read pages, then renews after the lease expires', async () => {
  let now = 0
  const identify = vi.fn(async (id: string) => account(id))
  const lease = new ScanIdentity(
    identify,
    (id) => id + ':document-1',
    60000,
    () => now
  )
  for (let i = 0; i < 100; i++) {
    expect((await lease.get('a', () => {})).remoteId).toBe('remote-a')
    lease.assertCurrent('a')
    now += 350
  }
  expect(identify).toHaveBeenCalledTimes(1)
  now = 60000
  await lease.get('a', () => {})
  expect(identify).toHaveBeenCalledTimes(2)
})

it('never shares a lease between accounts, visible login windows, navigation or restarted scans', async () => {
  let document = 'one'
  let visible = false
  const identify = vi.fn(async (id: string) => account(id))
  const lease = new ScanIdentity(identify, (id) => (visible ? null : id + document))
  await lease.get('a', () => {})
  await lease.get('b', () => {})
  document = 'two'
  await lease.get('b', () => {})
  visible = true
  await lease.get('b', () => {})
  await lease.get('b', () => {})
  visible = false
  lease.invalidate()
  await lease.get('b', () => {})
  expect(identify).toHaveBeenCalledTimes(6)
})

it('rejects a page if its account document changes during the request', async () => {
  let key: string | null = 'a:one'
  const lease = new ScanIdentity(
    async (id) => account(id),
    () => key
  )
  await lease.get('a', () => {})
  key = 'a:two'
  expect(() => lease.assertCurrent('a')).toThrow('当前页未保存')
  await lease.get('a', () => {})
  key = null
  expect(() => lease.assertCurrent('a')).toThrow('当前页未保存')
})

it('does not cache failed verification or accept a document change during verification', async () => {
  let key = 'one'
  const identify = vi.fn(async (id: string) => {
    if (identify.mock.calls.length === 1) throw new Error('AUTH_REQUIRED')
    return account(id)
  })
  const lease = new ScanIdentity(identify, () => key)
  await expect(lease.get('a', () => {})).rejects.toThrow('AUTH_REQUIRED')
  await lease.get('a', () => {})
  expect(identify).toHaveBeenCalledTimes(2)
  lease.invalidate()
  identify.mockImplementationOnce(async (id) => {
    key = 'two'
    return account(id)
  })
  await expect(lease.get('a', () => {})).rejects.toThrow('扫描会话已变化')
})

it('checks cancellation even when reusing an identity', async () => {
  const identify = vi.fn(async (id: string) => account(id))
  const lease = new ScanIdentity(identify, () => 'same')
  await lease.get('a', () => {})
  await expect(
    lease.get('a', () => {
      throw new Error('CANCELLED')
    })
  ).rejects.toThrow('CANCELLED')
  expect(identify).toHaveBeenCalledTimes(1)
})

it('keeps standard cadence and recycles fast scans on time or memory instead of every 24 pages', () => {
  const normal = scanPolicy(collectionPolicy, 'normal')
  const fast = scanPolicy(collectionPolicy, 'fast')
  expect(normal).toEqual(collectionPolicy)
  expect(fast.interval).toBe(350)
  expect(scanNeedsRecycle(normal, 24, 10000)).toBe(true)
  expect(scanNeedsRecycle(fast, 24, 10000, 200)).toBe(false)
  expect(scanNeedsRecycle(fast, 200, 600000, 200)).toBe(true)
  expect(scanNeedsRecycle(fast, 32, 10000, 512)).toBe(true)
  expect(fast.retry).toBe(normal.retry)
})

it('upgrades existing preferences to fast mode and persists a standard-mode override', () => {
  expect(appPreferencesSchema.parse({ libraryMode: 'scroll' })).toMatchObject({
    libraryMode: 'scroll',
    scanMode: 'fast'
  })
  expect(appPreferencesPatchSchema.parse({ scanMode: 'normal' })).toEqual({ scanMode: 'normal' })
  expect(appPreferencesSchema.parse({ scanMode: 'normal' }).scanMode).toBe('normal')
})
