// Lock-hardening test helper: perform real store writes in a separate OS
// process and report the outcome (including error name/code/message) to a
// result file. `barrier` blocks until the parent creates it, so two writers
// can be released simultaneously; `ready` signals the child is about to write.
import { writeFile, readFile } from 'node:fs/promises'

const [configJson] = process.argv.slice(2)
const cfg = JSON.parse(configJson)
const { loadModelsStore } = await import(cfg.libRemote)

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
  if (cfg.result) await writeFile(cfg.result, JSON.stringify({ ok: true }))
} catch (err) {
  if (cfg.result) {
    await writeFile(cfg.result, JSON.stringify({
      ok: false,
      name: err?.name ?? null,
      code: err?.code ?? null,
      message: err?.message ?? String(err),
    }))
  }
  process.exitCode = 1
}
