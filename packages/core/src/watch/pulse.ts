/**
 * Pulse: a three-column board of new coins (New pairs / Final stretch / Migrated), built from PumpPortal's
 * public data websocket (wss://pumpportal.fun/api/data):
 *   subscribeNewToken      every create (pump.fun, and LetsBonk where PumpPortal carries it; `pool` says which)
 *   subscribeMigration     every coin that leaves its bonding curve
 *   subscribeTokenTrade    trades for the coins on the board
 *
 * This file is pure (no I/O): a reducer over those messages that also keeps per-wallet balances, first-buy times
 * and creation-block buyers, so watch/audits.ts can compute dev %, top 10 %, snipers, bundled and more.
 * Everything here is "since the board started watching this coin". See docs/20-pulse.md for each number.
 */

/** pump.fun curves start with ~30 virtual SOL and graduate at ~115 (about 85 real SOL raised). */
export const CURVE_SOL_START = 30;
export const CURVE_SOL_END = 115;
/** "Final stretch" starts here. */
export const FINAL_STRETCH_PCT = 80;
/** pump.fun total supply (1 billion, 6 decimals). */
export const PULSE_SUPPLY = 1_000_000_000;
/**
 * Fee estimate for the "F" column: SOL paid in launchpad trading fees, estimated as volume × this rate.
 * An estimate from pump.fun's published fee schedule at the time of writing; set it to what your launchpad charges.
 */
export const PULSE_FEE_RATE = 0.0125;

export type PulseColumn = "new" | "final" | "migrated";

/**
 * Launchpads and DEXes Pulse knows (the Discovery list). `source` says where coins come from:
 *  - "pumpportal": PumpPortal's data websocket (panel and agent): pump.fun, LetsBonk, and migrations it reports;
 *  - "rpc-logs":   new-pool detection on your RPC (logsSubscribe on the program IDs in data/programs.ts), run by
 *                  the agent (`vesk pulse --pools`); not in the browser panel;
 *  - "none":       listed so you can see it, but no source covers it yet ("not in feed yet").
 * `pools` are the PumpPortal `pool` values that map to it.
 */
