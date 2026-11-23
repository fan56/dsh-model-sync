// P1c-2: async timer + scheduling layer for the opencode-go sync round.
//
// This module owns ONLY scheduling (design §6.3 / §14.6): startup delay +
// jitter, the 60min (floor 15) interval with live re-arm, single-flight with
// the manual /model-sync go command, failure backoff with caps, and timer
// cleanup on plugin unload. It does NOT run the round itself — `runRound` is
// injected and is normally index.ts's runGoRound (source → planner → writer).
//
// Every clock/random input is injected (GoSchedulerTimers / GoSchedulerRandom),
// so the whole state machine runs deterministically under a fake timer: no
// real sleep, no network. The production adapters live in index.ts.
//
// Last-good safety: scheduling never persists anything. Backoff state is an
// in-memory streak only. A failed round returns before the writer, so settings
// and the ownership ledger keep their last-good values (design §6.3 "离线:
// settings 中 last-good 继续可用"; M-4 zero-write is P1d and NOT implemented
// here — the `enabled=false` default is what currently protects un-migrated
// hand-written routes).

import type { GoFailureKind } from './opencode-go-source.ts'

/** Cordis service seams used by index.ts to inject test doubles. */
export const GO_SCHEDULER_TIMERS_SERVICE = 'goSchedulerTimers'
export const GO_SCHEDULER_RANDOM_SERVICE = 'goSchedulerRandom'

/** Trigger origin, recorded in every report so auto/manual rounds are distinguishable. */
export type GoTrigger = 'startup' | 'interval' | 'backoff' | 'manual'

/** The subset of Config the scheduler reads (live, via a callback). */
export interface GoSchedulerConfig {
  /** Master switch. Design §6.2.6 default false; kept false until P1d (migration gate). */
  enabled: boolean
  /** go.intervalMinutes — default 60, floor 15 (design §6.3 / ADR-007). */
  intervalMinutes: number
  /** startupDelaySeconds — jitter is added on top (design §6.3). */
  startupDelaySeconds: number
}

/** Opaque timer handle (platform Timeout in production, an id in fake timers). */
export type GoTimerHandle = unknown

/** Minimal clock surface the scheduler needs. Injectable for deterministic tests. */
export interface GoSchedulerTimers {
  setTimeout(fn: () => void, ms: number): GoTimerHandle
  clearTimeout(handle: GoTimerHandle): void
}

/** Injectable [0,1) source so startup jitter is deterministic in tests. */
export interface GoSchedulerRandom {
  next(): number
}

/** What the scheduler needs back from one round to drive backoff + reporting. */
export interface GoRoundOutcome {
  ok: boolean
  reason: string
  /** Report text — passed through unchanged for real rounds (design item 3). */
  text: string
  /** Source failure taxonomy; set only when the round reached the source. */
  failureKind?: GoFailureKind
}

export interface GoRoundRequest {
  trigger: GoTrigger
  adopt: boolean
}

export interface GoSchedulerDeps {
  config: () => GoSchedulerConfig
  timers: GoSchedulerTimers
  random: GoSchedulerRandom
  runRound: (request: GoRoundRequest) => Promise<GoRoundOutcome>
  /** Sink for the per-round report (auto rounds have no caller to return it to). */
  report: (text: string) => void
}

/** A scheduled or manually triggered round result, including skips. */
export interface GoScheduledResult extends GoRoundOutcome {
  /** True when the round was skipped (single-flight / disabled / disposed). */
  skipped: boolean
}

// Implementation constants. Design §6.3 / ADR-007 fix the interval floor and
// the transport/auth caps; the backoff BASE and the startup jitter window are
// not specified numerically by the design, so these are the documented
// implementation choices (kept exported for tests).
export const GO_INTERVAL_MIN_MINUTES = 15
export const GO_INTERVAL_DEFAULT_MINUTES = 60
export const GO_STARTUP_JITTER_MAX_MS = 5_000
export const GO_TRANSPORT_BACKOFF_BASE_MS = 60_000
export const GO_TRANSPORT_BACKOFF_CAP_MS = 30 * 60_000
export const GO_AUTH_BACKOFF_BASE_MS = 60 * 60_000
export const GO_AUTH_BACKOFF_CAP_MS = 6 * 60 * 60_000

/** Clamp an interval to the design floor; non-finite falls back to the default. */
export function clampGoIntervalMinutes(value: number): number {
  if (!Number.isFinite(value)) return GO_INTERVAL_DEFAULT_MINUTES
  return Math.max(GO_INTERVAL_MIN_MINUTES, Math.floor(value))
}

/** startupDelaySeconds*1000 plus bounded jitter (random is in [0,1)). */
export function goStartupDelayMs(seconds: number, random: number): number {
  const base = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0
  const r = Math.min(1, Math.max(0, Number.isFinite(random) ? random : 0))
  return base + Math.floor(r * GO_STARTUP_JITTER_MAX_MS)
}

/** Exponential backoff with per-class cap (design §6.3). */
export function goBackoffDelayMs(streak: number, failureKind?: GoFailureKind): number {
  const n = Math.max(1, Math.floor(streak))
  const auth = failureKind === 'auth' || failureKind === 'entitlement'
  const base = auth ? GO_AUTH_BACKOFF_BASE_MS : GO_TRANSPORT_BACKOFF_BASE_MS
  const cap = auth ? GO_AUTH_BACKOFF_CAP_MS : GO_TRANSPORT_BACKOFF_CAP_MS
  return Math.min(cap, base * 2 ** (n - 1))
}

