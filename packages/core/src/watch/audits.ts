/**
 * Pulse audits, filters and the board. Pure functions over watch/pulse.ts state, shared by the agent and the panel.
 *
 * How each audit is computed (see docs/20-pulse.md):
 *  - holders      wallets with a balance > 0 in the stream; replaced by the RPC count when an enrichment has it
 *                 (getProgramAccounts on the mint's token program, owner+amount slice, curve/pool owners removed).
 *  - dev %        the creator's current balance / supply. The stream sees the dev's initial buy and later trades.
 *  - top 10 %     the 10 largest balances / supply. With enrichment: getTokenLargestAccounts, minus the bonding
 *                 curve / pool accounts. Stream-only: the 10 largest traders the board has seen (a lower bound).
 *  - snipers %    current balances of wallets (not the dev) whose first buy came within SNIPER_WINDOW_MS of the create.
 *  - bundled %    tokens bought in the creation block (same slot, or within BLOCK_WINDOW_MS when slots are unknown)
 *                 by the dev plus wallets funded together (same funding source as the dev, or as another
 *                 creation-block buyer). Without funding data: all creation-block buys (an upper bound).
 *                 v19: never through infrastructure: pools, curves, known programs, program-owned accounts and
 *                 exchange hot wallets are not links (data/clusterExclude.ts, `linkableFunding`).
 *  - insiders %   current balances of holders whose funding source is the dev, the dev's own funder, or shared with
 *                 another holder. Needs enrichment (funding sources); unknown otherwise.
 *  - dev launches / migrated: coins by the same creator this board has seen (a lower bound).
 *  - fees         volume × PULSE_FEE_RATE (an estimate).
 * "Pro traders" isn't derivable from public data here, so Pulse doesn't show it.
 */
import { PULSE_FEE_RATE, PULSE_SUPPLY, pulseColumn, reusedX, type PulseColumn, type PulseProtocol, type PulseState, type PulseToken } from "./pulse.js";
import { nonFunderLabel } from "../data/clusterExclude.js";

export const SNIPER_WINDOW_MS = 3_000;

/** Optional RPC data for a coin (panel: the edge function's pulse-enrich; agent: its own RPC). */
export interface PulseEnrichment {
  /** Largest holders (owner wallets) with token amounts, curve/pool accounts already removed. */
  largest?: Array<{ owner: string; amount: number }>;
  /** Total holder count, when the RPC could count it. */
  holders?: number;
  /** wallet → funding source (the sender of its first SOL transfer). */
  funding?: Record<string, string>;
  /** v19: this coin's curve and pool accounts (never a funder, never a holder that links others). */
  exclude?: string[];
  /** v19: funders whose account is owned by a program other than the System Program (pools, vaults, PDAs). */
  programOwned?: string[];
  /** The dev's funding transfer: who sent it, how much SOL, when (ms). */
  devFunding?: { from: string; sol: number; at?: number };
  /** Token-2022 transfer fee in basis points (0 = none, undefined = not checked). */
  taxBps?: number;
  /** DexScreener: an approved paid order (token profile / ad) exists for this coin. undefined = not checked. */
  dexPaid?: boolean;
  /** DexScreener: active boosts on the coin's pairs. */
  boosts?: number;
  /** pump.fun: the coin is live-streaming right now (unofficial endpoint; undefined = not checked). */
  live?: boolean;
  at?: number;
}

export interface PulseAudits {
  holders: number;
  devPct: number | null;
  top10Pct: number;
  snipersPct: number;
  bundledPct: number;
  insidersPct: number | null;
  devLaunches: number;
  devMigrated: number;
  feesSol: number;
  /** Which numbers came from the stream only (approximate) vs an RPC enrichment. */
  source: "stream" | "rpc";
}

const pct = (n: number) => +((n / PULSE_SUPPLY) * 100).toFixed(2);

// ---------------------------------------------------------------- per-wallet labels
// The same definitions decide Pulse's sniper / bundled / insider percentages and the coin page's Early buyers labels.

/** Sniper: a wallet other than the dev whose first buy came within SNIPER_WINDOW_MS of the create. */
export function isSniper(wallet: string, firstBuyAt: number, createdAt: number, dev?: string): boolean {
  return wallet !== dev && firstBuyAt - createdAt <= SNIPER_WINDOW_MS;
}

// ---------------------------------------------------------------- pool-aware links (v19)

