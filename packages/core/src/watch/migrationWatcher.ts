/**
 * Listens to PumpPortal's `subscribeMigration` stream (the same data websocket Pulse uses) and calls back for every
 * migration. Reconnects with backoff. Used by the agent (armed migration orders) and `vesk migration watch`.
 */
import { endpoints } from "../endpoints.js";
import type { MigrationEvent } from "./migration.js";

export class MigrationWatcher {
  private ws?: WebSocket;
  private stopped = false;
  constructor(private onMigration: (e: MigrationEvent) => void, private onError?: (e: Error) => void) {}

  start() {
    this.stopped = false;
    let backoff = 1000;
    const connect = () => {
      const ws = new WebSocket(endpoints.pumpData());
      this.ws = ws;
      ws.onopen = () => { backoff = 1000; ws.send(JSON.stringify({ method: "subscribeMigration" })); };
      ws.onmessage = (ev: MessageEvent) => {
        let m: { txType?: string; mint?: string; pool?: string; signature?: string };
        try { m = JSON.parse(String(ev.data)); } catch { return; }
        if ((m.txType === "migrate" || m.txType === "migration") && m.mint) this.onMigration({ mint: m.mint, pool: m.pool, signature: m.signature });
      };
      ws.onerror = () => this.onError?.(new Error("Migration feed error"));
      ws.onclose = () => {
        if (this.stopped) return;
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      };
    };
    connect();
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }
}
