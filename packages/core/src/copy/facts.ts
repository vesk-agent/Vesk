/**
 * Facts about a coin for the copy filters, through YOUR RPC, fetched only when a filter needs them (each costs
 * calls and time on the copy path):
 *  - market cap at their trade: PumpPortal's marketCapSol, or their fill price × the mint's supply (getTokenSupply);
 *    if neither is known, a snapshot after detection (marked "now");
 *  - liquidity: the bonding curve (pump.fun) or DexScreener's pool data (market.ts snapshot);
 *  - mint / freeze authority, name, ticker: the mint account (jsonParsed; Token-2022 metadata extension) or the
 *    Metaplex metadata account; socials from the metadata URI's JSON;
 *  - top 10: getTokenLargestAccounts → owners, minus the bonding curve;
 *  - age, dev %, bundled %: the coin's oldest signature page (getSignaturesForAddress, 1000). If the coin has more
 *    transactions than one page, its creation isn't in it and these stay unavailable (never guessed). Bundled % is
 *    the supply bought in the creation slot (the create transaction included).
 */
import { PublicKey } from "@solana/web3.js";
import { snapshot, solUsd as defaultSolUsd } from "../market.js";
import type { Rpc } from "../rpc.js";
import { bondingCurvePda, enrichCoin } from "../watch/enrich.js";
import type { CopyFacts } from "./engine.js";
import type { ParsedTx, TargetTrade } from "./classify.js";

const METAPLEX = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

/** Metaplex metadata account: key u8, update authority, mint, then borsh strings name, symbol, uri. */
export function parseMetaplex(data: Uint8Array): { name: string; symbol: string; uri: string } | null {
  try {
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let o = 1 + 32 + 32;
    const str = () => { const n = v.getUint32(o, true); o += 4; if (n > 400) throw new Error("bad length"); const s = new TextDecoder().decode(data.slice(o, o + n)); o += n; return s.replace(/\0+$/g, "").trim(); };
    return { name: str(), symbol: str(), uri: str() };
  } catch {
    return null;
  }
}

