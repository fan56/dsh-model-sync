// Lock-hardening test helper: perform real store writes in a separate OS
// process and report the outcome (including error name/code/message) to a
// result file. `barrier` blocks until the parent creates it, so two writers
// can be released simultaneously; `ready` signals the child is about to write.
// The result file is written atomically (temp + rename) so the parent's
// wait-for-file can never observe a half-written JSON document.
import { writeFile, readFile, rename } from 'node:fs/promises'

const [configJson] = process.argv.slice(2)
const cfg = JSON.parse(configJson)
const { loadModelsStore } = await import(cfg.libRemote)

// Atomic result publish: waitForFile() returns only once the final path exists,
// and rename(2) guarantees the content is complete at that point.
async function publishResult(value) {
  if (!cfg.result) return
  const tmp = `${cfg.result}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(value))
  await rename(tmp, cfg.result)
}

if (cfg.barrier) {
  for (;;) {
    try {
      await readFile(cfg.barrier, 'utf8')
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
}
if (cfg.ready) await writeFile(cfg.ready, 'ready')

try {
  const store = loadModelsStore(cfg.file)
  if (typeof cfg.count === 'number') {
    for (let i = 0; i < cfg.count; i += 1) {
      await store.writeRaw(`${cfg.profile}#go-fp-${i}`, { managed: { [i]: { hash: 'h' } } })
    }
  } else {
    await store.writeRaw(cfg.key, cfg.value)
  }
  await publishResult({ ok: true })
} catch (err) {
  await publishResult({
    ok: false,
    name: err?.name ?? null,
    code: err?.code ?? null,
    message: err?.message ?? String(err),
  })
  process.exitCode = 1
}
