// P1c-2 verification: async timer + scheduling, driven by a FAKE clock.
// No real sleep, no network, no ~/.dsh. Every timer callback is awaited by the
// fake clock, so re-arms/backoffs are deterministic and fully observable.

import assert from 'node:assert/strict'
import {
  GO_AUTH_BACKOFF_CAP_MS,
  GO_INTERVAL_DEFAULT_MINUTES,
  GO_INTERVAL_MIN_MINUTES,
  GO_STARTUP_JITTER_MAX_MS,
  GO_TRANSPORT_BACKOFF_CAP_MS,
  GoScheduler,
  clampGoIntervalMinutes,
  goBackoffDelayMs,
  goStartupDelayMs,
} from '../lib/opencode-go-scheduler.js'
import { runGoSyncRound } from '../lib/opencode-go-sync.js'
import { fetchGoOfficialModels } from '../lib/opencode-go-source.js'

let failed = 0
let passed = 0
const check = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}: ${error.stack ?? error.message}`)
  }
}

/** Deterministic timer: advance(ms) fires due callbacks in due order and awaits them. */
class FakeClock {
  constructor() {
    this.now = 0
    this.seq = 0
    this.timers = new Map()
  }
  setTimeout(fn, ms) {
    const id = ++this.seq
    this.timers.set(id, { fn, due: this.now + Math.max(0, ms) })
    return id
  }
  clearTimeout(id) {
    this.timers.delete(id)
  }
  /** Delays of all armed timers, relative to now. */
  get pending() {
    return [...this.timers.values()].map((t) => t.due - this.now).sort((a, b) => a - b)
  }
  /** Fire the earliest timer WITHOUT awaiting its callback (for in-flight probes). */
  fireNext() {
    const next = [...this.timers.entries()].sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0]
    if (next === undefined) return undefined
    const [id, timer] = next
    this.timers.delete(id)
    this.now = timer.due
    return timer.fn()
  }
  async advance(ms) {
    const target = this.now + ms
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.due <= target)
        .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])
      if (due.length === 0) break
      const [id, timer] = due[0]
      this.timers.delete(id)
      this.now = timer.due
      await timer.fn()
    }
    this.now = target
  }
}

const okOutcome = (text = 'round ok') => ({ ok: true, reason: 'completed', text })
const failOutcome = (failureKind, text = 'source failed; kept last-good, no settings write') => ({
  ok: false, reason: 'source-failed', text, failureKind,
})

function makeHarness(overrides = {}) {
  const clock = new FakeClock()
  const reports = []
  const runs = []
  let runImpl = async () => okOutcome()
  const cfg = {
    enabled: true,
    intervalMinutes: GO_INTERVAL_DEFAULT_MINUTES,
    startupDelaySeconds: 5,
    ...overrides.config,
  }
  let randomValue = overrides.randomValue ?? 0
  const scheduler = new GoScheduler({
    config: () => ({ ...cfg }),
    timers: clock,
    random: { next: () => randomValue },
    runRound: (req) => {
      runs.push({ at: clock.now, ...req })
      return runImpl(req)
    },
    report: (text) => reports.push({ at: clock.now, text }),
    isApplying: overrides.isApplying,
  })
  return {
    clock, reports, runs, scheduler, cfg,
    setRandom: (v) => { randomValue = v },
    setRun: (fn) => { runImpl = fn },
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (design values + implementation caps)
// ---------------------------------------------------------------------------

await check('interval floor 15 and default 60', () => {
  assert.equal(GO_INTERVAL_MIN_MINUTES, 15)
  assert.equal(GO_INTERVAL_DEFAULT_MINUTES, 60)
  assert.equal(clampGoIntervalMinutes(5), 15)
  assert.equal(clampGoIntervalMinutes(60), 60)
  assert.equal(clampGoIntervalMinutes(240), 240)
  assert.equal(clampGoIntervalMinutes(Number.NaN), 60)
})

await check('startup delay = seconds*1000 + bounded jitter', () => {
  assert.equal(goStartupDelayMs(5, 0), 5000)
  assert.equal(goStartupDelayMs(5, 0.5), 5000 + GO_STARTUP_JITTER_MAX_MS / 2)
  assert.equal(goStartupDelayMs(0, 1), GO_STARTUP_JITTER_MAX_MS)
  assert.equal(goStartupDelayMs(-1, -1), 0)
})

await check('backoff doubling with transport 30min / auth 6h caps', () => {
  assert.equal(goBackoffDelayMs(1, 'transport'), 60_000)
  assert.equal(goBackoffDelayMs(2, 'offline'), 120_000)
  assert.equal(goBackoffDelayMs(5, 'transport'), 16 * 60_000)
  assert.equal(goBackoffDelayMs(6, 'transport'), GO_TRANSPORT_BACKOFF_CAP_MS)
  assert.equal(goBackoffDelayMs(99, 'transport'), GO_TRANSPORT_BACKOFF_CAP_MS)
  assert.equal(goBackoffDelayMs(1, 'auth'), 60 * 60_000)
  assert.equal(goBackoffDelayMs(3, 'entitlement'), 4 * 60 * 60_000)
  assert.equal(goBackoffDelayMs(9, 'auth'), GO_AUTH_BACKOFF_CAP_MS)
})

// ---------------------------------------------------------------------------
// First delay + jitter
// ---------------------------------------------------------------------------

await check('first round fires only after startupDelaySeconds (no early trigger)', async () => {
  const h = makeHarness({ config: { startupDelaySeconds: 5 }, randomValue: 0 })
  h.scheduler.start()
  assert.deepEqual(h.clock.pending, [5000])
  await h.clock.advance(4999)
  assert.equal(h.runs.length, 0)
  await h.clock.advance(1)
  assert.equal(h.runs.length, 1)
  assert.equal(h.runs[0].at, 5000)
  assert.equal(h.runs[0].trigger, 'startup')
})

await check('startup jitter shifts the first round by the injected random value', async () => {
  const h = makeHarness({ config: { startupDelaySeconds: 5 }, randomValue: 0.5 })
  h.scheduler.start()
  assert.deepEqual(h.clock.pending, [7500])
  await h.clock.advance(7499)
  assert.equal(h.runs.length, 0)
  await h.clock.advance(1)
  assert.equal(h.runs.length, 1)
  assert.equal(h.runs[0].at, 7500)
})

// ---------------------------------------------------------------------------
// Interval + live re-arm
// ---------------------------------------------------------------------------

await check('successful startup round arms the 60min interval', async () => {
  const h = makeHarness({ config: { startupDelaySeconds: 0 }, randomValue: 0 })
  h.scheduler.start()
  await h.clock.advance(0)
  assert.deepEqual(h.clock.pending, [60 * 60_000])
  await h.clock.advance(60 * 60_000 - 1)
  assert.equal(h.runs.length, 1)
  await h.clock.advance(1)
  assert.equal(h.runs.length, 2)
  assert.equal(h.runs[1].trigger, 'interval')
})

await check('config change live re-arms the interval (and clamps to the 15min floor)', async () => {
  const h = makeHarness({ config: { startupDelaySeconds: 0 }, randomValue: 0 })
  h.scheduler.start()
  await h.clock.advance(0)
  assert.deepEqual(h.clock.pending, [60 * 60_000])

  h.cfg.intervalMinutes = 15
  h.cfg.startupDelaySeconds = 0
  h.scheduler.rearm()
  assert.deepEqual(h.clock.pending, [15 * 60_000], 're-arm uses fresh config')

  h.cfg.intervalMinutes = 5
  h.scheduler.rearm()
  assert.deepEqual(h.clock.pending, [15 * 60_000], 'sub-floor values clamp to 15min')

  await h.clock.advance(15 * 60_000)
  assert.equal(h.runs.length, 2)
})

await check('config change to enabled=false disarms the go timer entirely', async () => {
  const h = makeHarness({ config: { startupDelaySeconds: 0 }, randomValue: 0 })
  h.scheduler.start()
  await h.clock.advance(0)
  h.cfg.enabled = false
  h.scheduler.rearm()
  assert.deepEqual(h.clock.pending, [])
  await h.clock.advance(10 * 60 * 60_000)
  assert.equal(h.runs.length, 1, 'no further round after disable')
})

// ---------------------------------------------------------------------------
// Single-flight (manual /model-sync go vs timer)
// ---------------------------------------------------------------------------

await check('manual + timer triggers during an in-flight round are skipped and reported', async () => {
  const h = makeHarness({ config: { startupDelaySeconds: 60 }, randomValue: 0 })
  let resolveFirst
  h.setRun(() => new Promise((resolve) => { resolveFirst = resolve }))

  h.scheduler.start()
  const first = h.clock.fireNext() // timer-driven round starts, stays in flight
  assert.equal(h.scheduler.isInFlight, true)
  assert.equal(h.runs.length, 1)
  assert.equal(h.runs[0].trigger, 'startup')

  const second = await h.scheduler.triggerManual()
  assert.equal(second.skipped, true)
  assert.equal(second.reason, 'already-in-flight')
  assert.match(second.text, /single-flight/)
  assert.match(second.text, /no queue, no retry/)
  assert.equal(h.runs.length, 1, 'skipped manual trigger never calls the round')
  assert.deepEqual(h.clock.pending, [], 'no extra timer armed while in flight')

  resolveFirst(okOutcome('first done'))
  await first
  assert.equal(h.scheduler.isInFlight, false)
  assert.deepEqual(h.clock.pending, [60 * 60_000], 'one successor interval after the round')
})

// P1d-1 M-5: a migration apply owns the routes; auto/manual rounds drop.
await check('applying migration: auto + manual rounds are skipped, not queued', async () => {
  let applying = true
  const h = makeHarness({ config: { startupDelaySeconds: 5 }, isApplying: async () => applying })
  h.scheduler.start()
  await h.clock.advance(5000)
  assert.equal(h.runs.length, 0, 'applying dropped the auto round before runRound')
  assert.equal(h.reports.length, 1)
  assert.match(h.reports[0].text, /migration apply in progress/)
  assert.match(h.reports[0].text, /no queue, no retry/)

  const manual = await h.scheduler.triggerManual()
  assert.equal(manual.skipped, true)
  assert.equal(manual.reason, 'migration-applying')
  assert.equal(h.runs.length, 0, 'applying also drops manual rounds')

  applying = false
  const after = await h.scheduler.triggerManual()
  assert.equal(after.skipped, false, 'releasing applying lets rounds through again')
  assert.equal(h.runs.length, 1)
})

await check('manual adopt flag is forwarded to the round', async () => {
  const h = makeHarness({ config: { startupDelaySeconds: 0 }, randomValue: 0 })
  h.scheduler.start()
  await h.clock.advance(0)
  const result = await h.scheduler.triggerManual({ adopt: true })
  assert.equal(result.skipped, false)
  assert.equal(h.runs.length, 2)
  assert.equal(h.runs[1].trigger, 'manual')
  assert.equal(h.runs[1].adopt, true)
})

// ---------------------------------------------------------------------------
// Backoff + last-good preservation
// ---------------------------------------------------------------------------

await check('transport failures back off exponentially up to the 30min cap', async () => {
  const h = makeHarness({ config: { startupDelaySeconds: 0 }, randomValue: 0 })
  h.setRun(async () => failOutcome('transport'))
  h.scheduler.start()
  await h.clock.advance(0)
  assert.equal(h.runs.length, 1)

  const expected = [60_000, 120_000, 240_000, 480_000, 960_000, 30 * 60_000, 30 * 60_000]
  for (const delay of expected) {
    assert.deepEqual(h.clock.pending, [delay], `next backoff delay should be ${delay}ms`)
    await h.clock.advance(delay)
  }
  assert.equal(h.runs.length, 1 + expected.length)
  // The last advance also ran a round (which armed the next backoff), so the
  // streak is one past the number of delays asserted above.
  assert.equal(h.scheduler.failureStreak, 1 + expected.length)
})

await check('auth/entitlement failures back off up to the 6h cap', async () => {
  const h = makeHarness({ config: { startupDelaySeconds: 0 }, randomValue: 0 })
  h.setRun(async () => failOutcome('auth'))
  h.scheduler.start()
  await h.clock.advance(0)
  const expected = [60 * 60_000, 2 * 60 * 60_000, 4 * 60 * 60_000, 6 * 60 * 60_000, 6 * 60 * 60_000]
  for (const delay of expected) {
    assert.deepEqual(h.clock.pending, [delay])
    await h.clock.advance(delay)
  }
  assert.equal(h.scheduler.failureStreak, 1 + expected.length)
})

await check('a successful round resets backoff to the normal interval', async () => {
  const h = makeHarness({ config: { startupDelaySeconds: 0 }, randomValue: 0 })
  let mode = 'fail'
  h.setRun(async () => (mode === 'fail' ? failOutcome('transport') : okOutcome()))
  h.scheduler.start()
  await h.clock.advance(0)
  assert.deepEqual(h.clock.pending, [60_000])
  await h.clock.advance(60_000)
  assert.deepEqual(h.clock.pending, [120_000])
  mode = 'ok'
  await h.clock.advance(120_000)
  assert.deepEqual(h.clock.pending, [60 * 60_000], 'success restores the 60min interval')
  assert.equal(h.scheduler.failureStreak, 0)
})

await check('failed real round keeps last-good settings + ledger and reports it', async () => {
  const h = makeHarness({ config: { startupDelaySeconds: 0 }, randomValue: 0 })
  const mutations = []
  const ledgerWrites = []
  const settings = {
    describe: () => [{
      ns: 'llm-pi-ai',
      revision: 1,
      user: { providers: { 'opencode-go': { models: [{ id: 'hand-written', name: 'user' }] } } },
    }],
    async mutate() { mutations.push(arguments) },
  }
  const ownershipStore = {
    async read() { return undefined },
    async write(key, entry) { ledgerWrites.push({ key, entry }) },
    async delete() {},
  }
  const goConfig = {
    enabled: true,
    ref: 'OPENCODE_GO_API_KEY',
    modelsUrl: 'https://opencode.ai/inference/go/v1/models',
    routes: {},
    pinnedModels: [],
    confirmRemovals: 2,
    adoptExisting: false,
  }
  // A 503 is a transport failure: the round returns before the writer.
  h.setRun(() => runGoSyncRound({
    settings,
    ownershipStore,
    logger: { info() {}, warn() {}, error() {} },
    config: goConfig,
    apiKey: 'test-key',
    fetchImpl: async () => ({ status: 503, json: async () => ({}) }),
  }))

  h.scheduler.start()
  await h.clock.advance(0)
  assert.equal(h.runs.length, 1)
  assert.deepEqual(mutations, [], 'offline/transport failure writes no settings')
  assert.deepEqual(ledgerWrites, [], 'no ledger write on failure — last-good kept')
  assert.match(h.reports[0].text, /kept last-good, no settings write/)
  assert.deepEqual(h.clock.pending, [60_000], 'failure schedules a backoff, not the normal interval')
})

// ---------------------------------------------------------------------------
// Cleanup + enabled=false zero triggers
// ---------------------------------------------------------------------------

await check('dispose clears the pending timer so no hanging task remains', async () => {
  const h = makeHarness({ config: { startupDelaySeconds: 5 }, randomValue: 0 })
  h.scheduler.start()
  assert.deepEqual(h.clock.pending, [5000])
  h.scheduler.dispose()
  assert.deepEqual(h.clock.pending, [])
  await h.clock.advance(60 * 60_000)
  assert.equal(h.runs.length, 0)
  const manual = await h.scheduler.triggerManual()
  assert.equal(manual.skipped, true)
  assert.equal(manual.reason, 'disposed')
})

await check('dispose during an in-flight round prevents any re-arm', async () => {
  const h = makeHarness({ config: { startupDelaySeconds: 60 }, randomValue: 0 })
  let resolveFirst
  h.setRun(() => new Promise((resolve) => { resolveFirst = resolve }))
  h.scheduler.start()
  const first = h.clock.fireNext() // round starts, stays in flight
  h.scheduler.dispose()
  resolveFirst(okOutcome())
  await first
  assert.deepEqual(h.clock.pending, [], 'no successor timer after unload')
})

await check('enabled=false: zero triggers, manual skipped with reason', async () => {
  const h = makeHarness({ config: { enabled: false, startupDelaySeconds: 0 }, randomValue: 0 })
  h.scheduler.start()
  assert.deepEqual(h.clock.pending, [])
  await h.clock.advance(24 * 60 * 60_000)
  assert.equal(h.runs.length, 0, 'no automatic round at all')
  const manual = await h.scheduler.triggerManual()
  assert.equal(manual.skipped, true)
  assert.equal(manual.reason, 'disabled')
  assert.match(manual.text, /disabled — set opencode\.go\.enabled=true/)
  assert.match(manual.text, /routeWriter on every write path/, 'report points to the independent migration gate')
  assert.equal(h.runs.length, 0, 'manual trigger runs no round either')
})

await check('real-round report text is passed through unchanged', async () => {
  const h = makeHarness({ config: { startupDelaySeconds: 0 }, randomValue: 0 })
  const text = 'opencode-go: source ok (3 models)\n  opencode-go: wrote 1 → 2'
  h.setRun(async () => okOutcome(text))
  h.scheduler.start()
  await h.clock.advance(0)
  const manual = await h.scheduler.triggerManual()
  assert.equal(manual.text, text)
  assert.equal(h.reports.at(-1).text, text)
})

// ---------------------------------------------------------------------------
// C1: backoff reset (credential change / manual force)
// ---------------------------------------------------------------------------

await check('credential change resets a capped auth backoff to the normal interval', async () => {
  const h = makeHarness({ config: { startupDelaySeconds: 0 }, randomValue: 0 })
  h.setRun(async () => failOutcome('auth'))
  h.scheduler.start()
  await h.clock.advance(0) // startup round fails with auth → 1h backoff
  // Drive the auth streak up to the 6h cap: 1h, 2h, 4h, then 6h (capped).
  for (const delay of [60 * 60_000, 2 * 60 * 60_000, 4 * 60 * 60_000]) {
    assert.deepEqual(h.clock.pending, [delay])
    await h.clock.advance(delay)
  }
  assert.deepEqual(h.clock.pending, [GO_AUTH_BACKOFF_CAP_MS], 'auth backoff reached the 6h cap')
  assert.equal(h.scheduler.failureStreak, 4)

  // Simulate the credentials/reference-updated listener firing for the go ref.
  h.scheduler.resetBackoff()
  assert.equal(h.scheduler.failureStreak, 0, 'backoff history cleared')
  assert.deepEqual(h.clock.pending, [60 * 60_000], 'next round uses the normal interval, not the 6h cap')
  await h.clock.advance(60 * 60_000)
  assert.equal(h.runs.length, 5)
  assert.equal(h.runs.at(-1).trigger, 'interval', 'the recovery round is an ordinary interval round')
})

await check('manual force clears backoff before the round (even if that round fails)', async () => {
  const h = makeHarness({ config: { startupDelaySeconds: 0 }, randomValue: 0 })
  h.setRun(async () => failOutcome('transport'))
  h.scheduler.start()
  await h.clock.advance(0) // streak 1 → 60s
  await h.clock.advance(60_000) // streak 2 → 120s
  assert.equal(h.scheduler.failureStreak, 2)
  assert.deepEqual(h.clock.pending, [120_000])

  const result = await h.scheduler.triggerManual()
  assert.equal(result.skipped, false)
  assert.equal(h.runs.at(-1).trigger, 'manual')
  // The manual round still fails, but it started from a clean slate: only one
  // failure is counted now, so the next backoff restarts at 60s (not 240s).
  assert.equal(h.scheduler.failureStreak, 1, 'manual force reset the streak before firing')
  assert.deepEqual(h.clock.pending, [60_000], 'backoff restarted from the base delay')
})

await check('resetBackoff is a no-op after dispose', async () => {
  const h = makeHarness({ config: { startupDelaySeconds: 0 }, randomValue: 0 })
  h.setRun(async () => failOutcome('transport'))
  h.scheduler.start()
  await h.clock.advance(0)
  h.scheduler.dispose()
  h.scheduler.resetBackoff()
  assert.deepEqual(h.clock.pending, [], 'no timer re-armed after unload')
  assert.equal(h.scheduler.failureStreak, 0, 'streak still cleared, but nothing is scheduled')
})

// ---------------------------------------------------------------------------
// C2: unload aborts the in-flight round (no settings write after dispose)
// ---------------------------------------------------------------------------

const goRoundConfig = {
  enabled: true,
  ref: 'OPENCODE_GO_API_KEY',
  modelsUrl: 'https://example.test/models',
  routes: {},
  pinnedModels: [],
  confirmRemovals: 2,
  adoptExisting: false,
}
const quietLogger = { info() {}, warn() {}, error() {} }
const noopOwnership = { async read() { return undefined }, async write() {}, async delete() {} }

await check('dispose aborts an in-flight fetch and writes no settings', async () => {
  const h = makeHarness({ config: { startupDelaySeconds: 0 }, randomValue: 0 })
  const mutations = []
  const settings = {
    describe: () => [{
      ns: 'llm-pi-ai',
      revision: 1,
      user: { providers: { 'opencode-go': { models: [{ id: 'hand-written', name: 'user' }] } } },
    }],
    async mutate() { mutations.push(arguments) },
  }
  let fetchSignal
  h.setRun((req) => runGoSyncRound({
    settings,
    ownershipStore: noopOwnership,
    logger: quietLogger,
    config: goRoundConfig,
    apiKey: 'test-key',
    fetchImpl: (url, init) => {
      fetchSignal = init.signal
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        }, { once: true })
      })
    },
    signal: req.signal,
  }))

  // Route the source's 30s safety timeout into the fake clock: no real timer
  // is ever created, and the abort below clears it synchronously.
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = h.clock.setTimeout.bind(h.clock)
  globalThis.clearTimeout = h.clock.clearTimeout.bind(h.clock)
  try {
    h.scheduler.start()
    const inFlight = h.clock.fireNext() // round starts; fetch is pending
    assert.ok(fetchSignal, 'fetch received an AbortSignal')
    assert.equal(fetchSignal.aborted, false)

    h.scheduler.dispose()
    assert.equal(fetchSignal.aborted, true, 'dispose aborts the in-flight fetch')

    const result = await inFlight
    assert.equal(result.ok, false)
    assert.deepEqual(mutations, [], 'no settings write after unload')
    assert.deepEqual(h.clock.pending, [], 'no successor timer after unload')
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
})

await check('an aborted round never reaches the writer (fetch-returns-anyway race)', async () => {
  const mutations = []
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', revision: 1, user: { providers: {} } }],
    async mutate() { mutations.push(arguments) },
  }
  const controller = new AbortController()
  controller.abort() // aborted before the writer is reached
  const result = await runGoSyncRound({
    settings,
    ownershipStore: noopOwnership,
    logger: quietLogger,
    config: goRoundConfig,
    apiKey: 'test-key',
    // The fetch mock ignores the signal and returns a valid 200: only the
    // explicit guard in runGoSyncRound can block the write in this race.
    fetchImpl: async () => ({ status: 200, json: async () => ({ data: [{ id: 'm1', name: 'M1' }] }) }),
    signal: controller.signal,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'aborted')
  assert.deepEqual(mutations, [], 'writer guard blocks settings.mutate after abort')
})

// A source-level signal bridge test: an external abort must reach fetchImpl's
// signal, proving the plugin-lifetime signal is wired through fetchGoOfficialModels.
await check('external signal abort reaches the fetch init signal', async () => {
  const controller = new AbortController()
  let seenSignal
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const clock = new FakeClock()
  globalThis.setTimeout = clock.setTimeout.bind(clock)
  globalThis.clearTimeout = clock.clearTimeout.bind(clock)
  try {
    const promise = fetchGoOfficialModels({
      apiKey: 'test-key',
      fetchImpl: (url, init) => {
        seenSignal = init.signal
        return new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      },
      signal: controller.signal,
    })
    assert.ok(seenSignal, 'fetch saw the bridged signal')
    assert.equal(seenSignal.aborted, false)
    controller.abort()
    assert.equal(seenSignal.aborted, true, 'external abort propagated to fetch')
    await promise
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
})

if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\nAll ${passed} assertions passed.`)
