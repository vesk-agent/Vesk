/**
 * Detecting trades by the wallets you copy. Several sources can run at once; the first to deliver a signature wins
 * and the others skip it (SigDedupe), so the fastest path decides the latency.
 *
 *  - PumpPortal `subscribeAccountTrade` (PumpPortal's data websocket): pump.fun curve, PumpSwap and Bonk trades,
 *    already parsed. Usually the quickest for those venues. One websocket for every wallet.
 *  - Your RPC websocket: `logsSubscribe` with `mentions: [wallet]` (one subscription per wallet, the RPC method takes
 *    one address), then `getTransaction` (jsonParsed, maxSupportedTransactionVersion 0) and classifyTx. Sees every
 *    venue (Jupiter routes, Raydium, Meteora, Orca…), costs one getTransaction per trade. Wallets are spread over
 *    several sockets (RPC_WALLETS_PER_SOCKET each) because providers cap subscriptions per connection.
 *  - Helius enhanced websocket `transactionSubscribe` (accountInclude = your wallets): the full parsed transaction
 *    arrives with the notification, so there is no getTransaction round trip. Built to Helius's documented message
 *    format; Vesk's tests run it against a mock, not a live Helius endpoint.
 *  - Yellowstone gRPC (Geyser): NOT built in. It needs a gRPC client; plug one in by implementing DetectionSource
 *    (see docs/27-copy-trading.md). `createAdapter("yellowstone")` says so instead of pretending.
 *
 * Every socket reconnects with exponential backoff (1 s → 30 s) and resubscribes.
 */
import { endpoints } from "../endpoints.js";
import type { Rpc } from "../rpc.js";
import { classifyTx, fromPumpPortal, type AccountTradeMsg, type DetectSource, type ParsedTx, type TargetTrade } from "./classify.js";
import { SigDedupe } from "./engine.js";
import { BRAND } from "../brand.js";

export interface SourceStatus { name: DetectSource; connected: boolean; wallets: number; reconnects: number; lastMessageAt?: number; error?: string; note?: string }

export interface DetectionSource {
  readonly name: DetectSource;
  start(wallets: string[]): void;
  setWallets(wallets: string[]): void;
  stop(): void;
  status(): SourceStatus;
}

type Emit = (t: TargetTrade) => void;
type OnError = (e: Error) => void;
const BACKOFF_MAX = 30_000;
export const RPC_WALLETS_PER_SOCKET = 100;
export const PUMP_KEYS_PER_MESSAGE = 500;

const chunks = <T>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A websocket that reconnects with backoff and calls `onOpen` after every (re)connect. */
class Socket {
  ws?: WebSocket;
  connected = false;
  reconnects = 0;
  lastMessageAt?: number;
  private stopped = false;
  private backoff = 1000;
  constructor(private url: string, private h: { onOpen: (ws: WebSocket) => void; onMessage: (data: string) => void; onError?: OnError; label: string }) {}
  start() {
    this.stopped = false;
    const connect = () => {
      let ws: WebSocket;
      try { ws = new WebSocket(this.url); } catch (e) { this.h.onError?.(e as Error); return this.retry(connect); }
      this.ws = ws;
      ws.onopen = () => { this.connected = true; this.backoff = 1000; this.h.onOpen(ws); };
      ws.onmessage = (ev: MessageEvent) => { this.lastMessageAt = Date.now(); this.h.onMessage(String(ev.data)); };
      ws.onerror = () => this.h.onError?.(new Error(`${this.h.label}: websocket error`));
      ws.onclose = () => { this.connected = false; if (!this.stopped) { this.reconnects++; this.retry(connect); } };
    };
    connect();
  }
  private retry(connect: () => void) {
    if (this.stopped) return;
    setTimeout(connect, this.backoff);
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX);
  }
  send(m: unknown) { if (this.ws && this.connected) this.ws.send(JSON.stringify(m)); }
  stop() { this.stopped = true; this.connected = false; try { this.ws?.close(); } catch { /* closed */ } }
}

/** PumpPortal subscribeAccountTrade for all wallets on one websocket. */
export class PumpPortalAccountSource implements DetectionSource {
  readonly name = "pumpportal" as const;
  private wallets = new Set<string>();
  private sock?: Socket;
  constructor(private emit: Emit, private onError?: OnError, private url = () => endpoints.pumpData()) {}
  start(wallets: string[]) {
    this.wallets = new Set(wallets);
    this.sock = new Socket(this.url(), {
      label: "PumpPortal account trades",
      onOpen: () => { for (const c of chunks([...this.wallets], PUMP_KEYS_PER_MESSAGE)) this.sock!.send({ method: "subscribeAccountTrade", keys: c }); },
      onMessage: (d) => {
        let m: AccountTradeMsg;
        try { m = JSON.parse(d); } catch { return; }
        if (!m.traderPublicKey || !this.wallets.has(m.traderPublicKey)) return;
        const t = fromPumpPortal(m, Date.now());
        if (t) this.emit(t);
      },
      onError: this.onError,
    });
    this.sock.start();
  }
  setWallets(wallets: string[]) {
    const next = new Set(wallets);
    const add = wallets.filter((w) => !this.wallets.has(w));
    const rm = [...this.wallets].filter((w) => !next.has(w));
    this.wallets = next;
    for (const c of chunks(rm, PUMP_KEYS_PER_MESSAGE)) this.sock?.send({ method: "unsubscribeAccountTrade", keys: c });
    for (const c of chunks(add, PUMP_KEYS_PER_MESSAGE)) this.sock?.send({ method: "subscribeAccountTrade", keys: c });
  }
  stop() { this.sock?.stop(); }
  status(): SourceStatus { return { name: this.name, connected: !!this.sock?.connected, wallets: this.wallets.size, reconnects: this.sock?.reconnects ?? 0, lastMessageAt: this.sock?.lastMessageAt, note: "pump.fun, PumpSwap and Bonk trades" }; }
}

