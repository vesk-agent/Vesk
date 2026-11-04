/**
 * Parallel lanes (v20): a bounded work queue with a pool per kind of work.
 *
 *   trade / copy / rogue   share `lanes` slots (1–5): buys being checked, signed and sent at the same time
 *   launch                 its own `launches` slots (1–3)
 *
 * More work waits in order (FIFO per pool) up to `maxQueued`; past that it's refused with a reason, so a burst can't
 * build an unbounded backlog. Sells never go through here: exits never wait behind buys.
 *
 * The queue only decides WHEN work runs. Limits are still the guardrails' job, and under concurrency they count the
 * buys other lanes have in flight (work/reserve.ts), so parallel lanes can't overshoot a cap or buy one coin twice.
 */
export type LaneKind = "trade" | "copy" | "rogue" | "launch";
import type { Concurrency } from "../strategy/settings.js";
export interface WorkStats { lanes: number; launches: number; inFlight: Record<LaneKind, number>; busy: number; queued: number }

export class QueueFull extends Error {
  constructor(public kind: LaneKind, max: number) { super(`${max} already waiting for a free lane. Not queued.`); }
}

const pool = (k: LaneKind) => (k === "launch" ? "launch" : "lanes");

export class WorkQueue {
  readonly inFlight: Record<LaneKind, number> = { trade: 0, copy: 0, rogue: 0, launch: 0 };
  private waiting: Array<{ kind: LaneKind; go: () => void }> = [];
  constructor(private limits: () => Concurrency, private maxQueued = 20) {}

  private used(p: "lanes" | "launch") { return p === "launch" ? this.inFlight.launch : this.inFlight.trade + this.inFlight.copy + this.inFlight.rogue; }
  private cap(p: "lanes" | "launch") { const l = this.limits(); return Math.max(1, Math.round(p === "launch" ? l.launches : l.lanes)); }
  private free(k: LaneKind) { const p = pool(k); return this.used(p) < this.cap(p); }

  /** Would work of this kind wait right now? */
  wouldWait(kind: LaneKind): boolean { return !this.free(kind) || this.waiting.some((w) => pool(w.kind) === pool(kind)); }

  /** Run `fn` when a lane of its kind is free. */
  run<T>(kind: LaneKind, fn: () => Promise<T>): Promise<T> {
    const start = (): Promise<T> => {
      this.inFlight[kind]++;
      return fn().finally(() => { this.inFlight[kind]--; this.pump(); });
    };
    if (this.free(kind) && !this.waiting.some((w) => pool(w.kind) === pool(kind))) return start();
    if (this.waiting.length >= this.maxQueued) return Promise.reject(new QueueFull(kind, this.maxQueued));
    return new Promise<T>((resolve, reject) => { this.waiting.push({ kind, go: () => { start().then(resolve, reject); } }); });
  }

  private pump() {
    for (let i = 0; i < this.waiting.length;) {
      const w = this.waiting[i];
      if (this.free(w.kind)) { this.waiting.splice(i, 1); w.go(); } else i++;
    }
  }

  stats(): WorkStats {
    const l = this.limits();
    return { lanes: this.cap("lanes"), launches: Math.max(1, Math.round(l.launches)), inFlight: { ...this.inFlight }, busy: this.used("lanes") + this.used("launch"), queued: this.waiting.length };
  }
}