/** What the clustering may not link through: known programs and pools, exchange hot wallets, this coin's accounts. */
export interface LinkCtx {
  /** This coin's curve / pool accounts. */
  exclude?: ReadonlySet<string> | readonly string[];
  /** Funders owned by a program (not the System Program). */
  programOwned?: ReadonlySet<string>;
}
export const linkCtxOf = (e?: Pick<PulseEnrichment, "exclude" | "programOwned">): LinkCtx => ({ exclude: e?.exclude ?? [], programOwned: new Set(e?.programOwned ?? []) });

/**
 * The funding map with every edge through infrastructure removed: a funder that is a known program, a pool or curve,
 * an exchange hot wallet or a program-owned account is not a link, and neither is a wallet that is itself one of those
 * (a pool account showing up as a "holder"). `dropped` says which edges went and why.
 */
export function linkableFunding(funding: Record<string, string> | undefined, ctx: LinkCtx = {}): { funding?: Record<string, string>; dropped: Array<{ wallet: string; funder: string; why: string }> } {
  if (!funding) return { dropped: [] };
  const out: Record<string, string> = {};
  const dropped: Array<{ wallet: string; funder: string; why: string }> = [];
  for (const [w, f] of Object.entries(funding)) {
    const why = nonFunderLabel(f, ctx) ?? (nonFunderLabel(w, ctx) ? `the wallet is ${nonFunderLabel(w, ctx)}` : undefined);
    if (why) dropped.push({ wallet: w, funder: f, why });
    else out[w] = f;
  }
  return { funding: out, dropped };
}

/**
 * Bundled: creation-block buyers that bought together. With funding data: the dev, and block buyers funded by the
 * dev, by the dev's own funder, or by the same source as another block buyer. Without funding data every block buyer
 * counts, and `exact` is false (an upper bound).
 */
export function bundledWallets(blockBuyers: string[], dev: string | undefined, rawFunding?: Record<string, string>, link: LinkCtx = {}): { wallets: Set<string>; exact: boolean } {
  if (!rawFunding) return { wallets: new Set(blockBuyers.filter((w) => !nonFunderLabel(w, link))), exact: false };
  // v19: never link through a pool, a curve, a program or an exchange
  const funding = linkableFunding(rawFunding, link).funding!;
  const devFunder = dev ? funding[dev] : undefined;
  const funders = blockBuyers.map((w) => funding[w]).filter(Boolean);
  const together = (w: string) => w === dev || (!!funding[w] && (funding[w] === dev || funding[w] === devFunder || funders.filter((x) => x === funding[w]).length > 1));
  return { wallets: new Set(blockBuyers.filter(together)), exact: true };
}

/**
 * Insiders: wallets (not the dev) funded by the dev, by the dev's own funder, or by the same source as another wallet
 * in the set. null without funding data (unknown, never guessed).
 */
export function insiderWallets(wallets: string[], dev: string | undefined, rawFunding?: Record<string, string>, link: LinkCtx = {}): Set<string> | null {
  if (!rawFunding) return null;
  const funding = linkableFunding(rawFunding, link).funding!;
  const devFunder = dev ? funding[dev] : undefined;
  const count: Record<string, number> = {};
  for (const w of wallets) if (funding[w]) count[funding[w]] = (count[funding[w]] ?? 0) + 1;
  return new Set(wallets.filter((w) => w !== dev && funding[w] && (funding[w] === dev || (devFunder && funding[w] === devFunder) || count[funding[w]] > 1)));
}

export function pulseAudits(s: PulseState, t: PulseToken, e?: PulseEnrichment): PulseAudits {
  const bal = s.bal[t.mint] ?? {};
  const dev = t.creator;
  const holdersStream = Object.values(bal).filter((v) => v > 0).length;
  const balances = e?.largest?.length ? e.largest.map((x) => x.amount) : Object.values(bal);
  const top10 = [...balances].sort((a, b) => b - a).slice(0, 10).reduce((a, b) => a + b, 0);
  const fb = s.firstBuy[t.mint] ?? {};
  const snipers = Object.entries(fb).filter(([w, at]) => isSniper(w, at, t.createdAt, dev)).reduce((a, [w]) => a + (bal[w] ?? 0), 0);
  const block = s.blockBuys[t.mint] ?? {};
  const f = e?.funding;
  const link = linkCtxOf(e);
  const bw = bundledWallets(Object.keys(block), dev, f, link).wallets;
  const bundled = Object.entries(block).filter(([w]) => bw.has(w)).reduce((a, [, n]) => a + n, 0);
  let insiders: number | null = null;
  if (f) {
    const holderList = e?.largest?.length ? e.largest.map((x) => ({ w: x.owner, n: x.amount })) : Object.entries(bal).map(([w, n]) => ({ w, n }));
    const iw = insiderWallets(holderList.map((h) => h.w), dev, f, link)!;
    insiders = holderList.filter((h) => iw.has(h.w)).reduce((a, h) => a + h.n, 0);
  }
  const d = dev ? s.devs[dev] : undefined;
  return {
    holders: e?.holders ?? holdersStream,
    devPct: dev ? pct(bal[dev] ?? 0) : null,
    top10Pct: pct(top10),
    snipersPct: pct(snipers),
    bundledPct: pct(bundled),
    insidersPct: insiders === null ? null : pct(insiders),
    devLaunches: d?.launches ?? 0,
    devMigrated: d?.migrated ?? 0,
    feesSol: +(t.volSol * PULSE_FEE_RATE).toFixed(4),
    source: e ? "rpc" : "stream",
  };
}

