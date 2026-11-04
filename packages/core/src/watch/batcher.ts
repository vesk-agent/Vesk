/**
 * Performance profiles for live boards (Pulse, the tracker): how often the UI re-renders, how websocket messages are
 * batched, how many rows are kept mounted, whether things animate, and how often ages and numbers refresh.
 * `Batcher` is the piece the Pulse store uses: messages are applied to state immediately (cheap), and the UI is
 * told at most once per `flushMs` (or every message on Full speed).
 */
export type PerfProfile = "low" | "auto" | "full";

export interface PerfParams {
  /** Minimum ms between UI updates. 0 = every message. */
  flushMs: number;
  /** ms between trade-subscription batches sent to the websocket. */
  subscribeMs: number;
  /** Rows rendered beyond the visible ones (virtualized lists). */
  overscan: number;
  /** Rows kept per column before older ones are dropped from the list. */
  maxRows: number;
  /** Ages ("4s", "2m") and counters refresh at most this often. */
  clockMs: number;
  animate: boolean;
}

export const PERF: Record<PerfProfile, PerfParams> = {
  low: { flushMs: 1000, subscribeMs: 2000, overscan: 2, maxRows: 150, clockMs: 5000, animate: false },
  auto: { flushMs: 250, subscribeMs: 1000, overscan: 6, maxRows: 400, clockMs: 1000, animate: true },
  full: { flushMs: 0, subscribeMs: 500, overscan: 12, maxRows: 1000, clockMs: 500, animate: true },
};

/**
 * Auto adapts: when messages arrive faster than ~40/s it backs off to Low's flush interval, and returns to 250 ms
 * when things calm down. `rate` is messages per second over the last window.
 */
export function perfParams(p: PerfProfile, rate = 0): PerfParams {
  if (p !== "auto") return PERF[p];
  return rate > 40 ? { ...PERF.auto, flushMs: PERF.low.flushMs } : PERF.auto;
}

/** Counts messages and tells the caller when to flush. Pure: the clock is passed in. */
export class Batcher {
  private dirty = 0;
  private last = -Infinity;
  private window: number[] = [];
  constructor(public profile: PerfProfile = "auto") {}

  /** A message changed the state. Returns true if the UI should update now (Full speed, or the interval passed). */
  push(now: number): boolean {
    this.dirty++;
    this.window.push(now);
    while (this.window.length && now - this.window[0] > 1000) this.window.shift();
    return this.due(now);
  }

  /** Messages per second over the last second. */
  rate(): number {
    return this.window.length;
  }

  /** Called on a timer and after each push: flush if anything changed and the interval passed. */
  due(now: number): boolean {
    if (!this.dirty) return false;
    const p = perfParams(this.profile, this.rate());
    if (p.flushMs === 0 || now - this.last >= p.flushMs) {
      this.dirty = 0;
      this.last = now;
      return true;
    }
    return false;
  }

  pending(): number {
    return this.dirty;
  }
}