export type ProtocolSource = "pumpportal" | "rpc-logs" | "none";
export const PULSE_PROTOCOLS = [
  { id: "pumpfun", name: "pump.fun", kind: "launchpad", pools: ["pump"], source: "pumpportal", inSource: true },
  { id: "letsbonk", name: "LetsBonk", kind: "launchpad", pools: ["bonk"], source: "pumpportal", inSource: true },
  { id: "pumpswap", name: "PumpSwap", kind: "dex", pools: ["pump-amm"], source: "pumpportal", inSource: true },
  { id: "raydium", name: "Raydium", kind: "dex", pools: ["raydium", "raydium-cpmm"], source: "pumpportal", inSource: true },
  { id: "raydium-launchlab", name: "LaunchLab", kind: "launchpad", pools: ["launchlab", "raydium-launchlab"], source: "rpc-logs", inSource: false },
  { id: "meteora-dbc", name: "Meteora DBC", kind: "launchpad", pools: ["meteora-dbc"], source: "rpc-logs", inSource: false },
  { id: "meteora-amm", name: "Meteora AMM", kind: "dex", pools: ["meteora-amm"], source: "rpc-logs", inSource: false },
  { id: "meteora-amm-v2", name: "Meteora AMM v2", kind: "dex", pools: ["meteora-amm-v2"], source: "rpc-logs", inSource: false },
  { id: "orca", name: "Orca", kind: "dex", pools: ["orca"], source: "rpc-logs", inSource: false },
  { id: "mayhem", name: "Mayhem", kind: "launchpad", pools: [], source: "none", inSource: false },
  { id: "bags", name: "Bags", kind: "launchpad", pools: ["bags"], source: "none", inSource: false },
  { id: "bonkers", name: "Bonkers", kind: "launchpad", pools: [], source: "none", inSource: false },
  { id: "printr", name: "Printr", kind: "launchpad", pools: [], source: "none", inSource: false },
  { id: "stonkfun", name: "Stonk.fun", kind: "launchpad", pools: [], source: "none", inSource: false },
  { id: "liquid", name: "Liquid", kind: "launchpad", pools: [], source: "none", inSource: false },
  { id: "liquidaf", name: "LiquidAF", kind: "launchpad", pools: [], source: "none", inSource: false },
  { id: "surge", name: "Surge", kind: "launchpad", pools: [], source: "none", inSource: false },
  { id: "soar", name: "Soar", kind: "launchpad", pools: [], source: "none", inSource: false },
  { id: "moonshot", name: "Moonshot", kind: "launchpad", pools: ["moonshot"], source: "none", inSource: false },
  { id: "haven", name: "Haven", kind: "launchpad", pools: [], source: "none", inSource: false },
  { id: "wordless", name: "Wordless", kind: "launchpad", pools: [], source: "none", inSource: false },
  { id: "daosfun", name: "daos.fun", kind: "launchpad", pools: [], source: "none", inSource: false },
  { id: "candle", name: "Candle", kind: "launchpad", pools: [], source: "none", inSource: false },
  { id: "sugar", name: "Sugar", kind: "launchpad", pools: [], source: "none", inSource: false },
  { id: "believe", name: "Believe", kind: "launchpad", pools: [], source: "none", inSource: false },
  { id: "jupiter-studio", name: "Jupiter Studio", kind: "launchpad", pools: [], source: "none", inSource: false },
  { id: "moonit", name: "Moonit", kind: "launchpad", pools: [], source: "none", inSource: false },
  { id: "boop", name: "Boop", kind: "launchpad", pools: [], source: "none", inSource: false },
  { id: "pancakeswap", name: "PancakeSwap", kind: "dex", pools: [], source: "none", inSource: false },
  { id: "wavebreak", name: "Wavebreak", kind: "launchpad", pools: [], source: "none", inSource: false },
  { id: "liquidaf-mm", name: "LiquidAF MM", kind: "dex", pools: [], source: "none", inSource: false },
  { id: "riserich", name: "RiseRich", kind: "launchpad", pools: [], source: "none", inSource: false },
  { id: "metadao", name: "MetaDAO", kind: "launchpad", pools: [], source: "none", inSource: false },
  { id: "pvewin", name: "pve.win", kind: "launchpad", pools: [], source: "none", inSource: false },
  { id: "other", name: "Others", kind: "launchpad", pools: [], source: "pumpportal", inSource: true },
] as const;
export type PulseProtocol = (typeof PULSE_PROTOCOLS)[number]["id"];

export function protocolOf(pool?: string): PulseProtocol {
  if (!pool) return "pumpfun";
  const p = PULSE_PROTOCOLS.find((x) => (x.pools as readonly string[]).includes(pool));
  return p ? p.id : "other";
}

export interface PulseToken {
  mint: string;
  name: string;
  symbol: string;
  protocol: PulseProtocol;
  /** Metadata URI from the create; the image and socials live there. */
  uri?: string;
  image?: string;
  /** The creator (dev) wallet. */
  creator?: string;
  createdAt: number;
  /** Slot of the create, when the source or an RPC lookup provides it. */
  createdSlot?: number;
  lastTradeAt?: number;
  /** Market cap in SOL from the latest message. */
  mcapSol: number;
  /** Virtual SOL in the bonding curve. */
  vSol: number;
  curvePct: number;
  /** Real SOL in the curve (vSol − 30) while on the curve; the pool's SOL side after migration if known. */
  liquiditySol: number;
  buys: number;
  sells: number;
  volSol: number;
  /** Distinct wallets seen trading since the board started watching it. */
  traders: number;
  socials: { x?: string; telegram?: string; website?: string; discord?: string };
  /** What the X link points to: an account, a single post, or a community. */
  xKind?: "account" | "post" | "community";
  /** Market cap (SOL) samples from recent trades, oldest first, for the hover sparkline. */
  hist?: number[];
  migrated: boolean;
  migratedAt?: number;
  pool?: string;
}