/** The funding transfer in a parsed transaction: sender, SOL amount and block time. */
export function fundingFromTx(tx: unknown, wallet: string): { from: string; sol: number; at?: number } | undefined {
  const t = tx as { blockTime?: number; transaction?: { message?: { instructions?: Array<{ program?: string; parsed?: { type?: string; info?: { source?: string; destination?: string; lamports?: number } } }> } }; meta?: { innerInstructions?: Array<{ instructions: Array<{ program?: string; parsed?: { type?: string; info?: { source?: string; destination?: string; lamports?: number } } }> }> } } | null;
  const all = [...(t?.transaction?.message?.instructions ?? []), ...(t?.meta?.innerInstructions ?? []).flatMap((x) => x.instructions)];
  const ix = all.find((i) => i.program === "system" && (i.parsed?.type === "transfer" || i.parsed?.type === "transferWithSeed") && i.parsed?.info?.destination === wallet);
  if (!ix?.parsed?.info?.source) return undefined;
  return { from: ix.parsed.info.source, sol: +((ix.parsed.info.lamports ?? 0) / 1e9).toFixed(4), ...(t?.blockTime ? { at: t.blockTime * 1000 } : {}) };
}

/** Pick the funder from a parsed transaction: the source of a system transfer into `wallet`. */
export function funderFromTx(tx: unknown, wallet: string): string | undefined {
  const t = tx as { transaction?: { message?: { instructions?: Array<{ program?: string; parsed?: { type?: string; info?: { source?: string; destination?: string } } }> } }; meta?: { innerInstructions?: Array<{ instructions: Array<{ program?: string; parsed?: { type?: string; info?: { source?: string; destination?: string } } }> }> } } | null;
  const all = [...(t?.transaction?.message?.instructions ?? []), ...(t?.meta?.innerInstructions ?? []).flatMap((x) => x.instructions)];
  const ix = all.find((i) => i.program === "system" && (i.parsed?.type === "transfer" || i.parsed?.type === "transferWithSeed") && i.parsed?.info?.destination === wallet);
  return ix?.parsed?.info?.source;
}

/**
 * getProgramAccounts request for every token account of `mint`, returning only owner (32 bytes) + amount (8 bytes).
 * Works for the classic token program and Token-2022 (no dataSize filter, since 2022 accounts vary in size).
 */
export function holderScanParams(tokenProgram: string, mint: string): unknown[] {
  return [tokenProgram, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 32, length: 40 }, filters: [{ memcmp: { offset: 0, bytes: mint } }] }];
}

/** Count holders from a holderScanParams result: accounts with a non-zero amount, owners in `skip` removed. */
export function countHolders(rows: Array<{ account?: { data?: [string, string] | string[] } }>, skip: Set<string>, b58: (b: Uint8Array) => string): number {
  const owners = new Set<string>();
  for (const r of rows) {
    const d = r.account?.data?.[0];
    if (!d) continue;
    const bin = atob(d);
    if (bin.length < 40) continue;
    let nonzero = false;
    for (let i = 32; i < 40; i++) if (bin.charCodeAt(i) !== 0) { nonzero = true; break; }
    if (!nonzero) continue;
    const owner = b58(Uint8Array.from(bin.slice(0, 32), (c) => c.charCodeAt(0)));
    if (!skip.has(owner)) owners.add(owner);
  }
  return owners.size;
}

// ---------------------------------------------------------------- filters

