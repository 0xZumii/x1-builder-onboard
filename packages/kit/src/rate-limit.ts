import { PUBLIC_LIMITS, type Limits } from "./constants.js";

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * Counts events inside a rolling window.
 *
 * The public X1 RPC caps requests per 5s and per hour, so a plain
 * "requests per second" counter is not enough. This mirrors the docs exactly.
 */
class SlidingWindow {
  private stamps: number[] = [];

  constructor(
    public windowMs: number,
    public cap: number,
  ) {}

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    let drop = 0;
    while (drop < this.stamps.length && this.stamps[drop]! <= cutoff) drop += 1;
    if (drop > 0) this.stamps.splice(0, drop);
  }

  /** How long until this window has room again. 0 means "go now". */
  waitMs(now: number): number {
    this.prune(now);
    if (this.stamps.length < this.cap) return 0;
    // The event at `length - cap` is the one that has to age out first.
    const blocker = this.stamps[this.stamps.length - this.cap]!;
    return Math.max(1, blocker + this.windowMs - now + 1);
  }

  record(now: number): void {
    this.stamps.push(now);
  }

  count(now: number): number {
    this.prune(now);
    return this.stamps.length;
  }
}

export interface ThrottleStats {
  inFlight: number;
  queued: number;
  pausedForMs: number;
  disabled: boolean;
  short: number;
  long: number;
  heavy: number;
  limits: Limits;
}

/**
 * Client-side admission control for an RPC endpoint.
 *
 * Three jobs:
 *  1. never exceed the documented windows,
 *  2. cap concurrent connections,
 *  3. honour a server-wide pause after a 429 so every in-flight caller
 *     backs off together instead of hammering the endpoint.
 */
export class Throttle {
  readonly limits: Limits;
  /** Skip all admission control (private or local endpoints). */
  disabled = false;
  /** Set when the caller chose maxConcurrent explicitly, so adoption leaves it alone. */
  pinnedConcurrency = false;
  private readonly short: SlidingWindow;
  private readonly long: SlidingWindow;
  private readonly heavy: SlidingWindow;
  private active = 0;
  private waiters: Array<() => void> = [];
  private pausedUntil = 0;

  constructor(limits: Partial<Limits> | Limits = PUBLIC_LIMITS) {
    this.limits = { ...PUBLIC_LIMITS, ...limits };
    this.short = new SlidingWindow(this.limits.shortWindowMs, this.limits.shortCap);
    this.long = new SlidingWindow(this.limits.longWindowMs, this.limits.longCap);
    this.heavy = new SlidingWindow(this.limits.heavyWindowMs, this.limits.heavyCap);
  }

  /** Reserve a slot. Always call the returned release function. */
  async acquire(isHeavy: boolean): Promise<() => void> {
    if (this.disabled) return () => {};

    await this.acquireConnection();

    try {
      for (;;) {
        const now = Date.now();

        if (now < this.pausedUntil) {
          await sleep(this.pausedUntil - now);
          continue;
        }

        const waits = [this.short.waitMs(now), this.long.waitMs(now)];
        if (isHeavy) waits.push(this.heavy.waitMs(now));

        const wait = Math.max(...waits);
        if (wait > 0) {
          await sleep(wait);
          continue;
        }

        // No awaits between the check and the record, so this is atomic
        // with respect to other callers on the same event loop turn.
        this.short.record(now);
        this.long.record(now);
        if (isHeavy) this.heavy.record(now);
        return () => this.releaseConnection();
      }
    } catch (error) {
      this.releaseConnection();
      throw error;
    }
  }

  /** Pause every caller. Used when the endpoint answers 429. */
  pauseFor(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }

  /**
   * React to a 429 by shrinking the connection pool.
   *
   * The 429 test showed the connection cap binding well before the request
   * cap, so when we do get throttled, concurrency is the thing to reduce.
   * It never shrinks below 1, and the next successful response cannot
   * accidentally raise it above what the endpoint advertises.
   */
  penalize(): void {
    if (this.limits.maxConcurrent <= 1) return;
    this.limits.maxConcurrent = Math.max(1, Math.floor(this.limits.maxConcurrent / 2));
  }

  /**
   * Adopt the limits the endpoint advertises in its `X-RateLimit-*` headers.
   *
   * The documented numbers are not universal: mainnet allows 300 requests per
   * 5s and 30 connections, while testnet allows 400 per 5s but only 15
   * connections, and does not publish an hourly cap at all. Trusting the
   * headers is the only way to stay correct on both.
   *
   * Returns true when anything changed.
   */
  adopt(limits: Partial<Limits>): boolean {
    let changed = false;

    const positive = (value: number | undefined): value is number =>
      typeof value === "number" && Number.isFinite(value) && value > 0;

    if (positive(limits.shortCap) && limits.shortCap !== this.limits.shortCap) {
      this.limits.shortCap = limits.shortCap;
      this.short.cap = limits.shortCap;
      changed = true;
    }
    if (positive(limits.heavyCap) && limits.heavyCap !== this.limits.heavyCap) {
      this.limits.heavyCap = limits.heavyCap;
      this.heavy.cap = limits.heavyCap;
      changed = true;
    }
    if (positive(limits.longCap) && limits.longCap !== this.limits.longCap) {
      this.limits.longCap = limits.longCap;
      this.long.cap = limits.longCap;
      changed = true;
    }
    if (positive(limits.maxConcurrent) && limits.maxConcurrent !== this.limits.maxConcurrent) {
      // An explicit choice from the caller outranks the endpoint's advice.
      if (!this.pinnedConcurrency) {
        this.limits.maxConcurrent = limits.maxConcurrent;
        changed = true;
      }
    }    if (positive(limits.shortWindowMs) && limits.shortWindowMs !== this.limits.shortWindowMs) {
      this.limits.shortWindowMs = limits.shortWindowMs;
      this.short.windowMs = limits.shortWindowMs;
      changed = true;
    }
    if (positive(limits.heavyWindowMs) && limits.heavyWindowMs !== this.limits.heavyWindowMs) {
      this.limits.heavyWindowMs = limits.heavyWindowMs;
      this.heavy.windowMs = limits.heavyWindowMs;
      changed = true;
    }

    return changed;
  }

  stats(): ThrottleStats {
    const now = Date.now();
    return {
      inFlight: this.active,
      queued: this.waiters.length,
      pausedForMs: Math.max(0, this.pausedUntil - now),
      disabled: this.disabled,
      short: this.short.count(now),
      long: this.long.count(now),
      heavy: this.heavy.count(now),
      limits: this.limits,
    };
  }

  private acquireConnection(): Promise<void> {
    if (this.active < this.limits.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    // The slot already exists; the release path hands it directly to us.
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private releaseConnection(): void {
    const next = this.waiters.shift();
    if (next) {
      // Transfer the slot. `active` is unchanged: this release and that
      // acquire are the same slot changing hands. Incrementing here is what
      // caused the pool to shrink itself to a standstill.
      next();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}