/** Fetch a transaction, retrying while the RPC hasn't indexed it yet (common right after a processed notification). */
export async function fetchTx(rpc: Rpc, signature: string, tries = 8, waitMs = 200): Promise<ParsedTx | null> {
  for (let i = 0; i < tries; i++) {
    const tx = await rpc.call<ParsedTx | null>("getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]).catch(() => null);
    if (tx) return tx;
    await sleep(waitMs * (i + 1));
  }
  return null;
}

/** Your RPC websocket: logsSubscribe mentions per wallet → getTransaction → classify. */
export class RpcLogsSource implements DetectionSource {
  readonly name = "rpc" as const;
  private sockets: Array<{ sock: Socket; wallets: string[]; subs: Map<number, string>; reqs: Map<number, string> }> = [];
  private wallets: string[] = [];
  private lastError?: string;
  constructor(private rpc: Rpc, private emit: Emit, private o: { commitment?: "processed" | "confirmed"; skip?: (sig: string, wallet: string) => boolean; onError?: OnError; perSocket?: number } = {}) {}
  start(wallets: string[]) {
    if (!this.rpc.wsUrl) { this.lastError = "no RPC websocket (rpc.wsUrl)"; this.o.onError?.(new Error("Copy trading over your RPC needs its websocket (rpc.wsUrl).")); return; }
    this.wallets = [...wallets];
    for (const group of chunks(this.wallets, this.o.perSocket ?? RPC_WALLETS_PER_SOCKET)) this.open(group);
  }
  private open(group: string[]) {
    const entry = { sock: undefined as unknown as Socket, wallets: group, subs: new Map<number, string>(), reqs: new Map<number, string>() };
    let id = 0;
    entry.sock = new Socket(this.rpc.wsUrl!, {
      label: "RPC logs (copy)",
      onOpen: () => {
        entry.subs.clear(); entry.reqs.clear();
        for (const w of entry.wallets) { id++; entry.reqs.set(id, w); entry.sock.send({ jsonrpc: "2.0", id, method: "logsSubscribe", params: [{ mentions: [w] }, { commitment: this.o.commitment ?? "confirmed" }] }); }
      },
      onMessage: (d) => {
        let m: { id?: number; result?: unknown; method?: string; params?: { subscription?: number; result?: { value?: { signature?: string; err?: unknown } } } };
        try { m = JSON.parse(d); } catch { return; }
        if (m.id !== undefined && typeof m.result === "number") { const w = entry.reqs.get(m.id); if (w) entry.subs.set(m.result, w); return; }
        if (m.method !== "logsNotification") return;
        const w = entry.subs.get(m.params?.subscription ?? -1);
        const v = m.params?.result?.value;
        if (!w || !v?.signature || v.err) return;
        const at = Date.now();
        if (this.o.skip?.(v.signature, w)) return;
        void fetchTx(this.rpc, v.signature).then((tx) => {
          if (this.o.skip?.(v.signature!, w)) return;
          const c = classifyTx(tx, w, at, "rpc");
          if (c.ok) this.emit(c.trade);
        }).catch((e: Error) => this.o.onError?.(e));
      },
      onError: (e) => { this.lastError = e.message; this.o.onError?.(e); },
    });
    entry.sock.start();
    this.sockets.push(entry);
  }
  setWallets(wallets: string[]) {
    if (wallets.length === this.wallets.length && wallets.every((w, i) => w === this.wallets[i])) return;
    this.stop();
    this.start(wallets);
  }
  stop() { for (const s of this.sockets) s.sock.stop(); this.sockets = []; }
  status(): SourceStatus {
    return {
      name: this.name, connected: this.sockets.length > 0 && this.sockets.every((s) => s.sock.connected), wallets: this.wallets.length,
      reconnects: this.sockets.reduce((a, s) => a + s.sock.reconnects, 0), lastMessageAt: Math.max(0, ...this.sockets.map((s) => s.sock.lastMessageAt ?? 0)) || undefined,
      error: this.lastError, note: `${this.sockets.length} socket${this.sockets.length === 1 ? "" : "s"}, every venue, one getTransaction per trade`,
    };
  }
}

/** Helius enhanced websocket: transactionSubscribe with accountInclude, full jsonParsed transactions pushed. */
export class HeliusSource implements DetectionSource {
  readonly name = "helius" as const;
  private sock?: Socket;
  private wallets = new Set<string>();
  constructor(private url: string, private emit: Emit, private onError?: OnError) {}
  private subscribe() {
    this.sock?.send({ jsonrpc: "2.0", id: 1, method: "transactionSubscribe", params: [{ accountInclude: [...this.wallets], vote: false, failed: false }, { commitment: "processed", encoding: "jsonParsed", transactionDetails: "full", showRewards: false, maxSupportedTransactionVersion: 0 }] });
  }
  start(wallets: string[]) {
    this.wallets = new Set(wallets);
    this.sock = new Socket(this.url, {
      label: "Helius transactions",
      onOpen: () => this.subscribe(),
      onMessage: (d) => {
        let m: { method?: string; params?: { result?: { signature?: string; slot?: number; transaction?: ParsedTx } } };
        try { m = JSON.parse(d); } catch { return; }
        if (m.method !== "transactionNotification") return;
        const r = m.params?.result;
        if (!r?.transaction) return;
        const tx: ParsedTx = { ...r.transaction, slot: r.slot ?? r.transaction.slot };
        const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) => (typeof k === "string" ? k : k.pubkey));
        const owners = new Set([...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])].map((b) => b.owner));
        const at = Date.now();
        for (const w of this.wallets) if (keys.includes(w) || owners.has(w)) { const c = classifyTx(tx, w, at, "helius"); if (c.ok) this.emit(c.trade); }
      },
      onError: this.onError,
    });
    this.sock.start();
  }
  setWallets(wallets: string[]) {
    this.wallets = new Set(wallets);
    // transactionSubscribe filters can't be edited: drop the connection's subscription by reconnecting with the new list.
    if (this.sock?.connected) { this.sock.stop(); this.start(wallets); }
  }
  stop() { this.sock?.stop(); }
  status(): SourceStatus { return { name: this.name, connected: !!this.sock?.connected, wallets: this.wallets.size, reconnects: this.sock?.reconnects ?? 0, lastMessageAt: this.sock?.lastMessageAt, note: "full transactions pushed (no getTransaction)" }; }
}