export interface Range { min?: number; max?: number }
export type AuditKey = "devPct" | "top10Pct" | "snipersPct" | "insidersPct" | "bundledPct" | "holders" | "devLaunches" | "devMigrated";
export type MetricKey = "ageSec" | "mcapUsd" | "liquiditySol" | "volSol" | "txns" | "buys" | "sells" | "curvePct" | "feesSol";

export interface PulseColumnFilter {
  /** Empty = every protocol. */
  protocols?: PulseProtocol[];
  keywords?: string[];
  exclude?: string[];
  audits?: Partial<Record<AuditKey, Range>>;
  metrics?: Partial<Record<MetricKey, Range>>;
  socials?: { x?: boolean; website?: boolean; telegram?: boolean; any?: boolean; excludeReusedX?: boolean };
  pumpSuffix?: boolean;
  /** Hide coins whose audit isn't known yet when that audit has a range. Default: unknown passes. */
  hideUnknown?: boolean;
}

export type FilterKey = "protocol" | "keywords" | "exclude" | `audit.${AuditKey}` | `metric.${MetricKey}` | "social.x" | "social.website" | "social.telegram" | "social.any" | "social.reusedX" | "pumpSuffix";

export interface PulseCtx { solUsd: number; now?: number; enrich?: Record<string, PulseEnrichment> }

export function metricValue(t: PulseToken, k: MetricKey, ctx: PulseCtx): number {
  switch (k) {
    case "ageSec": return Math.max(0, ((ctx.now ?? Date.now()) - t.createdAt) / 1000);
    case "mcapUsd": return t.mcapSol * ctx.solUsd;
    case "liquiditySol": return t.liquiditySol;
    case "volSol": return t.volSol;
    case "txns": return t.buys + t.sells;
    case "buys": return t.buys;
    case "sells": return t.sells;
    case "curvePct": return t.curvePct;
    case "feesSol": return t.volSol * PULSE_FEE_RATE;
  }
}

const inRange = (v: number, r: Range) => (r.min === undefined || v >= r.min) && (r.max === undefined || v <= r.max);
const hasRange = (r?: Range) => !!r && (r.min !== undefined || r.max !== undefined);

