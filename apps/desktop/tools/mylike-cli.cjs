// CLI transport for the application's validated commands. No mouse/keyboard input,
// cookies export, arbitrary page scripts, or separate HTTP implementation.
const fs = require('node:fs')
const path = require('node:path')
let playwright
try {
  playwright = require('@playwright/test')
} catch (error) {
  const packagePath = path.resolve(__dirname, '../../work/MyLike/apps/desktop/package.json')
  if (!fs.existsSync(packagePath)) throw error
  playwright = require('node:module').createRequire(packagePath)('@playwright/test')
}
const { _electron } = playwright
async function main() {
  const [executable, command = 'snapshot', inputFile] = process.argv.slice(2)
  if (!executable) throw new Error('Usage: node tools/mylike-cli.cjs <exe> <command> [input.json]')
  const allowed = new Set([
    'snapshot',
    'scanAudit',
    'scanAuditChain',
    'query',
    'runtimeEvents',
    'collectionStart',
    'collectionControl',
    'favoritesStart',
    'favoritesControl',
    'favoriteFolders',
    'favoriteProtectedIds',
    'savedGroupsList',
    'savedGroupsSync',
    'unlikeStart',
    'unlikeAll',
    'unlikeControl',
    'savedGroupsRemove'
  ])
  if (!allowed.has(command)) throw new Error('Command not enabled for CLI')
  const app = await _electron.launch({
    executablePath: path.resolve(executable),
    env: { ...process.env, MYLIKE_HEADLESS: '1', MYLIKE_CLI: '1' },
    timeout: 30000
  })
  try {
    const page = await app.firstWindow()
    await page.waitForFunction(() => !!window.mylike)
    const invoke = (command, input) =>
      page.evaluate(async ({ command, input }) => window.mylike.invoke(command, input), { command, input })
    const state = await invoke('snapshot', {})
    if (!state.ok) throw Error(state.error.message)
    if (process.env.MYLIKE_DIRECT === '1') {
      const network = await app.evaluate(async ({ session }, accountId) => {
        const partition = session.fromPartition('persist:mylike-' + accountId)
        const before = await partition.resolveProxy('https://www.douyin.com')
        await partition.setProxy({ mode: 'direct' })
        await partition.closeAllConnections()
        return { before, after: await partition.resolveProxy('https://www.douyin.com') }
      }, state.data.activeAccountId)
      console.log(JSON.stringify({ network }))
    }
    const input = inputFile ? JSON.parse(fs.readFileSync(inputFile, 'utf8').replace(/^\uFEFF/, '')) : {}
    if (command !== 'snapshot' && !input.accountId) input.accountId = state.data.activeAccountId
    if (['unlikeStart', 'unlikeAll', 'savedGroupsRemove'].includes(command)) {
      const source =
        command === 'savedGroupsRemove'
          ? 'recommendations'
          : input.source === 'favorites'
            ? 'favorites'
            : 'likes'
      let ready = await invoke('scanAudit', { accountId: input.accountId, source, cursor: '0' })
      for (let retry = 0; !ready.ok && ready.error.code === 'BROWSER_NOT_READY' && retry < 3; retry++) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        ready = await invoke('scanAudit', { accountId: input.accountId, source, cursor: '0' })
      }
      if (!ready.ok) throw Error('Write not sent: ' + ready.error.code + ' ' + ready.error.message)
    }
    if (command === 'scanAuditChain') {
      const visited = new Set()
      for (let step = 0; step < 24; step++) {
        let result = await invoke('scanAudit', input)
        if (!result.ok && result.error.code === 'BROWSER_NOT_READY') {
          await new Promise((resolve) => setTimeout(resolve, 2000))
          result = await invoke('scanAudit', input)
        }
        console.log(JSON.stringify({ step, requestCursor: input.cursor, ...result }))
        if (!result.ok || ![1, '1', true].includes(result.data.hasMore)) break
        const next = String(result.data.cursor)
        if (!/^\d{1,30}$/.test(next) || visited.has(next) || next === input.cursor)
          throw Error('Cursor stalled')
        visited.add(input.cursor)
        input.cursor = next
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      return
    }
    let result = await invoke(command, input)
    for (
      let retry = 0;
      ['scanAudit', 'collectionStart', 'collectionControl', 'favoritesStart', 'favoritesControl'].includes(
        command
      ) &&
      !result.ok &&
      result.error.code === 'BROWSER_NOT_READY' &&
      retry < 3;
      retry++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      result = await invoke(command, input)
    }
    console.log(JSON.stringify(result))
    if (command === 'scanAudit') {
      const official = app.windows().find((p) => /^https:\/\/www\.douyin\.com\//.test(p.url()))
      if (official) {
        const text = await official.locator('body').innerText()
        console.log(
          JSON.stringify({
            pageSummary: {
              likeCount: text.match(/喜欢\s*\n\s*(\d+)/)?.[1] ?? null,
              loginRequired: text.includes('登录后即可观看')
            }
          })
        )
      }
    }
    if (!result.ok) {
      process.exitCode = 2
      return
    }
    if (
      /Start$|Sync$|All$|Remove$/.test(command) ||
      (['collectionControl', 'favoritesControl'].includes(command) && input.action === 'resume')
    ) {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        const s = await invoke('snapshot', {})
        if (!s.ok) throw Error(s.error.message)
        const d = s.data
        const compact = (t) =>
          t
            ? Object.fromEntries(
                [
                  'status',
                  'cursor',
                  'pages',
                  'received',
                  'added',
                  'success',
                  'failed',
                  'unknown',
                  'reason'
                ].map((k) => [k, t[k]])
              )
            : null
        console.log(
          JSON.stringify({
            collection: compact(d.collection),
            favorites: compact(d.favorites),
            unlike: compact(d.unlike)
          })
        )
        if (
          ![d.collection, d.favorites, d.unlike].some((t) => t?.status === 'running') &&
          !/savedGroups/.test(command)
        )
          break
        if (/savedGroups/.test(command)) {
          const g = await invoke('savedGroupsList', { accountId: input.accountId, kind: input.kind })
          console.log(
            JSON.stringify({
              groupTask: g.ok ? g.data.task : g.error,
              count: g.ok ? g.data.items.length : null
            })
          )
          if (!g.ok || g.data.task?.status !== 'running') break
        }
      }
    }
  } finally {
    await app.close()
  }
}
main().catch((e) => {
  console.error(e.message)
  process.exitCode = 1
})