/** Optional adapters. Yellowstone isn't built in; asking for it says so. */
export function createAdapter(kind: "helius" | "yellowstone", url: string | undefined, emit: Emit, onError?: OnError): DetectionSource {
  if (kind === "yellowstone") throw new Error(`Yellowstone gRPC isn't built into ${BRAND.name} (it needs a gRPC client). Implement the DetectionSource interface in packages/core/src/copy/detect.ts and register it, or use the Helius adapter / your RPC websocket.`);
  if (!url) throw new Error("The Helius adapter needs its websocket URL (with your API key) stored in your keystore: vesk keys set HELIUS_WS_URL");
  return new HeliusSource(url, emit, onError);
}

/** All configured sources behind one dedupe: the first delivery of a (signature, wallet) wins. */
export class CopyDetector {
  readonly dedupe: SigDedupe;
  private sources: DetectionSource[] = [];
  private wallets: string[] = [];
  /** Which source delivered first, per source name (for the panel's "fastest source" line). */
  readonly firsts: Partial<Record<DetectSource, number>> = {};
  constructor(private o: { rpc: Rpc; pumpportal: boolean; rpcLogs: boolean; commitment?: "processed" | "confirmed"; adapter?: { kind: "helius" | "yellowstone"; url?: string }; onTrade: Emit; onError?: OnError; dedupe?: SigDedupe }) {
    this.dedupe = o.dedupe ?? new SigDedupe();
  }
  private emit = (t: TargetTrade) => {
    if (!this.dedupe.first(`${t.signature}:${t.wallet}`)) return;
    this.firsts[t.source] = (this.firsts[t.source] ?? 0) + 1;
    this.o.onTrade(t);
  };
  start(wallets: string[]) {
    this.wallets = [...wallets].sort();
    const skip = (sig: string, w: string) => this.dedupe.has(`${sig}:${w}`);
    if (this.o.pumpportal) this.sources.push(new PumpPortalAccountSource(this.emit, this.o.onError));
    if (this.o.rpcLogs) this.sources.push(new RpcLogsSource(this.o.rpc, this.emit, { commitment: this.o.commitment, skip, onError: this.o.onError }));
    if (this.o.adapter) {
      try { this.sources.push(createAdapter(this.o.adapter.kind, this.o.adapter.url, this.emit, this.o.onError)); } catch (e) { this.o.onError?.(e as Error); }
    }
    for (const s of this.sources) s.start(this.wallets);
  }
  setWallets(wallets: string[]) {
    const next = [...wallets].sort();
    if (next.join() === this.wallets.join()) return;
    this.wallets = next;
    for (const s of this.sources) s.setWallets(next);
  }
  /** Feed a trade from outside (the hosted relay, a manual paste, tests). Same dedupe. */
  push(t: TargetTrade) { this.emit(t); }
  stop() { for (const s of this.sources) s.stop(); this.sources = []; }
  status(): SourceStatus[] { return this.sources.map((s) => s.status()); }
  get walletCount() { return this.wallets.length; }
}
