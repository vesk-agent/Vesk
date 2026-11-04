/**
 * Watches your RPC's websocket for new pools on the programs in data/programs.ts (logsSubscribe, one subscription
 * per program), then reads the transaction to find the new coin. Feeds `vesk pulse --pools`.
 * Costs one websocket and a getTransaction per new pool; busy programs (Raydium, Orca) produce a lot of logs, so
 * pick the protocols you need.
 */
import type { Rpc } from "../rpc.js";
import type { PoolProgram } from "../data/programs.js";
import { POOL_PROGRAMS } from "../data/programs.js";
import { detectNewPool, logsSubscribe, newPoolMint } from "./pools.js";

export interface NewPool { protocol: PoolProgram["protocol"]; program: string; mint: string; quote?: string; signature: string; at: number }

export class PoolWatcher {
  private ws?: WebSocket;
  private stopped = false;
  private seen = new Set<string>();
  constructor(private rpc: Rpc, private onPool: (p: NewPool) => void, private o: { protocols?: string[]; onError?: (e: Error) => void } = {}) {}

  programs(): PoolProgram[] {
    return POOL_PROGRAMS.filter((p) => !this.o.protocols?.length || this.o.protocols.includes(p.protocol));
  }

  start() {
    if (!this.rpc.wsUrl) { this.o.onError?.(new Error("New-pool detection needs your RPC's websocket (rpc.wsUrl).")); return; }
    this.stopped = false;
    let backoff = 1000;
    const progs = this.programs();
    const connect = () => {
      const ws = new WebSocket(this.rpc.wsUrl!);
      this.ws = ws;
      ws.onopen = () => { backoff = 1000; progs.forEach((p, i) => ws.send(JSON.stringify(logsSubscribe(i + 1, p.id)))); };
      ws.onmessage = (ev: MessageEvent) => {
        let m: { method?: string; params?: { result?: { value?: { signature?: string; err?: unknown; logs?: string[] } } } };
        try { m = JSON.parse(String(ev.data)); } catch { return; }
        const v = m.method === "logsNotification" ? m.params?.result?.value : undefined;
        if (!v?.signature || v.err || this.seen.has(v.signature)) return;
        const hit = detectNewPool(v.logs ?? [], progs);
        if (!hit) return;
        this.seen.add(v.signature);
        if (this.seen.size > 5000) this.seen.clear();
        void this.rpc.call<unknown>("getTransaction", [v.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }])
          .then((tx) => { const c = newPoolMint(tx); if (c) this.onPool({ protocol: hit.program.protocol, program: hit.program.name, mint: c.mint, quote: c.quote, signature: v.signature!, at: Date.now() }); })
          .catch((e: Error) => this.o.onError?.(e));
      };
      ws.onerror = () => this.o.onError?.(new Error("RPC websocket error (new pools)"));
      ws.onclose = () => { if (!this.stopped) { setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 30_000); } };
    };
    connect();
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }
}
