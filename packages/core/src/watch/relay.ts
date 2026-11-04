/**
 * Vesk Relay: one X filtered stream that Vesk runs server-side with its own X API key, fanned out to
 * $VESK holders' panels and agents over Supabase Realtime (a private broadcast channel).
 *
 * Why: sharing one person's X key or a third-party tracker login between many users breaks those services'
 * terms. The relay is Vesk's own developer account, on a paid X API tier that Vesk pays for. It carries:
 *   - a curated list of popular accounts, and
 *   - accounts holders ask for (up to RELAY_MAX_PER_USER each, deduped across everyone).
 *
 * How the agent connects:
 *   1. `relay-token` on the panel function (agent token header) returns a short-lived JWT, the Realtime
 *      websocket URL and the account list. It is refused when holder access is removed.
 *   2. The agent joins the private channel `relay` (Phoenix protocol, vsn 1.0.0) and filters posts to the
 *      accounts it watches. The token is refreshed before it expires.
 *   3. `relay-subscribe` asks the relay to carry the accounts in this agent's rules and groups. Accounts beyond
 *      the per-user cap, or beyond the relay's total rule budget, are reported back as not carried.
 *
 * Limits are real: X API tiers cap the number of stream rules and posts per month. When the relay is full,
 * bring your own X key (`x.source: official-api`) or a provider webhook.
 */
import type { XPost } from "../types.js";
import type { XWatcher } from "./x.js";

import { RELAY_TOPIC, type RelaySubscribeResult, type RelayTicket } from "./relayPlan.js";
export * from "./relayPlan.js";

type PanelCall = <T>(action: string, body: Record<string, unknown>) => Promise<T>;

/** Phoenix message (Realtime vsn 1.0.0 is JSON objects). */
interface PhxMsg {
  topic: string;
  event: string;
  payload: Record<string, unknown>;
  ref: string | null;
}

/** Minimal WebSocket shape (Node 22's global WebSocket, or a browser's). */
interface WS {
  readyState: number;
  send(d: string): void;
  close(): void;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

export class RelayWatcher implements XWatcher {
  readonly name = "vesk-relay";
  private ws?: WS;
  private handles = new Set<string>();
  private ticket?: RelayTicket;
  private ref = 0;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private stopped = false;
  private backoff = 1000;
  /** Last subscribe result, for `vesk tracker source` and the panel. */
  lastSubscribe?: RelaySubscribeResult;

  constructor(private call: PanelCall, private makeSocket: (url: string) => WS = (u) => new (globalThis as unknown as { WebSocket: new (u: string) => WS }).WebSocket(u)) {}

  async setHandles(h: string[]) {
    this.handles = new Set(h.map((x) => x.replace(/^@/, "").toLowerCase()));
    this.lastSubscribe = await this.call<RelaySubscribeResult>("relay-subscribe", { handles: [...this.handles] });
  }

  private nextRef() {
    return String(++this.ref);
  }

  private send(m: PhxMsg) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  async start(onPost: (p: XPost) => void, onError?: (e: Error) => void) {
    this.stopped = false;
    const connect = async () => {
      if (this.stopped) return;
      try {
        this.ticket = await this.call<RelayTicket>("relay-token", {});
      } catch (e) {
        onError?.(new Error(`Relay: ${(e as Error).message}`));
        return void setTimeout(connect, (this.backoff = Math.min(this.backoff * 2, 60_000)));
      }
      const url = `${this.ticket.wsUrl}?apikey=${encodeURIComponent(this.ticket.apikey)}&vsn=1.0.0`;
      const ws = this.makeSocket(url);
      this.ws = ws;
      const topic = `realtime:${RELAY_TOPIC}`;
      ws.onopen = () => {
        this.backoff = 1000;
        this.send({ topic, event: "phx_join", ref: this.nextRef(), payload: { config: { broadcast: { self: false, ack: false }, presence: { key: "" }, private: true }, access_token: this.ticket!.token } });
      };
      ws.onmessage = (ev) => {
        let m: PhxMsg;
        try {
          m = JSON.parse(String(ev.data)) as PhxMsg;
        } catch {
          return;
        }
        if (m.event === "phx_reply" && (m.payload as { status?: string }).status === "error") {
          onError?.(new Error(`Relay refused the join: ${JSON.stringify((m.payload as { response?: unknown }).response ?? {})}`));
          return;
        }
        if (m.event !== "broadcast") return;
        const b = m.payload as { event?: string; payload?: XPost };
        if (b.event !== "post" || !b.payload) return;
        const p = b.payload;
        const handle = String(p.handle ?? "").replace(/^@/, "").toLowerCase();
        if (!this.handles.has(handle)) return;
        onPost({ ...p, handle, urls: p.urls ?? [], createdAt: p.createdAt ?? new Date().toISOString() });
      };
      ws.onerror = () => onError?.(new Error("Relay connection error"));
      ws.onclose = () => {
        this.timers.forEach(clearInterval);
        this.timers = [];
        if (this.stopped) return;
        setTimeout(connect, this.backoff);
        this.backoff = Math.min(this.backoff * 2, 60_000);
      };
      this.timers.push(setInterval(() => this.send({ topic: "phoenix", event: "heartbeat", payload: {}, ref: this.nextRef() }), 25_000));
      // Refresh the JWT a minute before it expires, without reconnecting.
      this.timers.push(setInterval(async () => {
        if (!this.ticket || this.ticket.expiresAt - Date.now() > 60_000) return;
        try {
          this.ticket = await this.call<RelayTicket>("relay-token", {});
          this.send({ topic, event: "access_token", payload: { access_token: this.ticket.token }, ref: this.nextRef() });
        } catch (e) {
          onError?.(new Error(`Relay token refresh: ${(e as Error).message}`));
        }
      }, 15_000));
    };
    await connect();
  }

  async stop() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.ws?.close();
  }
}
