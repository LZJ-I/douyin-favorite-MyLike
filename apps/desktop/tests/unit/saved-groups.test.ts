import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { Store } from '../../src/main/storage/database'
import type { Database } from '../../src/main/storage/client'
import { SavedGroupsService } from '../../src/main/saved-groups'
import { parseSavedGroups, assertSavedGroupRemoval } from '../../src/main/douyin/saved-groups'
import { buildPageScript, isWriteOperation, type Operation } from '../../src/main/douyin/page-request'
import { AppError } from '../../src/main/errors'
import type { SavedGroup, SavedGroupKind } from '../../src/shared/saved-groups'

const roots: string[] = [],
  stores = new Set<Store>()
const scope = { accountId: 'a', remoteId: 'remote-a' }
const item = (id: string, kind: SavedGroupKind = 'mix'): SavedGroup => ({
  id,
  kind,
  title: `收藏 ${id}`,
  author: '作者',
  coverUrl: null,
  episodes: 8
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mylike-groups-'))
  roots.push(root)
  const file = join(root, 'db.sqlite'),
    store = new Store(file)
  stores.add(store)
  for (const id of ['a', 'b']) {
    store.call('createAccount', { id, name: id })
    store.call('bindAccount', { accountId: id, remoteId: `remote-${id}`, nickname: id, avatarUrl: null })
  }
  return { store, file }
}
function seed(
  store: Store,
  kind: SavedGroupKind = 'mix',
  ids = ['9007199254740993999', '2'],
  accountId = 'a'
) {
  const taskId = `seed-${kind}-${accountId}`
  store.call('savedGroupsBegin', { accountId, remoteId: `remote-${accountId}`, taskId, kind, mode: 'sync' })
  store.call('savedGroupsPage', {
    accountId,
    remoteId: `remote-${accountId}`,
    taskId,
    requestCursor: '0',
    cursor: '0',
    hasMore: false,
    items: ids.map((id) => item(id, kind))
  })
  store.call('savedGroupsFinish', { accountId, taskId, status: 'completed', reason: null })
}
const library = (store: Store, kind: SavedGroupKind = 'mix', accountId = 'a') =>
  store.call('savedGroupsList', { accountId, kind })
afterEach(() => {
  for (const store of stores) store.call('close', undefined)
  stores.clear()
  for (const root of roots.splice(0)) {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()))
    expect(basename(root)).toMatch(/^mylike-groups-/)
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

for (const kind of ['mix', 'series'] as const) {
  const field = kind === 'mix' ? 'mix_infos' : 'series_infos'
  it(`parses ${kind} names, safe covers and lossless identifiers, refusing ambiguous terminal pages`, () => {
    const row = {
      [kind + '_id']: '9007199254740993999',
      [kind + '_name']: '测试',
      author: { nickname: '作者' },
      cover_url: { url_list: ['javascript:bad'] },
      [kind === 'mix' ? 'statis' : 'stats']: { updated_to_episode: 12 }
    }
    expect(
      parseSavedGroups({ status_code: 0, [field]: [row], has_more: 1, cursor: '9007199254740993998' }, kind)
    ).toMatchObject({
      cursor: '9007199254740993998',
      hasMore: true,
      items: [{ id: '9007199254740993999', kind, title: '测试', episodes: 12, coverUrl: null }]
    })
    expect(parseSavedGroups({ status_code: 0, [field]: null, has_more: 0, cursor: 0 }, kind).items).toEqual(
      []
    )
    for (const data of [
      { status_code: 0 },
      { status_code: 0, has_more: 0 },
      { status_code: 0, [field]: [], has_more: 'maybe' },
      { status_code: 0, [field]: [row], has_more: 1, cursor: '0' },
      { status_code: 0, [field]: [{ ...row, [kind + '_name']: '' }], has_more: 0 },
      { status_code: 0, [field]: [{ ...row, [kind + '_id']: Number.MAX_SAFE_INTEGER + 1 }], has_more: 0 },
      { status_code: 8, [field]: [], has_more: 0 }
    ])
      expect(() => parseSavedGroups(data, kind)).toThrow()
  })
  it(`builds explicit ${kind} cancellation POSTs with only the appropriate group identifiers`, async () => {
    let request: { url: URL; options: RequestInit } | null = null
    const operation = kind === 'mix' ? 'mixRemove' : 'seriesRemove'
    const key = kind + '_ids'
    const context = {
      URLSearchParams,
      AbortController,
      Map,
      setTimeout,
      clearTimeout,
      fetch: async (url: string, options: RequestInit) => {
        request = { url: new URL(url), options }
        return { status: 200, headers: new Headers(), text: async () => '{"status_code":0,"fatal_ids":[]}' }
      }
    }
    await runInNewContext(
      buildPageScript({ id: kind, operation, parameters: { [key]: '9007199254740993999' }, timeout: 1000 }),
      context
    )
    expect(isWriteOperation(operation)).toBe(true)
    expect(request!.url.pathname).toBe(`/aweme/v1/web/${kind}/cancel/collect/multi/`)
    expect(request!.options.method).toBe('POST')
    expect(request!.options.credentials).toBe('include')
    expect(Object.fromEntries(new URLSearchParams(String(request!.options.body)))).toEqual({
      [key]: '9007199254740993999'
    })
    expect(request!.url.searchParams.has(key)).toBe(false)
    expect(request!.url.searchParams.has('aweme_id')).toBe(false)
    expect(() =>
      assertSavedGroupRemoval({ status_code: 0, fatal_ids: ['9007199254740993999'] }, kind)
    ).toThrow('取消失败')
    expect(() => assertSavedGroupRemoval({ status_code: 0, fatal_ids: 'bad' }, kind)).toThrow('不明确')
    expect(() => assertSavedGroupRemoval({}, kind)).toThrow('未明确')
    expect(() => assertSavedGroupRemoval({ status_code: 0, second_verify_type: 'challenge' }, kind)).toThrow()
    expect(() => assertSavedGroupRemoval({ status_code: 0, fatal_ids: [] }, kind)).not.toThrow()
  })
}

it('resumes an interrupted scan without pruning until a trusted end, scoped to account and kind', () => {
  const { store } = setup()
  seed(store)
  seed(store, 'series')
  seed(store, 'mix', ['77'], 'b')
  store.call('savedGroupsBegin', { ...scope, taskId: 'scan', kind: 'mix', mode: 'sync' })
  store.call('savedGroupsPage', {
    ...scope,
    taskId: 'scan',
    requestCursor: '0',
    cursor: '9',
    hasMore: true,
    items: [item('3')]
  })
  expect(library(store).items).toHaveLength(3)
  store.call('savedGroupsFinish', { accountId: 'a', taskId: 'scan', status: 'stopped', reason: null })
  expect(
    store.call('savedGroupsBegin', { ...scope, taskId: 'resume', kind: 'mix', mode: 'sync' }).cursor
  ).toBe('9')
  expect(() =>
    store.call('savedGroupsPage', {
      ...scope,
      taskId: 'scan',
      requestCursor: '9',
      cursor: '0',
      hasMore: false,
      items: []
    })
  ).toThrow('已变化')
  expect(() =>
    store.call('savedGroupsPage', {
      ...scope,
      taskId: 'resume',
      requestCursor: '0',
      cursor: '0',
      hasMore: false,
      items: []
    })
  ).toThrow('断点已变化')
  expect(() =>
    store.call('savedGroupsPage', {
      ...scope,
      remoteId: 'remote-b',
      taskId: 'resume',
      requestCursor: '9',
      cursor: '0',
      hasMore: false,
      items: []
    })
  ).toThrow('不匹配')
  store.call('savedGroupsPage', {
    ...scope,
    taskId: 'resume',
    requestCursor: '9',
    cursor: '0',
    hasMore: false,
    items: [item('4')]
  })
  expect(library(store).items.map((i) => i.id)).toEqual(['3', '4'])
  expect(library(store).complete).toBe(true)
  expect(library(store, 'series').items).toHaveLength(2)
  expect(library(store, 'mix', 'b').items.map((i) => i.id)).toEqual(['77'])
})

it('persists unknown in-flight writes on restart and requires a fresh complete scan before a user retry', () => {
  const { store, file } = setup()
  seed(store)
  // Leave an incomplete scan, then a write whose response was lost.
  store.call('savedGroupsBegin', { ...scope, taskId: 'old', kind: 'mix', mode: 'sync' })
  store.call('savedGroupsPage', {
    ...scope,
    taskId: 'old',
    requestCursor: '0',
    cursor: '9',
    hasMore: true,
    items: [item('2')]
  })
  store.call('savedGroupsBegin', { ...scope, taskId: 'remove', kind: 'mix', mode: 'remove', ids: ['2'] })
  store.call('savedGroupsWrite', { accountId: 'a', taskId: 'remove', id: '2', status: 'sending' })
  store.call('close', undefined)
  stores.delete(store)
  const reopened = new Store(file)
  stores.add(reopened)
  expect(library(reopened).task).toMatchObject({ status: 'stopped', unknown: 1, pending: 0 })
  expect(() =>
    reopened.call('savedGroupsBegin', { ...scope, taskId: 'retry', kind: 'mix', mode: 'remove', ids: ['2'] })
  ).toThrow('结果未知')
  const scan = reopened.call('savedGroupsBegin', { ...scope, taskId: 'verify', kind: 'mix', mode: 'sync' })
  expect(scan.cursor).toBe('0')
  reopened.call('savedGroupsPage', {
    ...scope,
    taskId: 'verify',
    requestCursor: '0',
    cursor: '0',
    hasMore: false,
    items: [item('2')]
  })
  // Confirmed still present: a new explicit user task may now retry.
  expect(() =>
    reopened.call('savedGroupsBegin', { ...scope, taskId: 'retry', kind: 'mix', mode: 'remove', ids: ['2'] })
  ).not.toThrow()
})

it('removes only the acknowledged group and preserves video likes, favorites, folders and other groups', () => {
  const { store } = setup()
  seed(store)
  seed(store, 'series')
  seed(store, 'mix', ['2'], 'b')
  const work = {
    id: '2',
    title: '同编号作品',
    author: '作者',
    publishedAt: 1700000000,
    coverUrl: null,
    mediaType: 'video' as const,
    isLive: false
  }
  store.call('savePage', { ...scope, items: [work], cursor: '0', hasMore: false })
  store.call('favoriteConfirm', {
    ...scope,
    work,
    folder: { id: '8', title: '旅行', remoteCount: 1, localCount: 0 }
  })
  const before = store.call('libraryOverview', { accountId: 'a' })
  store.call('savedGroupsBegin', { ...scope, taskId: 'remove', kind: 'mix', mode: 'remove', ids: ['2', '2'] })
  expect(library(store).task?.pending).toBe(1)
  expect(() =>
    store.call('savedGroupsWrite', { accountId: 'a', taskId: 'remove', id: '2', status: 'success' })
  ).toThrow()
  store.call('savedGroupsWrite', { accountId: 'a', taskId: 'remove', id: '2', status: 'sending' })
  expect(library(store).items).toHaveLength(2)
  store.call('savedGroupsWrite', { accountId: 'a', taskId: 'remove', id: '2', status: 'success' })
  expect(library(store).items.map((i) => i.id)).toEqual(['9007199254740993999'])
  expect(library(store, 'series').items).toHaveLength(2)
  expect(library(store, 'mix', 'b').items).toHaveLength(1)
  expect(store.call('libraryOverview', { accountId: 'a' })).toEqual(before)
  expect(store.call('favoriteFolders', { accountId: 'a' })[0]?.localCount).toBe(1)
  expect(store.call('checkDatabase', {})).toMatchObject({ ok: true })
})

function serviceSetup() {
  const { store } = setup()
  const calls: { operation: Operation; parameters: Record<string, string> }[] = []
  const platform = {
    remoteId: 'remote-a',
    reply: { status_code: 0, fatal_ids: [] } as Record<string, any>,
    failure: false,
    hold: null as null | (() => Promise<void>),
    afterWrite: null as null | (() => void),
    pages: null as null | ((cursor: string) => Record<string, any>)
  }
  const cancel = vi.fn()
  const service = new SavedGroupsService(
    { call: async (method: any, input: any) => store.call(method, input) } as Database,
    {
      cancel,
      request: async (_account, operation, parameters = {}) => {
        calls.push({ operation, parameters })
        if (operation === 'savedMixes' || operation === 'savedSeries' || operation === 'recommendations') {
          if (platform.pages)
            return platform.pages(
              (operation === 'recommendations' ? parameters.max_cursor : parameters.cursor)!
            )
          return {
            status_code: 0,
            [operation === 'savedMixes' ? 'mix_infos' : 'series_infos']: [],
            has_more: 0,
            cursor: '0'
          }
        }
        await platform.hold?.()
        platform.afterWrite?.()
        if (platform.failure) throw new AppError('TIMEOUT', 'fixture timeout')
        return platform.reply
      }
    },
    async (_id, action) => action(() => {}),
    async () => ({ ...store.call('accounts', undefined)[0]!, remoteId: platform.remoteId }),
    () => {},
    { read: 0, write: 0, confirm: 0 }
  )
  const done = () => vi.waitFor(() => expect(service.running).toBe(false))
  return { store, service, platform, calls, cancel, done }
}

it('confirms the terminal page twice and pauses ambiguous pages without pruning', async () => {
  const { store, service, platform, calls, done } = serviceSetup()
  seed(store)
  platform.pages = (cursor) => ({
    status_code: 0,
    mix_infos: [{ mix_id: cursor === '0' ? '3' : '4', mix_name: '新合集' }],
    has_more: cursor === '0' ? 1 : 0,
    cursor: cursor === '0' ? '9' : '0'
  })
  await service.start('a', 'mix', 'sync')
  await done()
  expect(calls.map((c) => c.parameters.cursor)).toEqual(['0', '9', '9'])
  expect(library(store).items.map((i) => i.id)).toEqual(['3', '4'])
  platform.pages = () => ({ status_code: 0 })
  await service.start('a', 'mix', 'sync')
  await done()
  expect(library(store).items).toHaveLength(2)
  expect(library(store).complete).toBe(false)
  expect(library(store).task?.status).toBe('paused')
})

it('parses recommendation feeds with max_cursor and exact video identifiers, refusing withheld or malformed lists', () => {
  const data = {
    status_code: 0,
    aweme_list: [
      {
        aweme_id: '9007199254740993999',
        desc: '我推荐的视频',
        author: { nickname: '作者' },
        video: { cover: { url_list: ['https://fixture.douyinpic.com/a.jpg'] } }
      }
    ],
    has_more: 1,
    max_cursor: '9007199254740993998'
  }
  expect(parseSavedGroups(data, 'recommend')).toMatchObject({
    cursor: '9007199254740993998',
    hasMore: true,
    items: [
      {
        kind: 'recommend',
        id: '9007199254740993999',
        title: '我推荐的视频',
        coverUrl: 'https://fixture.douyinpic.com/a.jpg'
      }
    ]
  })
  for (const invalid of [
    { status_code: 0 },
    { ...data, max_cursor: undefined },
    { ...data, aweme_list: [{}] },
    { ...data, has_more: undefined }
  ])
    expect(() => parseSavedGroups(invalid, 'recommend')).toThrow()
})

it('accepts explicitly unavailable recommendation pages but rejects unexplained null lists', () => {
  const gap = {
    status_code: 0,
    aweme_list: null,
    has_more: true,
    max_cursor: 162,
    invalid_item_count: 2,
    invalid_item_id_list: ['9007199254740993999', '2']
  }
  expect(parseSavedGroups(gap, 'recommend')).toMatchObject({
    items: [],
    cursor: '162',
    hasMore: true,
    unavailableCount: 2
  })
  for (const invalid of [
    { ...gap, invalid_item_count: 0 },
    { ...gap, invalid_item_count: 3 },
    { ...gap, invalid_item_id_list: ['2', '2'] },
    { ...gap, invalid_item_id_list: ['bad', '2'] },
    { ...gap, aweme_list: undefined },
    { ...gap, status_code: undefined }
  ])
    expect(() => parseSavedGroups(invalid, 'recommend')).toThrow()
  expect(() => parseSavedGroups({ ...gap, invalid_item_id_list: undefined }, 'recommend')).toThrow(
    '推荐视频列表结构不明确'
  )
  expect(() => parseSavedGroups(gap, 'mix')).toThrow()
})

it('confirms unavailable recommendation gaps and continues to the later visible videos', async () => {
  const { store, service, platform, calls, done } = serviceSetup()
  platform.pages = (cursor) =>
    cursor === '0' || cursor === '18'
      ? {
          status_code: 0,
          aweme_list: null,
          has_more: true,
          max_cursor: cursor === '0' ? '18' : '36',
          invalid_item_count: 2,
          invalid_item_id_list: ['8', '9']
        }
      : {
          status_code: 0,
          aweme_list: [{ aweme_id: '10', desc: '后续有效推荐' }],
          has_more: false,
          max_cursor: '0'
        }
  await service.start('a', 'recommend', 'sync')
  await done()
  expect(calls.map((c) => c.parameters.max_cursor)).toEqual(['0', '0', '18', '18', '36', '36'])
  expect(library(store, 'recommend')).toMatchObject({
    complete: true,
    task: { status: 'completed' },
    items: [{ id: '10' }]
  })
  expect(calls.every((c) => c.operation === 'recommendations')).toBe(true)
})

it('preserves recommendation records and checkpoint when an unavailable gap loops', async () => {
  const { store, service, platform, done } = serviceSetup()
  seed(store, 'recommend')
  platform.pages = (cursor) => ({
    status_code: 0,
    aweme_list: null,
    has_more: true,
    max_cursor: cursor === '0' ? '18' : '0',
    invalid_item_count: 1,
    invalid_item_id_list: ['8']
  })
  await service.start('a', 'recommend', 'sync')
  await done()
  expect(library(store, 'recommend')).toMatchObject({
    complete: false,
    cursor: '18',
    task: { status: 'paused' }
  })
  expect(library(store, 'recommend').items).toHaveLength(2)
})

it('matches the public recommendation feed GET and cancellation POST without using like or favorite actions', async () => {
  const requests: { url: URL; options: RequestInit }[] = []
  const context = {
    URLSearchParams,
    AbortController,
    Map,
    setTimeout,
    clearTimeout,
    document: { cookie: 'msToken=this-session' },
    fetch: async (url: string, options: RequestInit) => {
      requests.push({ url: new URL(url), options })
      return { status: 200, headers: new Headers(), text: async () => '{"status_code":0}' }
    }
  }
  for (const [operation, parameters] of [
    [
      'recommendations',
      {
        sec_user_id: 'own-identity',
        max_cursor: '9007199254740993999',
        min_cursor: '0',
        count: '20',
        from: '1'
      }
    ],
    ['recommendRemove', { item_id: '123', sec_user_id: 'own-identity' }]
  ] as const)
    await runInNewContext(buildPageScript({ id: operation, operation, parameters, timeout: 1000 }), context)
  expect(requests[0]!.url.pathname).toBe('/aweme/v1/web/familiar/recommend/feed/')
  expect(requests[0]!.options.method).toBe('GET')
  expect(requests[0]!.url.searchParams.get('max_cursor')).toBe('9007199254740993999')
  expect(requests[0]!.url.searchParams.get('sec_user_id')).toBe('own-identity')
  expect(requests[1]!.url.pathname).toBe('/aweme/v1/web/familiar/recommend/cancel')
  expect(requests[1]!.options.method).toBe('POST')
  expect(requests[1]!.url.searchParams.get('app_name')).toBe('douyin_web')
  expect(requests.every((r) => r.url.searchParams.get('device_platform') === '')).toBe(true)
  expect(Object.fromEntries(new URLSearchParams(String(requests[1]!.options.body)))).toEqual({
    type: '2',
    item_id: '123',
    source: '0'
  })
  expect(requests[1]!.url.searchParams.has('item_id')).toBe(false)
  expect(isWriteOperation('recommendRemove')).toBe(true)
})

it('syncs recommended videos and keeps the existing likes, favorites and group lists independent', async () => {
  const { store, service, platform, calls, done } = serviceSetup()
  seed(store, 'mix')
  seed(store, 'series')
  platform.pages = (cursor) => ({
    status_code: 0,
    aweme_list: [{ aweme_id: cursor === '0' ? '1' : '2', desc: '推荐视频' }],
    has_more: cursor === '0' ? 1 : 0,
    max_cursor: cursor === '0' ? '9' : '0'
  })
  await service.start('a', 'recommend', 'sync')
  await done()
  expect(calls.map((c) => c.parameters.max_cursor)).toEqual(['0', '9', '9'])
  expect(
    calls.every((c) => c.operation === 'recommendations' && c.parameters.sec_user_id === 'remote-a')
  ).toBe(true)
  expect(library(store, 'recommend').items).toHaveLength(2)
  await service.start('a', 'recommend', 'remove', ['2'])
  await done()
  expect(calls.at(-1)).toEqual({
    operation: 'recommendRemove',
    parameters: { item_id: '2', sec_user_id: 'remote-a' }
  })
  expect(library(store, 'recommend').task).toMatchObject({ status: 'completed', success: 1 })
  expect(library(store, 'mix').items).toHaveLength(2)
  expect(library(store, 'series').items).toHaveLength(2)
})

it('does not retry an uncertain recommendation cancellation or delete its local record', async () => {
  const { store, service, platform, calls, done } = serviceSetup()
  seed(store, 'recommend')
  platform.failure = true
  await service.start('a', 'recommend', 'remove', ['2'])
  await done()
  expect(calls).toHaveLength(1)
  expect(library(store, 'recommend').task).toMatchObject({ status: 'paused', success: 0, unknown: 1 })
  expect(library(store, 'recommend').items).toHaveLength(2)
  await expect(service.start('a', 'recommend', 'remove', ['2'])).rejects.toThrow('结果未知')
})

it('rejects protected recommendation IDs and rechecks folder membership before each later cancellation', async () => {
  const { store, service, platform, calls, done } = serviceSetup()
  seed(store, 'recommend', ['1', '2', '3'])
  const work = (id: string) => ({
    id,
    title: '推荐视频 ' + id,
    author: '作者',
    publishedAt: 1700000000,
    coverUrl: null,
    mediaType: 'video' as const,
    isLive: false
  })
  let task = store.call('favoritesStart', { accountId: 'a', id: 'folders' })
  task = store.call('favoritesSave', {
    ...scope,
    taskId: task.id,
    stage: task.stage,
    folderId: task.folderId,
    requestCursor: task.cursor,
    cursor: '0',
    hasMore: false,
    items: ['1', '2', '3'].map(work)
  })
  task = store.call('favoritesSave', {
    ...scope,
    taskId: task.id,
    stage: task.stage,
    folderId: task.folderId,
    requestCursor: task.cursor,
    cursor: '0',
    hasMore: false,
    folders: [{ id: '8', title: '保留', remoteCount: 1 }]
  })
  store.call('favoritesSave', {
    ...scope,
    taskId: task.id,
    stage: task.stage,
    folderId: task.folderId,
    requestCursor: task.cursor,
    cursor: '0',
    hasMore: false,
    items: [work('3')]
  })
  await expect(service.start('a', 'recommend', 'remove', ['3'], ['8'])).rejects.toThrow('保留收藏夹')
  expect(calls).toHaveLength(0)
  const before = store.call('libraryOverview', { accountId: 'a' })
  platform.afterWrite = () =>
    store.call('favoriteConfirm', {
      ...scope,
      work: work('2'),
      folder: { id: '8', title: '保留', remoteCount: 2, localCount: 1 }
    })
  await service.start('a', 'recommend', 'remove', ['1', '2'], ['8'])
  await done()
  expect(calls).toHaveLength(1)
  expect(library(store, 'recommend').task).toMatchObject({
    status: 'paused',
    success: 1,
    pending: 1,
    unknown: 0
  })
  expect(library(store, 'recommend').items.map((i) => i.id)).toEqual(['2', '3'])
  const after = store.call('libraryOverview', { accountId: 'a' })
  expect(after.likes).toBe(before.likes)
  expect(after.favorites).toBe(before.favorites)
})

for (const kind of ['mix', 'series'] as const) {
  it(`writes ${kind} only after fresh identity verification, with no writes on listing or sync`, async () => {
    const { store, service, platform, calls, done } = serviceSetup()
    seed(store, kind)
    expect(library(store, kind).items).toHaveLength(2)
    expect(calls).toHaveLength(0)
    await service.start('a', kind, 'remove', ['2'])
    await done()
    expect(calls).toEqual([
      { operation: kind === 'mix' ? 'mixRemove' : 'seriesRemove', parameters: { [kind + '_ids']: '2' } }
    ])
    expect(library(store, kind).task).toMatchObject({ status: 'completed', success: 1 })
    platform.remoteId = 'remote-b'
    await expect(service.start('a', kind, 'remove', ['9007199254740993999'])).rejects.toThrow('不匹配')
    expect(calls).toHaveLength(1)
  })
}

it('never retries or deletes an uncertain write, and keeps unsent items pending', async () => {
  const { store, service, platform, calls, done } = serviceSetup()
  seed(store)
  platform.failure = true
  await service.start('a', 'mix', 'remove', ['2', '9007199254740993999'])
  await done()
  expect(calls).toHaveLength(1)
  expect(library(store).task).toMatchObject({ status: 'paused', unknown: 1, success: 0, pending: 1 })
  expect(library(store).items).toHaveLength(2)
  await expect(service.start('a', 'mix', 'remove', ['2'])).rejects.toThrow('结果未知')
  expect(calls).toHaveLength(1)
})

it('keeps a confirmed in-flight result when stopped, with no later sends or abort of the write', async () => {
  const { store, service, platform, calls, cancel, done } = serviceSetup()
  seed(store)
  let release!: () => void
  platform.hold = () =>
    new Promise<void>((resolve) => {
      release = resolve
    })
  await service.start('a', 'mix', 'remove', ['2', '9007199254740993999'])
  await vi.waitFor(() => expect(calls).toHaveLength(1))
  const stopping = service.stop()
  expect(cancel).not.toHaveBeenCalled()
  release()
  await stopping
  await done()
  expect(calls).toHaveLength(1)
  expect(library(store).task).toMatchObject({ status: 'stopped', success: 1, pending: 1, unknown: 0 })
  expect(library(store).items).toHaveLength(1)
})

it('retains a platform-rejected group instead of counting it as success', async () => {
  const { store, service, platform, done } = serviceSetup()
  seed(store)
  platform.reply = { status_code: 0, fatal_ids: ['2'] }
  await service.start('a', 'mix', 'remove', ['2'])
  await done()
  expect(library(store).task).toMatchObject({ status: 'paused', success: 0, unknown: 0 })
  expect(library(store).items).toHaveLength(2)
})