export interface PulseState {
  tokens: Record<string, PulseToken>;
  /** Token balance per wallet per mint, from create + trades (newTokenBalance when the source sends it). */
  bal: Record<string, Record<string, number>>;
  /** First buy time (ms) per wallet per mint. */
  firstBuy: Record<string, Record<string, number>>;
  /** Tokens bought per wallet in the creation block (same slot as the create, or within BLOCK_WINDOW_MS). */
  blockBuys: Record<string, Record<string, number>>;
  /** Creates and migrations per dev wallet, as seen by this board. */
  devs: Record<string, { launches: number; migrated: number }>;
  /** Distinct wallets seen trading, per mint. */
  seen: Record<string, Record<string, 1>>;
  /** Normalised X link → first mint that used it (for "reused X link"). */
  xLinks: Record<string, string>;
  /** Image URL → first mint that used it (for "image reuse"). */
  imgs?: Record<string, string>;
  /** Protocols actually seen in this session's feed. */
  seenProtocols: PulseProtocol[];
  applied: number;
}

export const emptyPulse = (): PulseState => ({ tokens: {}, bal: {}, firstBuy: {}, blockBuys: {}, seen: {}, devs: {}, xLinks: {}, imgs: {}, seenProtocols: [], applied: 0 });
/** Samples kept for the sparkline. */
export const HIST_MAX = 48;

/** Without slots, buys received within this window of the create count as "creation block" (one block ≈ 400 ms). */
export const BLOCK_WINDOW_MS = 600;

export function curvePct(vSol: number): number {
  if (!Number.isFinite(vSol)) return 0;
  const p = ((vSol - CURVE_SOL_START) / (CURVE_SOL_END - CURVE_SOL_START)) * 100;
  return Math.max(0, Math.min(100, Math.round(p * 10) / 10));
}

/** A PumpPortal data message, loosely typed: creates, trades and migrations share one stream. */
export interface PulseMessage {
  txType?: string;
  mint?: string;
  name?: string;
  symbol?: string;
  uri?: string;
  traderPublicKey?: string;
  solAmount?: number;
  /** Tokens in this trade (create: the dev's initial buy is `initialBuy`). */
  tokenAmount?: number;
  initialBuy?: number;
  /** The trader's balance after the trade, when the source sends it. */
  newTokenBalance?: number;
  vSolInBondingCurve?: number;
  marketCapSol?: number;
  pool?: string;
  signature?: string;
  /** Not in PumpPortal's stream today; filled by an RPC lookup or a source that has it. */
  slot?: number;
}

const clean = (s?: string) => (s && /^https:\/\/\S+$/.test(s) ? s : undefined);
const sub = <T>(o: Record<string, Record<string, T>>, k: string) => (o[k] ??= {});

/** Normalise an X link so the same account matches however it's written. */
export function xKey(url?: string): string | undefined {
  if (!url) return undefined;
  const m = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:\/status\/(\d+))?/i.exec(url.trim());
  return m ? `${m[1].toLowerCase()}${m[2] ? `/${m[2]}` : ""}` : url.trim().toLowerCase().replace(/\/+$/, "");
}

function setBalance(s: PulseState, mint: string, wallet: string, m: PulseMessage, delta: number) {
  const b = sub(s.bal, mint);
  const next = m.newTokenBalance !== undefined ? m.newTokenBalance : (b[wallet] ?? 0) + delta;
  if (next > 0) b[wallet] = next;
  else delete b[wallet];
}