/** Socials from a metadata JSON (pump.fun style: twitter / telegram / website, or an extensions block). */
export function socialsOf(j: Record<string, unknown> | null): CopyFacts["socials"] | undefined {
  if (!j) return undefined;
  const ext = (j.extensions ?? {}) as Record<string, unknown>;
  const get = (k: string) => String(j[k] ?? ext[k] ?? "").trim();
  const x = get("twitter") || get("x");
  return { x: /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(x), telegram: /^https?:\/\/(?:t\.me|telegram\.me)\//i.test(get("telegram")), website: /^https?:\/\//i.test(get("website")) };
}

type MintInfo = { mintAuthority?: string | null; freezeAuthority?: string | null; supply?: string; decimals?: number; extensions?: Array<{ extension: string; state?: { name?: string; symbol?: string; uri?: string } }> };

export class CoinFacts {
  private origin = new Map<string, Promise<{ createdAtMs?: number; creator?: string; bundledTokens?: number } | null>>();
  private meta = new Map<string, Promise<{ name?: string; symbol?: string; socials?: CopyFacts["socials"]; mintRevoked?: boolean; freezeRevoked?: boolean; supply?: number } | null>>();
  constructor(private rpc: Rpc, private o: { solUsd?: () => Promise<number>; fetch?: typeof fetch } = {}) {}

  private solUsd() { return (this.o.solUsd ?? defaultSolUsd)(); }

  /** Mint account + metadata (cached per coin; none of it changes often enough to matter for a copy). */
  mintMeta(mint: string) {
    let p = this.meta.get(mint);
    if (!p) {
      p = (async () => {
        const acct = await this.rpc.call<{ value: { data?: { parsed?: { info?: MintInfo } } } | null }>("getAccountInfo", [mint, { encoding: "jsonParsed" }]).catch(() => null);
        const info = acct?.value?.data?.parsed?.info;
        if (!info) return null;
        const supply = info.supply !== undefined ? Number(info.supply) / 10 ** (info.decimals ?? 6) : undefined;
        let md = info.extensions?.find((e) => e.extension === "tokenMetadata")?.state;
        if (!md) {
          const pda = PublicKey.findProgramAddressSync([new TextEncoder().encode("metadata"), new PublicKey(METAPLEX).toBytes(), new PublicKey(mint).toBytes()], new PublicKey(METAPLEX))[0].toBase58();
          const m = await this.rpc.getAccountInfo(pda, "base64").catch(() => null);
          const raw = m && Array.isArray(m.data) ? Uint8Array.from(atob(String(m.data[0])), (c) => c.charCodeAt(0)) : null;
          md = raw ? parseMetaplex(raw) ?? undefined : undefined;
        }
        let socials: CopyFacts["socials"];
        if (md?.uri && /^https?:\/\//.test(md.uri)) {
          const j = await (this.o.fetch ?? fetch)(md.uri, { signal: AbortSignal.timeout(2500) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
          socials = socialsOf(j as Record<string, unknown> | null);
        }
        return { name: md?.name, symbol: md?.symbol, socials, mintRevoked: info.mintAuthority === null || info.mintAuthority === undefined, freezeRevoked: info.freezeAuthority === null || info.freezeAuthority === undefined, supply };
      })();
      this.meta.set(mint, p);
      if (this.meta.size > 2000) this.meta.delete(this.meta.keys().next().value!);
      p.then((v) => { if (!v) this.meta.delete(mint); }).catch(() => this.meta.delete(mint));
    }
    return p;
  }

  /** Creation time, creator and the supply bought in the creation slot, if the creation is in one signature page. */
  coinOrigin(mint: string) {
    let p = this.origin.get(mint);
    if (!p) {
      p = (async () => {
        const sigs = await this.rpc.call<Array<{ signature: string; slot: number; blockTime?: number | null; err?: unknown }>>("getSignaturesForAddress", [mint, { limit: 1000 }]).catch(() => null);
        if (!sigs?.length || sigs.length >= 1000) return null;
        const oldest = sigs[sigs.length - 1];
        const sameSlot = sigs.filter((s) => s.slot === oldest.slot && !s.err).slice(-12);
        const curve = bondingCurvePda(mint);
        let creator: string | undefined;
        let bundled = 0;
        for (const s of sameSlot) {
          const tx = await this.rpc.call<ParsedTx>("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]).catch(() => null);
          if (!tx?.meta) continue;
          if (s.signature === oldest.signature) { const k = tx.transaction?.message?.accountKeys?.[0]; creator = typeof k === "string" ? k : k?.pubkey; }
          const pre = new Map((tx.meta.preTokenBalances ?? []).filter((b) => b.mint === mint).map((b) => [b.accountIndex, Number(b.uiTokenAmount?.uiAmountString ?? b.uiTokenAmount?.uiAmount ?? 0)]));
          for (const b of (tx.meta.postTokenBalances ?? []).filter((x) => x.mint === mint && x.owner !== curve)) {
            const d = Number(b.uiTokenAmount?.uiAmountString ?? b.uiTokenAmount?.uiAmount ?? 0) - (pre.get(b.accountIndex) ?? 0);
            if (d > 0) bundled += d;
          }
        }
        return { createdAtMs: oldest.blockTime ? oldest.blockTime * 1000 : undefined, creator, bundledTokens: bundled };
      })();
      this.origin.set(mint, p);
      if (this.origin.size > 2000) this.origin.delete(this.origin.keys().next().value!);
      p.then((v) => { if (!v) this.origin.delete(mint); }).catch(() => this.origin.delete(mint));
    }
    return p;
  }

  /** Everything `need` asks for, in parallel. Missing data stays undefined. */
  async gather(t: TargetTrade, need: Array<keyof CopyFacts>, now = Date.now()): Promise<CopyFacts & { dev?: string }> {
    const has = (k: keyof CopyFacts) => need.includes(k);
    const out: CopyFacts & { dev?: string } = { name: t.name, symbol: t.symbol };
    const wantMeta = has("name") || has("symbol") || has("socials") || has("mintRevoked") || has("freezeRevoked") || has("devPct") || has("top10Pct") || has("bundledPct") || (has("mcapUsd") && t.mcapSol === undefined);
    const wantOrigin = has("ageSec") || has("devPct") || has("bundledPct");
    const [meta, origin, snap, largest, usd] = await Promise.all([
      wantMeta ? this.mintMeta(t.mint).catch(() => null) : null,
      wantOrigin ? this.coinOrigin(t.mint).catch(() => null) : null,
      has("liquiditySol") || (has("mcapUsd") && t.mcapSol === undefined && t.priceSol === undefined) ? snapshot(this.rpc, t.mint).catch(() => null) : null,
      has("top10Pct") ? enrichCoin(this.rpc, t.mint, { countHolders: false, maxFunding: 0 }).catch(() => null) : null,
      has("mcapUsd") ? this.solUsd().catch(() => undefined) : undefined,
    ]);
    if (meta) {
      out.name ??= meta.name; out.symbol ??= meta.symbol;
      if (has("socials")) out.socials = meta.socials;
      if (has("mintRevoked")) out.mintRevoked = meta.mintRevoked;
      if (has("freezeRevoked")) out.freezeRevoked = meta.freezeRevoked;
    }
    const supply = meta?.supply;
    if (has("mcapUsd") && usd) {
      if (t.mcapSol !== undefined) { out.mcapUsd = t.mcapSol * usd; out.mcapSource = "their-trade"; }
      else if (t.priceSol !== undefined && supply) { out.mcapUsd = t.priceSol * supply * usd; out.mcapSource = "their-trade"; }
    }
    if (has("mcapUsd") && out.mcapUsd === undefined && snap) { out.mcapUsd = snap.mcapUsd; out.mcapSource = "now"; }
    if (has("liquiditySol") && snap) out.liquiditySol = snap.liquiditySol;
    if (has("top10Pct") && largest?.largest && supply) out.top10Pct = +((largest.largest.slice(0, 10).reduce((s, x) => s + x.amount, 0) / supply) * 100).toFixed(2);
    if (origin) {
      if (has("ageSec") && origin.createdAtMs) out.ageSec = Math.max(0, ((t.blockTimeMs ?? now) - origin.createdAtMs) / 1000);
      if (has("bundledPct") && supply && origin.bundledTokens !== undefined) out.bundledPct = +((origin.bundledTokens / supply) * 100).toFixed(2);
      if (origin.creator) out.dev = origin.creator;
      if (has("devPct") && origin.creator && supply) {
        const r = await this.rpc.call<{ value: Array<{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: number | null } } } } } }> }>("getTokenAccountsByOwner", [origin.creator, { mint: t.mint }, { encoding: "jsonParsed" }]).catch(() => null);
        if (r?.value) out.devPct = +((r.value.reduce((s, a) => s + (a.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0) / supply) * 100).toFixed(2);
      }
    }
    return out;
  }
}