/** Report text for a skipped round — always states the reason explicitly. */
export function goSchedulerSkipReport(reason: string, trigger: GoTrigger): string {
  const when = `opencode-go scheduler (${trigger})`
  switch (reason) {
    case 'disabled':
      // Keep the legacy phrase "disabled — set opencode.go.enabled=true" so
      // manual /model-sync go reports stay byte-compatible with P1c-1.
      return `${when}: skipped — opencode.go sync is disabled — set opencode.go.enabled=true; no request, no settings write. Migration gate is P1d: the disabled default is what currently protects un-migrated hand-written routes.`
    case 'already-in-flight':
      return `${when}: skipped — a go round is already in flight (single-flight); no queue, no retry, no settings write (design §14.6).`
    case 'disposed':
      return `${when}: skipped — scheduler disposed (plugin unload); no request, no settings write.`
    default:
      return `${when}: skipped — ${reason}; no request, no settings write.`
  }
}

function isBackoffFailure(outcome: GoRoundOutcome): boolean {
  // Configuration/skip states (disabled, no-key, settings-unavailable) are not
  // failures — they keep the normal interval. Only source failures back off.
  return outcome.reason === 'source-failed' || outcome.failureKind !== undefined
}

/**
 * The scheduler state machine. One instance per plugin activation; it owns a
 * single timer handle and a single in-flight flag shared by auto and manual
 * triggers (that is the single-flight lock).
 */
export class GoScheduler {
  private readonly config: () => GoSchedulerConfig
  private readonly timers: GoSchedulerTimers
  private readonly random: GoSchedulerRandom
  private readonly runRound: (request: GoRoundRequest) => Promise<GoRoundOutcome>
  private readonly report: (text: string) => void

  private handle: GoTimerHandle | undefined
  private started = false
  private inFlight = false
  private disposed = false
  private streak = 0
  private lastFailureKind: GoFailureKind | undefined

  constructor(deps: GoSchedulerDeps) {
    this.config = deps.config
    this.timers = deps.timers
    this.random = deps.random
    this.runRound = deps.runRound
    this.report = deps.report
  }

  /** Arm the startup timer. No-op when disabled — zero triggers at enabled=false. */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    const cfg = this.config()
    if (!cfg.enabled) return
    this.arm(goStartupDelayMs(cfg.startupDelaySeconds, this.random.next()), 'startup')
  }

  /**
   * Live re-arm after a settings edit. Cancels the pending timer and reads
   * fresh config; a round already in flight keeps its lock and picks up the
   * new config when it schedules its own successor.
   */
  rearm(): void {
    if (this.disposed || !this.started) return
    this.cancel()
    if (this.inFlight) return
    this.armFromConfig()
  }

  /** Cancel every timer. A round already in flight settles but never re-arms. */
  dispose(): void {
    this.disposed = true
    this.cancel()
  }

  get isInFlight(): boolean {
    return this.inFlight
  }

  get failureStreak(): number {
    return this.streak
  }

  /** Manual /model-sync go trigger — shares the single-flight lock with auto rounds. */
  triggerManual(options: { adopt?: boolean } = {}): Promise<GoScheduledResult> {
    return this.fire('manual', options.adopt === true)
  }

  private arm(delayMs: number, trigger: GoTrigger): void {
    this.cancel()
    // Returning the promise is harmless to real setTimeout (return value is
    // ignored) and lets a fake timer await the whole round deterministically.
    this.handle = this.timers.setTimeout(() => this.fire(trigger), Math.max(0, delayMs))
  }

  private cancel(): void {
    if (this.handle !== undefined) {
      this.timers.clearTimeout(this.handle)
      this.handle = undefined
    }
  }

  private armFromConfig(): void {
    const cfg = this.config()
    if (!cfg.enabled) return
    if (this.streak > 0) {
      this.arm(goBackoffDelayMs(this.streak, this.lastFailureKind), 'backoff')
    } else {
      this.arm(clampGoIntervalMinutes(cfg.intervalMinutes) * 60_000, 'interval')
    }
  }

  private async fire(trigger: GoTrigger, adopt = false): Promise<GoScheduledResult> {
    if (this.disposed) return this.skip('disposed', trigger)
    if (!this.config().enabled) return this.skip('disabled', trigger)
    if (this.inFlight) return this.skip('already-in-flight', trigger)

    // The timer that fired is now consumed; a new one is armed after the round.
    this.cancel()
    this.inFlight = true
    let result: GoScheduledResult
    try {
      const raw = await this.runRound({ trigger, adopt })
      if (raw.ok) {
        this.streak = 0
        this.lastFailureKind = undefined
      } else if (isBackoffFailure(raw)) {
        this.streak += 1
        this.lastFailureKind = raw.failureKind
      }
      result = { ...raw, skipped: false }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.streak += 1
      this.lastFailureKind = 'transport'
      result = {
        ok: false,
        reason: 'scheduler-error',
        text: `opencode-go scheduler: round error — ${message}; kept last-good, no further settings write`,
        failureKind: 'transport',
        skipped: false,
      }
    } finally {
      this.inFlight = false
    }

    this.report(result.text)
    if (!this.disposed) this.armFromConfig()
    return result
  }

  private skip(reason: string, trigger: GoTrigger): GoScheduledResult {
    const text = goSchedulerSkipReport(reason, trigger)
    this.report(text)
    return { ok: false, reason, text, skipped: true }
  }
}
