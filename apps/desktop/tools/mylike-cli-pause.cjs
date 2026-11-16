// Attach only to the loopback debugging endpoint of the CLI-owned MyLike process.
// Invoke the existing validated pause command; no page clicks or HTTP account calls.
const fs = require('node:fs'),
  path = require('node:path'),
  { chromium } = require('@playwright/test')
async function main() {
  const appData = process.env.APPDATA
  if (!process.argv[2] && !appData) throw Error('Pass the data directory or set APPDATA')
  const dir =
    process.argv[2] ||
    JSON.parse(fs.readFileSync(path.join(appData, 'MyLikeElectron', 'storage-location.json'), 'utf8'))
      .directory
  const port = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]
  if (!/^\d{1,5}$/.test(port)) throw Error('Invalid local port')
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port)
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url() === 'mylike://ui/index.html')
  if (!page) throw Error('MyLike application target missing')
  const result = await page.evaluate(async () => {
    const s = await window.mylike.invoke('snapshot', {})
    if (!s.ok) throw Error(s.error.message)
    const t = s.data.collection
    return t?.status === 'running'
      ? window.mylike.invoke('collectionControl', {
          accountId: s.data.activeAccountId,
          taskId: t.id,
          action: 'pause'
        })
      : { ok: true, data: { status: t?.status } }
  })
  console.log(JSON.stringify(result))
  process.exit(result.ok ? 0 : 2)
}
main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
