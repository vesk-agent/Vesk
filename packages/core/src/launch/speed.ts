/**
 * The "first to launch" path: measure every step from post received to landed, and keep connections warm.
 * Nothing here makes speed claims. It records what actually happened on your setup.
 */
export type SpeedMark = "received" | "drafted" | "clash" | "image" | "metadata" | "built" | "sent" | "landed";

export class Timeline {
  readonly t0: number;
  readonly marks: Array<{ mark: SpeedMark; ms: number }> = [];
  constructor(receivedAt = Date.now()) {
    this.t0 = receivedAt;
    this.marks.push({ mark: "received", ms: 0 });
  }
  mark(m: SpeedMark, at = Date.now()) {
    this.marks.push({ mark: m, ms: Math.max(0, at - this.t0) });
    return this;
  }
  get total() {
    return this.marks[this.marks.length - 1].ms;
  }
  toString() {
    return this.marks.map((x) => `${x.mark} +${x.ms} ms`).join(" → ");
  }
}

/** Keeps TCP/TLS connections to the launch path warm (PumpPortal, Jito, your RPC). Cheap HEAD/GET pings. */
export function keepWarm(urls: string[], everyMs = 30_000): () => void {
  const ping = () => urls.forEach((u) => void fetch(u, { method: "HEAD", signal: AbortSignal.timeout(5000) }).catch(() => undefined));
  ping();
  const t = setInterval(ping, everyMs);
  return () => clearInterval(t);
}