/** Every filter this coin fails (empty = it passes). */
export function pulseFails(s: PulseState, t: PulseToken, f: PulseColumnFilter, ctx: PulseCtx, a = pulseAudits(s, t, ctx.enrich?.[t.mint])): FilterKey[] {
  const out: FilterKey[] = [];
  if (f.protocols?.length && !f.protocols.includes(t.protocol)) out.push("protocol");
  const text = `${t.name} ${t.symbol} ${t.mint}`.toLowerCase();
  const kws = (f.keywords ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (kws.length && !kws.some((k) => text.includes(k))) out.push("keywords");
  const ex = (f.exclude ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (ex.some((k) => text.includes(k))) out.push("exclude");
  for (const [k, r] of Object.entries(f.audits ?? {}) as Array<[AuditKey, Range]>) {
    if (!hasRange(r)) continue;
    const v = a[k];
    if (v === null || v === undefined) { if (f.hideUnknown) out.push(`audit.${k}`); continue; }
    if (!inRange(v, r)) out.push(`audit.${k}`);
  }
  for (const [k, r] of Object.entries(f.metrics ?? {}) as Array<[MetricKey, Range]>) if (hasRange(r) && !inRange(metricValue(t, k, ctx), r)) out.push(`metric.${k}`);
  const so = f.socials ?? {};
  if (so.x && !t.socials.x) out.push("social.x");
  if (so.website && !t.socials.website) out.push("social.website");
  if (so.telegram && !t.socials.telegram) out.push("social.telegram");
  if (so.any && !(t.socials.x || t.socials.website || t.socials.telegram)) out.push("social.any");
  if (so.excludeReusedX && reusedX(s, t)) out.push("social.reusedX");
  if (f.pumpSuffix && !t.mint.endsWith("pump")) out.push("pumpSuffix");
  return out;
}

export interface PulseColumnView {
  rows: Array<{ t: PulseToken; a: PulseAudits }>;
  /** How many coins each filter hides on its own (a coin failing two filters counts for both). */
  hiddenBy: Partial<Record<FilterKey, number>>;
  total: number;
}

/** One column: coins in that stage, filtered, sorted (New: newest; Final stretch: closest to graduating; Migrated: latest). */
export function pulseColumnView(s: PulseState, col: PulseColumn, f: PulseColumnFilter, ctx: PulseCtx, opts: { hidden?: string[]; hiddenDevs?: string[]; limit?: number } = {}): PulseColumnView {
  const hiddenBy: Partial<Record<FilterKey, number>> = {};
  const rows: PulseColumnView["rows"] = [];
  const hid = new Set(opts.hidden ?? []), hidDevs = new Set(opts.hiddenDevs ?? []);
  // Audits are the expensive part: only compute them up front when the filter uses them; otherwise lazily per row.
  const needAudits = Object.values(f.audits ?? {}).some((r) => hasRange(r as Range));
  let total = 0;
  for (const t of Object.values(s.tokens)) {
    if (pulseColumn(t) !== col) continue;
    if (hid.has(t.mint) || (t.creator && hidDevs.has(t.creator))) continue;
    total++;
    const pre = needAudits ? pulseAudits(s, t, ctx.enrich?.[t.mint]) : undefined;
    const fails = pulseFails(s, t, f, ctx, pre ?? EMPTY_AUDITS);
    for (const k of fails) hiddenBy[k] = (hiddenBy[k] ?? 0) + 1;
    if (!fails.length) {
      let cached = pre;
      rows.push({ t, get a() { return (cached ??= pulseAudits(s, t, ctx.enrich?.[t.mint])); } });
    }
  }
  if (col === "new") rows.sort((x, y) => y.t.createdAt - x.t.createdAt);
  else if (col === "final") rows.sort((x, y) => y.t.curvePct - x.t.curvePct || (y.t.lastTradeAt ?? 0) - (x.t.lastTradeAt ?? 0));
  else rows.sort((x, y) => (y.t.migratedAt ?? 0) - (x.t.migratedAt ?? 0));
  return { rows: rows.slice(0, opts.limit ?? 60), hiddenBy, total };
}
/** Placeholder when a filter doesn't look at audits (pulseFails never reads it then). */
const EMPTY_AUDITS: PulseAudits = { holders: 0, devPct: null, top10Pct: 0, snipersPct: 0, bundledPct: 0, insidersPct: null, devLaunches: 0, devMigrated: 0, feesSol: 0, source: "stream" };

// ---------------------------------------------------------------- thresholds (row colouring)

export interface PulseThresholds { devPct: number; top10Pct: number; snipersPct: number; insidersPct: number; bundledPct: number; minHolders: number }
export const DEFAULT_THRESHOLDS: PulseThresholds = { devPct: 10, top10Pct: 30, snipersPct: 15, insidersPct: 15, bundledPct: 15, minHolders: 10 };

/** Which audits cross your thresholds (shown as warnings; everything else stays muted). */
export function auditFlags(a: PulseAudits, th: PulseThresholds): Partial<Record<"devPct" | "top10Pct" | "snipersPct" | "insidersPct" | "bundledPct" | "holders", boolean>> {
  return {
    devPct: a.devPct !== null && a.devPct > th.devPct,
    top10Pct: a.top10Pct > th.top10Pct,
    snipersPct: a.snipersPct > th.snipersPct,
    insidersPct: a.insidersPct !== null && a.insidersPct > th.insidersPct,
    bundledPct: a.bundledPct > th.bundledPct,
    holders: a.holders < th.minHolders,
  };
}

// ---------------------------------------------------------------- per-column settings, import / export

export interface PulseColumnSettings {
  filter: PulseColumnFilter;
  /** Quick-buy amount in SOL for this column. */
  amountSol: number;
  /** Trading preset used by this column's quick-buy. */
  preset: "p1" | "p2" | "p3";
  sound: boolean;
}

export interface PulseDisplay {
  density: "compact" | "comfortable";
  avatar: 28 | 36 | 44;
  metrics: Array<"holders" | "top10Pct" | "devPct" | "snipersPct" | "insidersPct" | "bundledPct">;
  columns: Record<PulseColumn, boolean>;
  thresholds: PulseThresholds;
}

export interface PulseSettings {
  version: 1;
  columns: Record<PulseColumn, PulseColumnSettings>;
  display: PulseDisplay;
  hiddenMints: string[];
  hiddenDevs: string[];
}

export function defaultPulseSettings(): PulseSettings {
  const col = (p: Partial<PulseColumnSettings>): PulseColumnSettings => ({ filter: {}, amountSol: 0.1, preset: "p1", sound: false, ...p });
  return {
    version: 1,
    columns: { new: col({ amountSol: 0.05 }), final: col({ amountSol: 0.1 }), migrated: col({ amountSol: 0.25, preset: "p2" }) },
    display: { density: "compact", avatar: 36, metrics: ["holders", "top10Pct", "devPct", "snipersPct", "insidersPct", "bundledPct"], columns: { new: true, final: true, migrated: true }, thresholds: { ...DEFAULT_THRESHOLDS } },
    hiddenMints: [],
    hiddenDevs: [],
  };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
function cleanRange(r: unknown): Range | undefined {
  if (!r || typeof r !== "object") return undefined;
  const o = r as Record<string, unknown>;
  const min = num(o.min), max = num(o.max);
  if (min === undefined && max === undefined) return undefined;
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
}
const AUDIT_KEYS: AuditKey[] = ["devPct", "top10Pct", "snipersPct", "insidersPct", "bundledPct", "holders", "devLaunches", "devMigrated"];
const METRIC_KEYS: MetricKey[] = ["ageSec", "mcapUsd", "liquiditySol", "volSol", "txns", "buys", "sells", "curvePct", "feesSol"];

/** Validate a filter from JSON (import, sync). Unknown keys are dropped; bad values are ignored. */
export function cleanFilter(x: unknown): PulseColumnFilter {
  if (!x || typeof x !== "object") return {};
  const o = x as Record<string, unknown>;
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((s) => typeof s === "string").map((s) => s.slice(0, 40)).slice(0, 30) : undefined);
  const audits: PulseColumnFilter["audits"] = {};
  for (const k of AUDIT_KEYS) { const r = cleanRange((o.audits as Record<string, unknown> | undefined)?.[k]); if (r) audits[k] = r; }
  const metrics: PulseColumnFilter["metrics"] = {};
  for (const k of METRIC_KEYS) { const r = cleanRange((o.metrics as Record<string, unknown> | undefined)?.[k]); if (r) metrics[k] = r; }
  const so = (o.socials ?? {}) as Record<string, unknown>;
  return {
    protocols: (strs(o.protocols) ?? []).filter((p) => ["pumpfun", "letsbonk", "bags", "meteora-dbc", "moonshot", "raydium-launchlab", "other"].includes(p)) as PulseProtocol[],
    keywords: strs(o.keywords) ?? [], exclude: strs(o.exclude) ?? [],
    audits, metrics,
    socials: { x: so.x === true, website: so.website === true, telegram: so.telegram === true, any: so.any === true, excludeReusedX: so.excludeReusedX === true },
    pumpSuffix: o.pumpSuffix === true,
    hideUnknown: o.hideUnknown === true,
  };
}

/** Import Pulse settings (or a single column's filter) from JSON text. Throws a readable error. */
export function importPulseSettings(text: string, base = defaultPulseSettings()): PulseSettings {
  let j: unknown;
  try { j = JSON.parse(text); } catch { throw new Error("That isn't valid JSON."); }
  if (!j || typeof j !== "object") throw new Error("Expected a JSON object.");
  const o = j as Record<string, unknown>;
  const out: PulseSettings = JSON.parse(JSON.stringify(base));
  const cols = (o.columns ?? null) as Record<string, Record<string, unknown>> | null;
  if (!cols) {
    // a bare filter applies to every column
    const f = cleanFilter(o);
    for (const c of ["new", "final", "migrated"] as const) out.columns[c].filter = f;
    return out;
  }
  for (const c of ["new", "final", "migrated"] as const) {
    const x = cols[c];
    if (!x) continue;
    out.columns[c] = {
      filter: cleanFilter(x.filter),
      amountSol: num(x.amountSol) && (x.amountSol as number) > 0 ? (x.amountSol as number) : out.columns[c].amountSol,
      preset: x.preset === "p2" || x.preset === "p3" ? x.preset : "p1",
      sound: x.sound === true,
    };
  }
  return out;
}

export const exportPulseSettings = (s: PulseSettings) => JSON.stringify({ version: 1, columns: s.columns }, null, 2);

/** Plain-English filter summary, e.g. for the column header. */
export function filterCount(f: PulseColumnFilter): number {
  return (f.protocols?.length ? 1 : 0) + (f.keywords?.length ? 1 : 0) + (f.exclude?.length ? 1 : 0)
    + Object.values(f.audits ?? {}).filter(hasRange).length + Object.values(f.metrics ?? {}).filter(hasRange).length
    + Object.values(f.socials ?? {}).filter(Boolean).length + (f.pumpSuffix ? 1 : 0);
}
