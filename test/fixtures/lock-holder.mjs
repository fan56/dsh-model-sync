// Lock-hardening test helper: hold the SAME cross-process lock file the
// production store uses, with a valid live-owner stamp, then release it.
// `backdateMs` makes the stamp look old while the PID stays alive (negative
// stale-break case); the mtime is irrelevant because the implementation reads
// the stamped createdAt.
import { randomUUID } from 'node:crypto'
import { open, rm, writeFile } from 'node:fs/promises'

const [lockPath, markerPath, holdMs, backdateMs = '0'] = process.argv.slice(2)
const handle = await open(lockPath, 'wx')
await handle.writeFile(JSON.stringify({
  pid: process.pid,
  nonce: randomUUID(),
  createdAt: Date.now() - Number(backdateMs),
}), 'utf8')
await writeFile(markerPath, 'acquired')
await new Promise((resolve) => setTimeout(resolve, Number(holdMs)))
await handle.close()
await rm(lockPath, { force: true })
