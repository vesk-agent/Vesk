/**
 * Minimal Solana JSON-RPC client (fetch only) with a latency test.
 * Works with Helius, QuickNode, Triton or any RPC URL. The public endpoint works too, just slower
 * and rate-limited; `rpcKind` lets the CLI and panel say so plainly.
 */
export type RpcKind = "helius" | "quicknode" | "triton" | "public" | "custom";

export function rpcKind(url: string): RpcKind {
  const h = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();
  if (/helius-rpc\.com$|helius\.xyz$/.test(h)) return "helius";
  if (/quiknode\.pro$|quicknode\.com$/.test(h)) return "quicknode";
  if (/rpcpool\.com$|triton\.one$/.test(h)) return "triton";
  if (/^api\.mainnet-beta\.solana\.com$/.test(h)) return "public";
  return "custom";
}

export const RPC_NOTES: Record<RpcKind, string> = {
  helius: "Helius RPC.",
  quicknode: "QuickNode RPC.",
  triton: "Triton RPC.",
  public: "Public Solana RPC: it works, but it is rate-limited and slower. Snipes will land later than with a private RPC.",
  custom: "Custom RPC.",
};

export class RpcError extends Error {
  constructor(message: string, public code?: number) {
    super(message);
  }
}

export interface LatencyResult {
  url: string;
  kind: RpcKind;
  samples: number[];
  p50: number;
  p95: number;
  min: number;
  errors: number;
  slot?: number;
  verdict: "fast" | "ok" | "slow" | "down";
}

/**
 * The websocket endpoint for an RPC URL: the same host over wss (Helius, QuickNode, Triton and the public RPC all
 * serve both). Used for signatureSubscribe, so confirmations arrive as a push instead of a poll.
 */
