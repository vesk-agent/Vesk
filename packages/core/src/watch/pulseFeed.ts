/**
 * Pulse for the agent and the CLI (`vesk pulse`): PumpPortal's data websocket → the shared reducer.
 * Metadata (image, socials) is fetched from each coin's URI, a few at a time. Reconnects with backoff.
 */
import { endpoints } from "../endpoints.js";
import { applyPulse, emptyPulse, prunePulse, PULSE_SUBSCRIBE, tradeSubscribe, tradeUnsubscribe, withMetadata, type PulseMessage, type PulseState } from "./pulse.js";

export class PulseFeed {
  readonly state: PulseState = emptyPulse();
  private ws?: WebSocket;
  private stopped = false;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private pending: string[] = [];
  /** v20: coins we hold that the feed didn't see created: their trades are subscribed and passed on too. */
  private extra = new Set<string>();

  /** onMessage (v19): every raw message after it's applied (the strategy keeps its own per-coin trade ticks). */
  constructor(private o: { onChange?: (mint: string, isNew: boolean) => void; onError?: (e: Error) => void; metadata?: boolean; onMessage?: (m: PulseMessage, isNew: boolean) => void } = {}) {}

  start() {
    this.stopped = false;
    let backoff = 1000;
    const connect = () => {
      const ws = new WebSocket(endpoints.pumpData());
      this.ws = ws;
      ws.onopen = () => {
        backoff = 1000;
        for (const m of PULSE_SUBSCRIBE) ws.send(JSON.stringify(m));
        const known = [...new Set([...Object.keys(this.state.tokens), ...this.extra])];
        if (known.length) ws.send(JSON.stringify(tradeSubscribe(known)));
      };
      ws.onmessage = (ev: MessageEvent) => {
        let m: PulseMessage;
        try { m = JSON.parse(String(ev.data)); } catch { return; }
        const r = applyPulse(this.state, m);
        if (!r.changed) {
          if (m.mint && this.extra.has(m.mint) && (m.txType === "buy" || m.txType === "sell")) this.o.onMessage?.(m, false);
          return;
        }
        this.o.onMessage?.(m, !!r.isNew);
        if (r.isNew && m.txType === "create") {
          this.pending.push(r.changed);
          if (this.o.metadata !== false) void this.meta(r.changed);
        }
        this.o.onChange?.(r.changed, !!r.isNew);
      };
      ws.onerror = () => this.o.onError?.(new Error("Pulse feed error"));
      ws.onclose = () => {
        if (this.stopped) return;
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      };
    };
    connect();
    this.timers.push(setInterval(() => {
      if (this.ws?.readyState === 1 && this.pending.length) this.ws.send(JSON.stringify(tradeSubscribe(this.pending.splice(0))));
    }, 1000));
    this.timers.push(setInterval(() => {
      const gone = prunePulse(this.state);
      if (gone.length && this.ws?.readyState === 1) this.ws.send(JSON.stringify(tradeUnsubscribe(gone)));
    }, 30_000));
  }

  /** v20: also follow trades on these coins (positions held from before the feed started). */
  watchMints(mints: string[]): void {
    const add = mints.filter((m) => !this.extra.has(m) && !this.state.tokens[m]);
    for (const m of add) this.extra.add(m);
    if (add.length && this.ws?.readyState === 1) this.ws.send(JSON.stringify(tradeSubscribe(add)));
  }

  private async meta(mint: string) {
    const t = this.state.tokens[mint];
    if (!t?.uri || !/^https?:\/\//.test(t.uri)) return;
    try {
      const r = await fetch(t.uri, { signal: AbortSignal.timeout(4000) });
      const j = (await r.json()) as Record<string, string>;
      const tok = this.state.tokens[mint];
      if (tok) { withMetadata(tok, j, this.state); this.o.onChange?.(mint, false); }
    } catch { /* no metadata */ }
  }

  stop() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.ws?.close();
  }
}
