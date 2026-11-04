/**
 * v26: every pump.fun create, for launch-on-post: the ticker clash check, the race report and pair discovery.
 * PumpPortal's subscribeNewToken; each create's metadata (website / twitter, from its uri) is read in the background
 * so post-link matches work a moment later; the coin's image URL is kept too, and hashed only when a clash check needs it. The quote mint, when the message carries one, feeds pair discovery.
 */
import { endpoints } from "../endpoints.js";
import { CreateFeed } from "../launch/clash.js";
import { quoteMintOf } from "../launch/discovery.js";

export class CreateStream {
  readonly feed = new CreateFeed(30 * 60_000);
  private ws?: WebSocket;
  private stopped = false;
  /** v26: trades of coins with a no-volume exit (subscribeTokenTrade on the same socket), from when tracking began */
  private trades = new Map<string, { since: number; ticks: Array<{ at: number; sol: number }> }>();
  /** since when the stream has been connected without a gap (for "complete" race reports) */
  connectedSince: number | null = null;
  constructor(private o: { onQuote?: (m: Record<string, unknown>) => void; fetch?: typeof fetch } = {}) {}

  start() {
    this.stopped = false;
    let backoff = 1000;
    const connect = () => {
      const ws = new WebSocket(endpoints.pumpData());
      this.ws = ws;
      ws.onopen = () => {
        backoff = 1000; this.connectedSince = Date.now();
        ws.send(JSON.stringify({ method: "subscribeNewToken" }));
        // a reconnect leaves a gap: measure each tracked coin's window again from now
        if (this.trades.size) { for (const t of this.trades.values()) { t.since = Date.now(); t.ticks = []; } ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [...this.trades.keys()] })); }
      };
      ws.onmessage = (ev: MessageEvent) => {
        let m: Record<string, unknown>;
        try { m = JSON.parse(String(ev.data)); } catch { return; }
        if ((m.txType === "buy" || m.txType === "sell") && typeof m.mint === "string") {
          const t = this.trades.get(m.mint);
          if (t) { t.ticks.push({ at: Date.now(), sol: Number(m.solAmount ?? 0) || 0 }); if (t.ticks.length > 5000) t.ticks.splice(0, t.ticks.length - 5000); }
          return;
        }
        if (m.txType !== "create" || typeof m.mint !== "string") return;
        const mint = m.mint;
        this.feed.add({ mint, name: String(m.name ?? ""), symbol: String(m.symbol ?? ""), at: Date.now(), creator: typeof m.traderPublicKey === "string" ? m.traderPublicKey : undefined, quoteMint: quoteMintOf(m) ?? undefined });
        this.o.onQuote?.(m);
        if (typeof m.uri === "string" && /^https?:\/\//.test(m.uri)) {
          void (this.o.fetch ?? fetch)(m.uri, { signal: AbortSignal.timeout(2500) }).then((r) => (r.ok ? r.json() : null)).then((j: { website?: string; twitter?: string; image?: string } | null) => {
            if (j) this.feed.update(mint, { website: typeof j.website === "string" ? j.website : undefined, twitter: typeof j.twitter === "string" ? j.twitter : undefined, imageUrl: typeof j.image === "string" && /^https:\/\//.test(j.image) ? j.image : undefined });
          }).catch(() => undefined);
        }
      };
      ws.onclose = () => {
        this.connectedSince = null;
        if (this.stopped) return;
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      };
      ws.onerror = () => undefined;
    };
    connect();
  }

  /** Start counting a coin's trades (idempotent). */
  trackTrades(mint: string) {
    if (this.trades.has(mint)) return;
    this.trades.set(mint, { since: Date.now(), ticks: [] });
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mint] }));
  }
  untrackTrades(mint: string) {
    if (!this.trades.delete(mint)) return;
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ method: "unsubscribeTokenTrade", keys: [mint] }));
  }
  /** SOL traded in the last `windowSec`, or undefined until the stream has watched the coin for that long. */
  volume(mint: string, windowSec: number, now = Date.now()): number | undefined {
    const t = this.trades.get(mint);
    if (!t || now - t.since < windowSec * 1000) return undefined;
    const from = now - windowSec * 1000;
    return Math.round(t.ticks.reduce((a, x) => (x.at >= from ? a + x.sol : a), 0) * 100) / 100;
  }
  /** Feed a message by hand (tests). */
  ingestTrade(mint: string, sol: number, at = Date.now()) { this.trades.get(mint)?.ticks.push({ at, sol }); }

  stop() { this.stopped = true; this.ws?.close(); }
}