/** Apply one message. Mutates and returns the state (fast); callers re-render on change. */
export function applyPulse(s: PulseState, m: PulseMessage, now = Date.now()): { state: PulseState; changed?: string; isNew?: boolean } {
  if (!m || !m.mint || !m.txType) return { state: s };
  const t = s.tokens[m.mint];
  if (m.txType === "create") {
    if (t) return { state: s };
    const v = m.vSolInBondingCurve ?? CURVE_SOL_START;
    const protocol = protocolOf(m.pool);
    s.tokens[m.mint] = {
      mint: m.mint, name: (m.name ?? "").slice(0, 40), symbol: (m.symbol ?? "").slice(0, 12), protocol, uri: m.uri, creator: m.traderPublicKey,
      createdAt: now, createdSlot: m.slot, mcapSol: m.marketCapSol ?? 0, vSol: v, curvePct: curvePct(v), liquiditySol: Math.max(0, v - CURVE_SOL_START),
      buys: m.solAmount ? 1 : 0, sells: 0, volSol: m.solAmount ?? 0, traders: m.traderPublicKey ? 1 : 0, socials: {}, migrated: false, pool: m.pool,
    };
    if (!s.seenProtocols.includes(protocol)) s.seenProtocols.push(protocol);
    if (m.traderPublicKey) {
      sub(s.seen, m.mint)[m.traderPublicKey] = 1;
      const dev = (s.devs[m.traderPublicKey] ??= { launches: 0, migrated: 0 });
      dev.launches++;
      const init = m.initialBuy ?? m.tokenAmount ?? 0;
      if (init > 0) {
        setBalance(s, m.mint, m.traderPublicKey, { newTokenBalance: m.newTokenBalance ?? init }, init);
        sub(s.firstBuy, m.mint)[m.traderPublicKey] = now;
        sub(s.blockBuys, m.mint)[m.traderPublicKey] = init;
      }
    }
    s.applied++;
    return { state: s, changed: m.mint, isNew: true };
  }
  if (m.txType === "buy" || m.txType === "sell") {
    if (!t) return { state: s };
    if (m.txType === "buy") t.buys++; else t.sells++;
    t.volSol += m.solAmount ?? 0;
    if (m.marketCapSol !== undefined) {
      t.mcapSol = m.marketCapSol;
      const h = (t.hist ??= []);
      h.push(m.marketCapSol);
      if (h.length > HIST_MAX) h.splice(0, h.length - HIST_MAX);
    }
    if (m.vSolInBondingCurve !== undefined && !t.migrated) { t.vSol = m.vSolInBondingCurve; t.curvePct = curvePct(m.vSolInBondingCurve); t.liquiditySol = Math.max(0, m.vSolInBondingCurve - CURVE_SOL_START); }
    t.lastTradeAt = now;
    const w = m.traderPublicKey;
    if (w) {
      const amt = m.tokenAmount ?? 0;
      setBalance(s, m.mint, w, m, m.txType === "buy" ? amt : -amt);
      if (m.txType === "buy") {
        const fb = sub(s.firstBuy, m.mint);
        if (fb[w] === undefined) {
          fb[w] = now;
          const sameBlock = t.createdSlot !== undefined && m.slot !== undefined ? m.slot === t.createdSlot : now - t.createdAt <= BLOCK_WINDOW_MS;
          if (sameBlock) sub(s.blockBuys, m.mint)[w] = (s.blockBuys[m.mint]?.[w] ?? 0) + amt;
        }
      }
      const seen = sub(s.seen, m.mint);
      if (!seen[w]) { seen[w] = 1; t.traders = Object.keys(seen).length; }
    }
    s.applied++;
    return { state: s, changed: m.mint };
  }
  if (m.txType === "migrate" || m.txType === "migration") {
    const tok = t ?? (s.tokens[m.mint] = {
      mint: m.mint, name: m.name ?? "", symbol: m.symbol ?? "", protocol: protocolOf(m.pool), createdAt: now, mcapSol: m.marketCapSol ?? 0, vSol: CURVE_SOL_END, curvePct: 100,
      liquiditySol: CURVE_SOL_END - CURVE_SOL_START, buys: 0, sells: 0, volSol: 0, traders: 0, socials: {}, migrated: true,
    });
    if (!tok.migrated && tok.creator && s.devs[tok.creator]) s.devs[tok.creator].migrated++;
    tok.migrated = true;
    tok.migratedAt = now;
    tok.curvePct = 100;
    if (m.pool) tok.pool = m.pool;
    s.applied++;
    return { state: s, changed: m.mint, isNew: !t };
  }
  return { state: s };
}

/** Fill in image and socials from the coin's metadata JSON (fetched by the caller). Records X links for "reused X". */
export function withMetadata(t: PulseToken, meta: { image?: string; twitter?: string; telegram?: string; website?: string; discord?: string }, s?: PulseState): PulseToken {
  t.image = clean(meta.image) ?? t.image;
  t.socials = { x: clean(meta.twitter), telegram: clean(meta.telegram), website: clean(meta.website), discord: clean(meta.discord) };
  t.xKind = xLinkKind(t.socials.x);
  const k = xKey(t.socials.x);
  if (s && k && !s.xLinks[k]) s.xLinks[k] = t.mint;
  if (s && t.image) { const imgs = (s.imgs ??= {}); if (!imgs[t.image]) imgs[t.image] = t.mint; }
  return t;
}

