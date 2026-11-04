/**
 * Live trades for a set of coins from PumpPortal's data websocket (`subscribeTokenTrade`), the same socket Pulse
 * uses. The agent opens it only while a dev-sell order is open, subscribed to just those coins, and closes it when
 * none are left. Reconnects with backoff and re-subscribes.
 */
import { endpoints } from "../endpoints.js";
import type { StreamTrade } from "../trade/orders.js";

export class TokenTradeWatcher {
  private ws?: WebSocket;
  private stopped = false;
  private mints = new Set<string>();
  constructor(private onTrade: (t: StreamTrade) => void, private onError?: (e: Error) => void) {}

  get watching(): string[] { return [...this.mints]; }

  /** Watch exactly these coins (subscribes the new ones, unsubscribes the rest). */
  set(mints: string[]) {
    const next = new Set(mints);
    const add = [...next].filter((m) => !this.mints.has(m));
    const drop = [...this.mints].filter((m) => !next.has(m));
    this.mints = next;
    if (this.ws?.readyState === 1) {
      if (add.length) this.ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: add }));
      if (drop.length) this.ws.send(JSON.stringify({ method: "unsubscribeTokenTrade", keys: drop }));
    }
    if (!this.ws && next.size) this.start();
  }

  start() {
    this.stopped = false;
    let backoff = 1000;
    const connect = () => {
      const ws = new WebSocket(endpoints.pumpData());
      this.ws = ws;
      ws.onopen = () => {
        backoff = 1000;
        if (this.mints.size) ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [...this.mints] }));
      };
      ws.onmessage = (ev: MessageEvent) => {
        let m: { txType?: string; mint?: string; traderPublicKey?: string; solAmount?: number; signature?: string };
        try { m = JSON.parse(String(ev.data)); } catch { return; }
        if ((m.txType !== "buy" && m.txType !== "sell") || !m.mint || !m.traderPublicKey || !this.mints.has(m.mint)) return;
        this.onTrade({ mint: m.mint, trader: m.traderPublicKey, side: m.txType, sol: Number(m.solAmount) || 0, signature: m.signature });
      };
      ws.onerror = () => this.onError?.(new Error("Trade feed error"));
      ws.onclose = () => {
        if (this.ws === ws) this.ws = undefined;
        if (this.stopped || !this.mints.size) return;
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      };
    };
    connect();
  }

  stop() {
    this.stopped = true;
    this.mints.clear();
    this.ws?.close();
    this.ws = undefined;
  }
}