export function wsUrlFor(httpUrl: string): string | undefined {
  try {
    const u = new URL(httpUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.toString();
  } catch {
    return undefined;
  }
}

export class Rpc {
  private id = 0;
  /** Websocket RPC for confirmations (your provider's, derived from the HTTP URL unless rpc.wsUrl is set). */
  readonly wsUrl?: string;
  constructor(public url: string, private timeoutMs = 10_000, wsUrl?: string | null) {
    this.wsUrl = wsUrl === null ? undefined : wsUrl ?? wsUrlFor(url);
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const r = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
        signal: ctl.signal,
      });
      if (r.status === 429) throw new RpcError("RPC rate limit (429). A private RPC avoids this.", 429);
      if (!r.ok) throw new RpcError(`RPC HTTP ${r.status}`, r.status);
      const j = (await r.json()) as { result?: T; error?: { message: string; code: number } };
      if (j.error) throw new RpcError(j.error.message, j.error.code);
      return j.result as T;
    } catch (e) {
      if ((e as Error).name === "AbortError") throw new RpcError(`RPC timed out after ${this.timeoutMs} ms`);
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  getSlot() {
    return this.call<number>("getSlot", [{ commitment: "processed" }]);
  }
  async getBalanceSol(address: string): Promise<number> {
    const r = await this.call<{ value: number }>("getBalance", [address, { commitment: "confirmed" }]);
    return r.value / 1e9;
  }
  async getLatestBlockhash() {
    const r = await this.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
    return r.value;
  }
  async getAccountInfo(address: string, encoding: "base64" | "jsonParsed" = "base64") {
    const r = await this.call<{ value: { owner: string; data: [string, string] | { parsed: unknown; program: string }; lamports: number } | null }>(
      "getAccountInfo",
      [address, { encoding, commitment: "confirmed" }],
    );
    return r.value;
  }
  async getTokenBalances(owner: string): Promise<Array<{ mint: string; amount: number; decimals: number }>> {
    const out: Array<{ mint: string; amount: number; decimals: number }> = [];
    for (const programId of ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]) {
      const r = await this.call<{ value: Array<{ account: { data: { parsed: { info: { mint: string; tokenAmount: { uiAmount: number; decimals: number } } } } } }> }>(
        "getTokenAccountsByOwner",
        [owner, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }],
      );
      for (const a of r.value) {
        const i = a.account.data.parsed.info;
        if (i.tokenAmount.uiAmount > 0) out.push({ mint: i.mint, amount: i.tokenAmount.uiAmount, decimals: i.tokenAmount.decimals });
      }
    }
    return out;
  }
  sendRawTransaction(base64: string, opts: { skipPreflight?: boolean; maxRetries?: number } = {}) {
    return this.call<string>("sendTransaction", [base64, { encoding: "base64", skipPreflight: opts.skipPreflight ?? true, maxRetries: opts.maxRetries ?? 3, preflightCommitment: "processed" }]);
  }

  /**
   * Wait until the signature is confirmed or fails. Listens on your RPC's websocket (signatureSubscribe) and polls
   * getSignatureStatuses alongside it, whichever answers first. Without a websocket it just polls. Returns elapsed ms.
   */
  async confirm(signature: string, timeoutMs = 45_000): Promise<{ ok: boolean; ms: number; err?: unknown }> {
    const t0 = Date.now();
    let stop = false;
    const viaWs = this.wsConfirm(signature, timeoutMs, () => stop);
    const viaPoll = this.pollConfirm(signature, timeoutMs, () => stop);
    const r = await Promise.race([viaWs.then((x) => x ?? viaPoll), viaPoll]);
    stop = true;
    return { ...r, ms: Date.now() - t0 };
  }

  /** signatureSubscribe on the websocket RPC. Resolves null if there is no websocket or it can't connect. */
  private wsConfirm(signature: string, timeoutMs: number, stopped: () => boolean): Promise<{ ok: boolean; ms: number; err?: unknown } | null> {
    const WS = (globalThis as { WebSocket?: new (u: string) => { send(d: string): void; close(): void; onopen: unknown; onmessage: unknown; onerror: unknown; onclose: unknown } }).WebSocket;
    if (!this.wsUrl || !WS) return Promise.resolve(null);
    const t0 = Date.now();
    return new Promise((resolve) => {
      let done = false;
      let ws: InstanceType<typeof WS>;
      const finish = (v: { ok: boolean; ms: number; err?: unknown } | null) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        clearInterval(s);
        try { ws.close(); } catch { /* closed */ }
        resolve(v);
      };
      const t = setTimeout(() => finish(null), timeoutMs);
      const s = setInterval(() => stopped() && finish(null), 250);
      try {
        ws = new WS(this.wsUrl!);
      } catch {
        return finish(null);
      }
      ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "signatureSubscribe", params: [signature, { commitment: "confirmed" }] }));
      ws.onmessage = (ev: { data: unknown }) => {
        try {
          const m = JSON.parse(String(ev.data)) as { method?: string; params?: { result?: { value?: { err: unknown } } } };
          if (m.method === "signatureNotification") {
            const err = m.params?.result?.value?.err ?? null;
            finish({ ok: !err, ms: Date.now() - t0, err: err ?? undefined });
          }
        } catch { /* ignore */ }
      };
      ws.onerror = () => finish(null);
      ws.onclose = () => finish(null);
    });
  }

  private async pollConfirm(signature: string, timeoutMs: number, stopped: () => boolean): Promise<{ ok: boolean; ms: number; err?: unknown }> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs && !stopped()) {
      const r = await this.call<{ value: Array<{ err: unknown; confirmationStatus?: string } | null> }>("getSignatureStatuses", [[signature], { searchTransactionHistory: false }]);
      const s = r.value[0];
      if (s?.err) return { ok: false, ms: Date.now() - t0, err: s.err };
      if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return { ok: true, ms: Date.now() - t0 };
      await sleep(400);
    }
    return { ok: false, ms: Date.now() - t0, err: "timeout" };
  }

  /** Is this account an SPL mint (Token or Token-2022)? Used before buying a detected CA. */
  async isMint(address: string): Promise<boolean> {
    const info = await this.getAccountInfo(address, "jsonParsed");
    const d = info?.data as { parsed?: { type?: string }; program?: string } | undefined;
    return !!d && (d.program === "spl-token" || d.program === "spl-token-2022") && d.parsed?.type === "mint";
  }

  /**
   * Priority-fee estimate in SOL for a ~200k compute-unit swap: the median of getRecentPrioritizationFees
   * (micro-lamports per CU) over the last slots your RPC reports. Undefined if the RPC doesn't support it.
   */
  async priorityFeeEstimateSol(computeUnits = 200_000): Promise<number | undefined> {
    try {
      const r = await this.call<Array<{ prioritizationFee: number }>>("getRecentPrioritizationFees", []);
      const v = r.map((x) => x.prioritizationFee).filter((x) => x > 0).sort((a, b) => a - b);
      if (!v.length) return 0;
      return (v[Math.floor(v.length / 2)] * computeUnits) / 1e6 / 1e9;
    } catch {
      return undefined;
    }
  }

  async latencyTest(n = 5): Promise<LatencyResult> {
    const samples: number[] = [];
    let errors = 0;
    let slot: number | undefined;
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      try {
        slot = await this.getSlot();
        samples.push(Math.round(performance.now() - t0));
      } catch {
        errors++;
      }
    }
    const s = [...samples].sort((a, b) => a - b);
    const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : Infinity);
    const p50 = q(0.5);
    const verdict = s.length === 0 ? "down" : p50 < 80 ? "fast" : p50 < 200 ? "ok" : "slow";
    return { url: redactUrl(this.url), kind: rpcKind(this.url), samples, p50, p95: q(0.95), min: s[0] ?? Infinity, errors, slot, verdict };
  }
}

/** Hide API keys in RPC URLs before printing or reporting them. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (/key|token|secret/i.test(k)) u.searchParams.set(k, "•••");
    u.pathname = u.pathname.replace(/\/[A-Za-z0-9_-]{20,}(\/?)$/, "/•••$1");
    return u.toString();
  } catch {
    return "(invalid url)";
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