/** account (x.com/name), post (x.com/name/status/123) or community (x.com/i/communities/123). */
export function xLinkKind(url?: string): PulseToken["xKind"] {
  if (!url) return undefined;
  if (/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/i\/communities\/\d+/i.test(url)) return "community";
  if (/^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+/i.test(url)) return "post";
  if (/^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/?$/i.test(url)) return "account";
  return undefined;
}

/** The X handle in the coin's X link (account or post), without the @. */
export function xHandle(url?: string): string | undefined {
  const m = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:\/|$)/i.exec(url ?? "");
  return m && m[1].toLowerCase() !== "i" ? m[1] : undefined;
}

/** True when this coin's image URL was used by an earlier coin on the board (same URL, not a visual match). */
export function reusedImage(s: PulseState, t: PulseToken): boolean {
  return !!t.image && !!s.imgs?.[t.image] && s.imgs[t.image] !== t.mint;
}

/** True when this coin's X link was used by an earlier coin on the board. */
export function reusedX(s: PulseState, t: PulseToken): boolean {
  const k = xKey(t.socials.x);
  return !!k && !!s.xLinks[k] && s.xLinks[k] !== t.mint;
}

export function pulseColumn(t: PulseToken): PulseColumn {
  if (t.migrated) return "migrated";
  return t.curvePct >= FINAL_STRETCH_PCT ? "final" : "new";
}

/** Drop old, quiet coins so the board (and the trade subscriptions) stay small. Returns the mints removed. */
export function prunePulse(s: PulseState, now = Date.now(), keep = 300, quietMs = 20 * 60_000): string[] {
  const all = Object.values(s.tokens);
  const gone: string[] = [];
  const stale = (t: PulseToken) => !t.migrated && t.curvePct < FINAL_STRETCH_PCT && now - (t.lastTradeAt ?? t.createdAt) > quietMs;
  for (const t of all) if (stale(t)) gone.push(t.mint);
  const rest = all.filter((t) => !gone.includes(t.mint)).sort((a, b) => (b.lastTradeAt ?? b.createdAt) - (a.lastTradeAt ?? a.createdAt));
  for (const t of rest.slice(keep)) gone.push(t.mint);
  for (const m of gone) { delete s.tokens[m]; delete s.bal[m]; delete s.firstBuy[m]; delete s.blockBuys[m]; delete s.seen[m]; }
  return gone;
}

/** Websocket frames to send. Trades are subscribed per mint, in batches. */
export const PULSE_SUBSCRIBE = [{ method: "subscribeNewToken" }, { method: "subscribeMigration" }] as const;
export const tradeSubscribe = (mints: string[]) => ({ method: "subscribeTokenTrade", keys: mints });
export const tradeUnsubscribe = (mints: string[]) => ({ method: "unsubscribeTokenTrade", keys: mints });

/** "3s", "4m", "2h", "5d". */
export function ageLabel(createdAt: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - createdAt) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// ---------------------------------------------------------------- coins seen on this board

/** A coin this board has seen (for the coin page's Dev tokens tab and Reused image tokens). */
export interface SeenCoin { mint: string; symbol: string; name: string; image?: string; createdAt: number; mcapSol: number; migrated: boolean }
const seen = (t: PulseToken): SeenCoin => ({ mint: t.mint, symbol: t.symbol, name: t.name, image: t.image, createdAt: t.createdAt, mcapSol: t.mcapSol, migrated: t.migrated });
/** Other coins by the same creator that this board has seen, newest first (a lower bound: only what the stream delivered). */
export function devCoinsSeen(s: PulseState, dev: string, except?: string): SeenCoin[] {
  return Object.values(s.tokens).filter((t) => t.creator === dev && t.mint !== except).sort((a, b) => b.createdAt - a.createdAt).map(seen);
}
/** Other coins that used exactly the same image URL, newest first (same URL, not a visual match). */
export function sameImageCoins(s: PulseState, image: string | undefined, except?: string): SeenCoin[] {
  if (!image) return [];
  return Object.values(s.tokens).filter((t) => t.image === image && t.mint !== except).sort((a, b) => b.createdAt - a.createdAt).map(seen);
}
