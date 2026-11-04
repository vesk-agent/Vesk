/**
 * Copy trading settings: the wallets you copy and how.
 *
 * A global default profile applies to every tracked wallet; each wallet can override any part of it. Profiles hold
 * the mode (alert / confirm / auto), how much to buy, whether to mirror sells, entry filters, exits, limits, the
 * execution preset and an optional delay. Pure data and validation: no I/O, shared by the agent, the panel and the
 * edge function.
 *
 * Guardrails that never change here: copies buy from your one active trading wallet (one wallet per coin), the
 * blacklist and the agent-wide limits still apply, and there is no multi-wallet copy buying.
 */
import { isPubkey } from "../base58.js";
import type { ExitSpec } from "../types.js";
import type { MevMode, PresetId } from "../trade/settings.js";
import { importBook, parseCsv, type BookEntry } from "../wallet/book.js";

export type CopyMode = "alert" | "confirm" | "auto";
export type AmountMode = "fixed" | "pct" | "multiple";
export type SellMode = "off" | "mirror" | "all";
/** Where a trade happened, as far as the transaction shows. */
export type CopyVenue = "pumpfun" | "pumpswap" | "launchlab" | "raydium" | "meteora" | "orca" | "jupiter" | "unknown";
export const COPY_VENUES: CopyVenue[] = ["pumpfun", "pumpswap", "launchlab", "raydium", "meteora", "orca", "jupiter"];
export const VENUE_LABEL: Record<CopyVenue, string> = {
  pumpfun: "pump.fun curve", pumpswap: "PumpSwap", launchlab: "LaunchLab (Bonk)", raydium: "Raydium", meteora: "Meteora", orca: "Orca", jupiter: "Jupiter route", unknown: "Unknown",
};
/** Colour tags for tracked wallets. No green / red / amber: those mean PnL and warnings in Vesk. */
export const COPY_TAGS = ["ice", "violet", "indigo", "teal", "sand", "slate", "none"] as const;
export type CopyTag = (typeof COPY_TAGS)[number];
export type TemplateId = "conservative" | "balanced" | "aggressive" | "custom";

export interface CopyAmount {
  mode: AmountMode;
  /** fixed: SOL per copy. pct: % of their buy (1-1000). multiple: × their buy (0.01-10). */
  value: number;
  /** The copy is clamped to [minSol, maxSol]. */
  minSol: number;
  maxSol: number;
}

export interface CopyFilters {
  /** Market cap (USD) at the moment of their buy. */
  minMcapUsd?: number;
  maxMcapUsd?: number;
  minLiquiditySol?: number;
  /** Token age in seconds at their buy. */
  minAgeSec?: number;
  maxAgeSec?: number;
  /** Only copy when their buy is at least this much SOL. */
  minTargetBuySol?: number;
  maxDevPct?: number;
  maxTop10Pct?: number;
  maxBundledPct?: number;
  /** Mint / freeze authority must be revoked. */
  mintRevoked?: boolean;
  freezeRevoked?: boolean;
  requireSocials?: Array<"x" | "telegram" | "website">;
  /** Only these venues (empty = any). */
  venues?: CopyVenue[];
  /** Copy only their first buy of a coin (not adds). */
  firstBuyOnly: boolean;
  /** Name or ticker must contain one of these / must not contain any of these (case-insensitive). */
  include?: string[];
  exclude?: string[];
  /** When a filter needs data that isn't available (e.g. RPC refused the holder scan): skip (default) or allow. */
  missingData: "skip" | "allow";
}

export interface CopyLimits {
  maxSolPerTrade: number;
  maxSolPerWalletDay: number;
  maxSolTotalDay: number;
  maxOpenCopies: number;
  /** Don't copy the same coin again within this many seconds (any wallet). */
  tokenCooldownSec: number;
}

export interface CopyProfile {
  mode: CopyMode;
  buys: boolean;
  amount: CopyAmount;
  sells: SellMode;
  filters: CopyFilters;
  /** Exits on each copied position (take-profit ladder, stop-loss, trailing, timed sells, market-cap targets). */
  exit: ExitSpec;
  limits: CopyLimits;
  /** Trading preset (slippage, fee, tip); `mev` overrides the preset's MEV mode for copies. */
  preset: PresetId;
  mev?: MevMode;
  /** Wait this long before sending (0 = as soon as detected). */
  delayMs: number;
}

/** Per-wallet changes on top of the defaults. A filter set to null is switched off for that wallet. */
export type CopyOverrides = Partial<Omit<CopyProfile, "amount" | "filters" | "limits">> & {
  amount?: Partial<CopyAmount>;
  filters?: { [K in keyof CopyFilters]?: CopyFilters[K] | null };
  limits?: Partial<CopyLimits>;
};

export interface CopyWallet {
  address: string;
  label: string;
  tag: CopyTag;
  group?: string;
  notes?: string;
  enabled: boolean;
  /** The template last applied (display only; the values live in overrides). */
  template?: TemplateId;
  overrides?: CopyOverrides;
  addedAt: string;
}

export interface CopySources {
  /** PumpPortal subscribeAccountTrade (pump.fun and Bonk trades only). */
  pumpportal: boolean;
  /** Your RPC websocket: logsSubscribe mentions per wallet, then getTransaction (every venue). */
  rpc: boolean;
  /** "processed" is faster; getTransaction is retried until the tx is readable. */
  rpcCommitment: "processed" | "confirmed";
  /** Optional faster stream. helius: enhanced websocket transactionSubscribe. yellowstone: interface only (not built in). */
  adapter: "none" | "helius" | "yellowstone";
  /** Name of the key in your keystore that holds the adapter URL (with its API key). */
  adapterUrlKey?: string;
}

export interface CopyConfig {
  /** Master switch. Off: nothing is copied or alerted, wallets keep their settings. */
  enabled: boolean;
  defaults: CopyProfile;
  wallets: CopyWallet[];
  groups: string[];
  sources: CopySources;
}

export const COPY_MAX_WALLETS = 10_000;
export const COPY_MAX_DELAY_MS = 60_000;

const base = (): CopyProfile => ({
  mode: "confirm",
  buys: true,
  amount: { mode: "fixed", value: 0.05, minSol: 0.01, maxSol: 0.1 },
  sells: "mirror",
  filters: { maxMcapUsd: 250_000, firstBuyOnly: true, missingData: "skip" },
  exit: { takeProfit: [{ atMultiple: 2, sellPct: 50 }], stopLossPct: 30 },
  limits: { maxSolPerTrade: 0.1, maxSolPerWalletDay: 0.5, maxSolTotalDay: 1, maxOpenCopies: 5, tokenCooldownSec: 300 },
  preset: "p2",
  delayMs: 0,
});

/** Profile templates. Starting points, not advice: every number is yours to change. */
export const TEMPLATES: Record<Exclude<TemplateId, "custom">, { label: string; blurb: string; profile: CopyProfile }> = {
  conservative: {
    label: "Conservative", blurb: "Confirm every copy, small fixed size, low market caps with holder checks, first buys only.",
    profile: {
      ...base(), mode: "confirm",
      amount: { mode: "fixed", value: 0.05, minSol: 0.01, maxSol: 0.1 },
      filters: { maxMcapUsd: 250_000, minLiquiditySol: 10, maxDevPct: 10, maxTop10Pct: 30, maxBundledPct: 15, minTargetBuySol: 0.5, requireSocials: ["x"], firstBuyOnly: true, missingData: "skip" },
      exit: { takeProfit: [{ atMultiple: 2, sellPct: 50 }, { atMultiple: 4, sellPct: 100 }], stopLossPct: 25 },
      limits: { maxSolPerTrade: 0.1, maxSolPerWalletDay: 0.3, maxSolTotalDay: 1, maxOpenCopies: 5, tokenCooldownSec: 600 },
      preset: "p2",
    },
  },
  balanced: {
    label: "Balanced", blurb: "Auto copy at 25% of their size, mirror sells, market cap up to $1M, trailing stop.",
    profile: {
      ...base(), mode: "auto",
      amount: { mode: "pct", value: 25, minSol: 0.02, maxSol: 0.25 },
      filters: { maxMcapUsd: 1_000_000, minLiquiditySol: 5, maxDevPct: 15, maxTop10Pct: 40, firstBuyOnly: true, missingData: "skip" },
      exit: { takeProfit: [{ atMultiple: 2, sellPct: 50 }, { atMultiple: 5, sellPct: 100 }], stopLossPct: 35, trailingStopPct: 25 },
      limits: { maxSolPerTrade: 0.25, maxSolPerWalletDay: 1, maxSolTotalDay: 3, maxOpenCopies: 10, tokenCooldownSec: 300 },
      preset: "p2",
    },
  },
  aggressive: {
    label: "Aggressive", blurb: "Auto copy at half their size, every buy, sell all when they sell, fewer filters. Loses faster too.",
    profile: {
      ...base(), mode: "auto",
      amount: { mode: "multiple", value: 0.5, minSol: 0.05, maxSol: 0.5 },
      sells: "all",
      filters: { maxMcapUsd: 5_000_000, firstBuyOnly: false, missingData: "allow" },
      exit: { takeProfit: [{ atMultiple: 3, sellPct: 50 }], stopLossPct: 45 },
      limits: { maxSolPerTrade: 0.5, maxSolPerWalletDay: 2, maxSolTotalDay: 5, maxOpenCopies: 20, tokenCooldownSec: 60 },
      preset: "p3",
    },
  },
};

export const defaultCopyProfile = (): CopyProfile => structuredClone(TEMPLATES.balanced.profile);
export const defaultCopyConfig = (): CopyConfig => ({
  enabled: true, defaults: defaultCopyProfile(), wallets: [], groups: [],
  sources: { pumpportal: true, rpc: true, rpcCommitment: "confirmed", adapter: "none" },
});

/** A template as overrides for one wallet (bulk edit → "Apply template"). */
export function templateOverrides(id: TemplateId): CopyOverrides {
  return id === "custom" ? {} : structuredClone(TEMPLATES[id].profile);
}

/** Defaults with the wallet's overrides on top. Nested sections merge field by field; `exit` replaces as a whole. */
export function effectiveProfile(defaults: CopyProfile, w?: Pick<CopyWallet, "overrides">): CopyProfile {
  const o = w?.overrides ?? {};
  return {
    ...defaults, ...strip(o),
    amount: { ...defaults.amount, ...(o.amount ?? {}) },
    filters: dropNulls({ ...defaults.filters, ...(o.filters ?? {}) }) as unknown as CopyFilters,
    limits: { ...defaults.limits, ...(o.limits ?? {}) },
    exit: o.exit ?? defaults.exit,
  };
}
const dropNulls = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
function strip(o: CopyOverrides): Partial<CopyProfile> {
  const { amount: _a, filters: _f, limits: _l, exit: _e, ...rest } = o;
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Partial<CopyProfile>;
}

/** Which fields of the effective profile differ from the defaults (shown as "overridden" in the panel). */
export function overriddenFields(o: CopyOverrides | undefined): string[] {
  if (!o) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) continue;
    if (k === "amount" || k === "filters" || k === "limits") for (const kk of Object.keys(v as object)) out.push(`${k}.${kk}`);
    else out.push(k);
  }
  return out;
}

export interface CopyFieldError { field: string; message: string }

export function validateProfile(p: CopyProfile, prefix = ""): CopyFieldError[] {
  const e: CopyFieldError[] = [];
  const err = (field: string, message: string) => e.push({ field: prefix + field, message });
  const pos = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
  if (!["alert", "confirm", "auto"].includes(p.mode)) err("mode", "Mode is alert, confirm or auto.");
  if (!["off", "mirror", "all"].includes(p.sells)) err("sells", "Sells are off, mirror or all.");
  const a = p.amount;
  if (!["fixed", "pct", "multiple"].includes(a.mode)) err("amount.mode", "Amount is fixed SOL, % of their buy, or a multiple of it.");
  if (!pos(a.value)) err("amount.value", "Amount must be above 0.");
  else if (a.mode === "pct" && a.value > 1000) err("amount.value", "Up to 1000% of their buy.");
  else if (a.mode === "multiple" && (a.value < 0.01 || a.value > 10)) err("amount.value", "A multiple between 0.01× and 10×.");
  if (!(a.minSol >= 0)) err("amount.minSol", "Min can't be negative.");
  if (!pos(a.maxSol)) err("amount.maxSol", "Max must be above 0.");
  else if (a.minSol > a.maxSol) err("amount.minSol", "Min is above max.");
  const f = p.filters;
  if (f.minMcapUsd !== undefined && f.maxMcapUsd !== undefined && f.minMcapUsd > f.maxMcapUsd) err("filters.maxMcapUsd", "Max market cap is below min.");
  if (f.minAgeSec !== undefined && f.maxAgeSec !== undefined && f.minAgeSec > f.maxAgeSec) err("filters.maxAgeSec", "Max age is below min.");
  for (const k of ["maxDevPct", "maxTop10Pct", "maxBundledPct"] as const) if (f[k] !== undefined && !(f[k]! >= 0 && f[k]! <= 100)) err(`filters.${k}`, "0-100%.");
  for (const k of ["minMcapUsd", "maxMcapUsd", "minLiquiditySol", "minAgeSec", "maxAgeSec", "minTargetBuySol"] as const) if (f[k] !== undefined && !(f[k]! >= 0)) err(`filters.${k}`, "Can't be negative.");
  if (f.venues?.some((v) => !COPY_VENUES.includes(v))) err("filters.venues", `Venues are ${COPY_VENUES.join(", ")}.`);
  const l = p.limits;
  for (const k of ["maxSolPerTrade", "maxSolPerWalletDay", "maxSolTotalDay"] as const) if (!pos(l[k])) err(`limits.${k}`, "Must be above 0.");
  if (!(Number.isInteger(l.maxOpenCopies) && l.maxOpenCopies >= 1)) err("limits.maxOpenCopies", "At least 1.");
  if (!(l.tokenCooldownSec >= 0)) err("limits.tokenCooldownSec", "Can't be negative.");
  if (pos(a.maxSol) && pos(l.maxSolPerTrade) && a.minSol > l.maxSolPerTrade) err("amount.minSol", "Min copy is above your max per trade.");
  if (!["p1", "p2", "p3"].includes(p.preset)) err("preset", "Preset is p1, p2 or p3.");
  if (p.mev !== undefined && !["off", "reduced", "secure"].includes(p.mev)) err("mev", "MEV mode is off, reduced or secure.");
  if (!(Number.isInteger(p.delayMs) && p.delayMs >= 0 && p.delayMs <= COPY_MAX_DELAY_MS)) err("delayMs", `0-${COPY_MAX_DELAY_MS} ms.`);
  const tp = p.exit.takeProfit ?? [];
  for (let i = 0; i < tp.length; i++) {
    if (!(tp[i].atMultiple > 1)) err(`exit.takeProfit.${i}`, "Take-profit multiples are above 1x.");
    if (!(tp[i].sellPct >= 1 && tp[i].sellPct <= 100)) err(`exit.takeProfit.${i}`, "Sell 1-100%.");
    if (i && tp[i].atMultiple <= tp[i - 1].atMultiple) err(`exit.takeProfit.${i}`, "Steps go up.");
  }
  if (p.exit.stopLossPct !== undefined && !(p.exit.stopLossPct >= 1 && p.exit.stopLossPct <= 99)) err("exit.stopLossPct", "Stop-loss is 1-99%.");
  if (p.exit.trailingStopPct !== undefined && !(p.exit.trailingStopPct >= 1 && p.exit.trailingStopPct <= 99)) err("exit.trailingStopPct", "Trailing stop is 1-99%.");
  return e;
}

export function validateCopyWallet(w: Partial<CopyWallet>, defaults: CopyProfile): CopyFieldError[] {
  const e: CopyFieldError[] = [];
  if (!w.address || !isPubkey(w.address)) e.push({ field: "address", message: `"${w.address ?? ""}" isn't a Solana address.` });
  if (!w.label?.trim()) e.push({ field: "label", message: "Give it a label." });
  else if (w.label.length > 32) e.push({ field: "label", message: "Labels are up to 32 characters." });
  if (w.tag && !(COPY_TAGS as readonly string[]).includes(w.tag)) e.push({ field: "tag", message: `Tag is one of ${COPY_TAGS.join(", ")}.` });
  if ((w.notes ?? "").length > 500) e.push({ field: "notes", message: "Notes are up to 500 characters." });
  if ((w.group ?? "").length > 32) e.push({ field: "group", message: "Group names are up to 32 characters." });
  e.push(...validateProfile(effectiveProfile(defaults, w), ""));
  return e;
}


/** Fill gaps and drop junk from a stored config (old versions, hand-edited files, the panel). */
export function normalizeCopyConfig(x: unknown): CopyConfig {
  const d = defaultCopyConfig();
  const o = (x && typeof x === "object" ? x : {}) as Partial<CopyConfig>;
  const defaults = o.defaults ? effectiveProfile(d.defaults, { overrides: o.defaults as CopyOverrides }) : d.defaults;
  const seen = new Set<string>();
  const wallets: CopyWallet[] = [];
  for (const w of Array.isArray(o.wallets) ? o.wallets : []) {
    const addr = String(w?.address ?? "").trim();
    if (!isPubkey(addr) || seen.has(addr) || wallets.length >= COPY_MAX_WALLETS) continue;
    seen.add(addr);
    wallets.push({
      address: addr, label: String(w.label ?? "").trim().slice(0, 32) || shortAddr(addr), tag: (COPY_TAGS as readonly string[]).includes(w.tag) ? w.tag : "none",
      group: w.group ? String(w.group).slice(0, 32) : undefined, notes: w.notes ? String(w.notes).slice(0, 500) : undefined, enabled: w.enabled !== false,
      template: w.template, overrides: w.overrides && typeof w.overrides === "object" ? w.overrides : undefined, addedAt: w.addedAt ?? new Date(0).toISOString(),
    });
  }
  const groups = [...new Set([...(Array.isArray(o.groups) ? o.groups : []), ...wallets.map((w) => w.group).filter(Boolean)].map(String))].slice(0, 200);
  const s = (o.sources ?? {}) as Partial<CopySources>;
  return {
    enabled: o.enabled !== false, defaults, wallets, groups,
    sources: {
      pumpportal: s.pumpportal !== false, rpc: s.rpc !== false, rpcCommitment: s.rpcCommitment === "processed" ? "processed" : "confirmed",
      adapter: s.adapter === "helius" || s.adapter === "yellowstone" ? s.adapter : "none", adapterUrlKey: s.adapterUrlKey,
    },
  };
}

export const shortAddr = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** Add or replace a wallet (by address). Throws with the first validation error. */
export function upsertCopyWallet(c: CopyConfig, w: Partial<CopyWallet> & { address: string }, now = new Date()): CopyConfig {
  const cur = c.wallets.find((x) => x.address === w.address);
  const next: CopyWallet = {
    tag: "none", enabled: true, addedAt: now.toISOString(), ...cur, ...w,
    label: (w.label ?? cur?.label ?? shortAddr(w.address)).trim(),
    overrides: w.overrides === undefined ? cur?.overrides : w.overrides,
  };
  const bad = validateCopyWallet(next, c.defaults);
  if (bad.length) throw new Error(`${bad[0].field}: ${bad[0].message}`);
  if (!cur && c.wallets.length >= COPY_MAX_WALLETS) throw new Error(`Up to ${COPY_MAX_WALLETS} wallets.`);
  const wallets = cur ? c.wallets.map((x) => (x.address === w.address ? next : x)) : [...c.wallets, next];
  const groups = next.group && !c.groups.includes(next.group) ? [...c.groups, next.group] : c.groups;
  return { ...c, wallets, groups };
}

/** Merge overrides into a wallet (CLI `copy edit`, the panel's drawer and bulk edit). */
export function mergeOverrides(a: CopyOverrides | undefined, b: CopyOverrides): CopyOverrides {
  const x = a ?? {};
  return {
    ...x, ...b,
    ...(x.amount || b.amount ? { amount: { ...(x.amount ?? {}), ...(b.amount ?? {}) } } : {}),
    ...(x.filters || b.filters ? { filters: { ...(x.filters ?? {}), ...(b.filters ?? {}) } } : {}),
    ...(x.limits || b.limits ? { limits: { ...(x.limits ?? {}), ...(b.limits ?? {}) } } : {}),
  };
}

/** Bulk edit: the same overrides (or a template) on many wallets at once. */
export function bulkEdit(c: CopyConfig, addresses: string[], patch: { overrides?: CopyOverrides; template?: TemplateId; enabled?: boolean; group?: string | null; tag?: CopyTag }): CopyConfig {
  const set = new Set(addresses);
  return {
    ...c,
    groups: patch.group && !c.groups.includes(patch.group) ? [...c.groups, patch.group] : c.groups,
    wallets: c.wallets.map((w) => {
      if (!set.has(w.address)) return w;
      let n: CopyWallet = { ...w };
      if (patch.template) n = { ...n, template: patch.template, overrides: patch.template === "custom" ? n.overrides : templateOverrides(patch.template) };
      if (patch.overrides) n = { ...n, template: "custom", overrides: mergeOverrides(n.overrides, patch.overrides) };
      if (patch.enabled !== undefined) n.enabled = patch.enabled;
      if (patch.group !== undefined) n.group = patch.group ?? undefined;
      if (patch.tag) n.tag = patch.tag;
      return n;
    }),
  };
}

// ---------- parsing helpers (CLI flags, chat, CSV) ----------

/** "300k" → 300000, "$1.2m" → 1200000. */
export function parseUsdAmount(s: string | number | undefined): number | undefined {
  if (s === undefined || s === "") return undefined;
  if (typeof s === "number") return s;
  const m = s.replace(/[$,\s]/g, "").match(/^(\d+(?:\.\d+)?)([kmb])?$/i);
  if (!m) return NaN;
  return Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase() as "k"] ?? 1);
}

/** "2x:50,5x:100" → take-profit steps. */
export function parseTpLadder(s: string): Array<{ atMultiple: number; sellPct: number }> {
  return s.split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = x.match(/^(\d+(?:\.\d+)?)x?\s*[:@]\s*(\d{1,3})%?$/i);
    if (!m) throw new Error(`"${x}" isn't a take-profit step. Use 2x:50 (sell 50% at 2x).`);
    return { atMultiple: Number(m[1]), sellPct: Number(m[2]) };
  }).sort((a, b) => a.atMultiple - b.atMultiple);
}

/** One wallet per line ("address", "address label", "label,address"), or comma/space separated addresses. */
export function parseWalletList(text: string): { items: Array<{ address: string; label?: string }>; errors: string[] } {
  const items: Array<{ address: string; label?: string }> = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const [i, l] of lines.entries()) {
    const parts = l.split(/[,;\t ]+/).filter(Boolean);
    const addrs = parts.filter(isPubkey);
    if (!addrs.length) { errors.push(`Line ${i + 1}: no Solana address in "${l.slice(0, 40)}"`); continue; }
    const rest = parts.filter((p) => !isPubkey(p)).join(" ").trim();
    for (const a of addrs) {
      if (seen.has(a)) continue;
      seen.add(a);
      items.push({ address: a, label: addrs.length === 1 && rest ? rest.slice(0, 32) : undefined });
    }
  }
  return { items, errors };
}

const csvCell = (v: unknown) => { const s = v === undefined || v === null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const COPY_CSV_HEAD = ["address", "label", "tag", "group", "enabled", "mode", "amount_mode", "amount", "min_sol", "max_sol", "sells", "min_mcap", "max_mcap", "notes"];

/** JSON keeps everything (overrides included); CSV keeps the common fields. */
export function exportCopyWallets(c: CopyConfig, format: "json" | "csv", only?: string[]): string {
  const list = only ? c.wallets.filter((w) => only.includes(w.address)) : c.wallets;
  if (format === "json") return JSON.stringify({ version: 1, kind: "vesk-copy-wallets", wallets: list }, null, 2);
  return [COPY_CSV_HEAD.join(","), ...list.map((w) => {
    const p = effectiveProfile(c.defaults, w);
    return [w.address, w.label, w.tag, w.group, w.enabled ? "yes" : "no", p.mode, p.amount.mode, p.amount.value, p.amount.minSol, p.amount.maxSol, p.sells, p.filters.minMcapUsd, p.filters.maxMcapUsd, w.notes].map(csvCell).join(",");
  })].join("\n");
}

/**
 * Import wallets: Vesk's copy JSON / CSV, an address-book export (JSON or CSV), or a plain list of addresses.
 * Rows that don't validate are reported, not dropped silently.
 */
export function importCopyWallets(text: string, defaults: CopyProfile): { wallets: Array<Partial<CopyWallet> & { address: string }>; errors: string[] } {
  const t = text.trim();
  const errors: string[] = [];
  const out: Array<Partial<CopyWallet> & { address: string }> = [];
  const push = (w: Partial<CopyWallet> & { address: string }, row: string) => {
    const bad = validateCopyWallet({ tag: "none", enabled: true, ...w, label: w.label || shortAddr(w.address) }, defaults);
    if (bad.length) errors.push(`${row}: ${bad[0].message}`);
    else if (out.some((x) => x.address === w.address)) errors.push(`${row}: duplicate of an earlier row.`);
    else out.push(w);
  };
  if (t.startsWith("{") || t.startsWith("[")) {
    let j: unknown;
    try { j = JSON.parse(t); } catch { return { wallets: [], errors: ["That isn't valid JSON."] }; }
    const o = j as { wallets?: unknown[]; entries?: unknown[] };
    if (Array.isArray(o.entries) && !o.wallets) return fromBook(importBook(t).entries, importBook(t).errors);
    const rows = (Array.isArray(j) ? j : o.wallets ?? []) as Array<Partial<CopyWallet>>;
    rows.forEach((r, i) => push({ ...r, address: String(r.address ?? "").trim() }, `Row ${i + 1}`));
    return { wallets: out, errors };
  }
  const first = t.split(/\r?\n/)[0]?.toLowerCase() ?? "";
  if (/(^|,)address(,|$)/.test(first)) {
    if (/(^|,)marker(,|$)/.test(first) && !/(^|,)mode(,|$)/.test(first)) { const b = importBook(t); return fromBook(b.entries, b.errors); }
    const rows = parseCsv(t);
    const head = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
    const col = (n: string) => { const i = head.indexOf(n); return (r: string[]) => (i >= 0 ? r[i]?.trim() : undefined) || undefined; };
    const g = Object.fromEntries(COPY_CSV_HEAD.map((h) => [h, col(h)])) as Record<string, (r: string[]) => string | undefined>;
    rows.forEach((r, i) => {
      const amount: Partial<CopyAmount> = {};
      const am = g.amount_mode(r);
      if (am === "fixed" || am === "pct" || am === "multiple") amount.mode = am;
      if (g.amount(r)) amount.value = Number(g.amount(r));
      if (g.min_sol(r)) amount.minSol = Number(g.min_sol(r));
      if (g.max_sol(r)) amount.maxSol = Number(g.max_sol(r));
      const filters: Partial<CopyFilters> = {};
      if (g.min_mcap(r)) filters.minMcapUsd = parseUsdAmount(g.min_mcap(r));
      if (g.max_mcap(r)) filters.maxMcapUsd = parseUsdAmount(g.max_mcap(r));
      const ov: CopyOverrides = {};
      const mode = g.mode(r);
      if (mode === "alert" || mode === "confirm" || mode === "auto") ov.mode = mode;
      const sells = g.sells(r);
      if (sells === "off" || sells === "mirror" || sells === "all") ov.sells = sells;
      if (Object.keys(amount).length) ov.amount = amount;
      if (Object.keys(filters).length) ov.filters = filters;
      const tag = g.tag(r);
      push({
        address: g.address(r) ?? "", label: g.label(r), tag: (COPY_TAGS as readonly string[]).includes(tag ?? "") ? (tag as CopyTag) : undefined, group: g.group(r), notes: g.notes(r),
        enabled: g.enabled(r) ? /^(yes|true|1|on)$/i.test(g.enabled(r)!) : undefined, overrides: Object.keys(ov).length ? ov : undefined,
      }, `Row ${i + 1}`);
    });
    return { wallets: out, errors };
  }
  const l = parseWalletList(t);
  for (const it of l.items) push({ address: it.address, label: it.label }, shortAddr(it.address));
  return { wallets: out, errors: [...l.errors, ...errors] };

  function fromBook(entries: BookEntry[], errs: string[]) {
    for (const e of entries) push({ address: e.address, label: e.label.slice(0, 32), notes: e.note }, e.label);
    return { wallets: out, errors: [...errs, ...errors] };
  }
}

/** Tracked copy wallets as address-book entries (marked "track"), so the wallet tracker and Pulse see them too. */
export function copyWalletsToBook(c: CopyConfig): BookEntry[] {
  return c.wallets.map((w) => ({ address: w.address, label: w.label.slice(0, 40), marker: "ice", bookmark: false, note: w.notes?.slice(0, 200), track: true }));
}

// ---------- describing ----------

export const usdShort = (n: number) => (n >= 1e9 ? `$${+(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${+(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`);
const fmtSol = (n: number) => `${+n.toFixed(4)} SOL`;

export function describeAmount(a: CopyAmount): string {
  const core = a.mode === "fixed" ? fmtSol(a.value) : a.mode === "pct" ? `${a.value}% of their buy` : `${a.value}× their buy`;
  return a.mode === "fixed" ? core : `${core} (${fmtSol(a.minSol)} to ${fmtSol(a.maxSol)})`;
}

export function describeProfile(p: CopyProfile): string[] {
  const s: string[] = [];
  s.push(`Mode: ${p.mode === "auto" ? "Auto copy" : p.mode === "confirm" ? "Confirm each copy (Telegram / panel)" : "Alert only"}`);
  s.push(p.buys ? `Buy ${describeAmount(p.amount)}` : "Buys: not copied");
  s.push(`Sells: ${p.sells === "off" ? "not copied" : p.sells === "mirror" ? "mirror their sell %" : "sell everything when they sell any"}`);
  const f = p.filters;
  const fl: string[] = [];
  if (f.maxMcapUsd !== undefined) fl.push(`skip above ${usdShort(f.maxMcapUsd)} mcap`);
  if (f.minMcapUsd !== undefined) fl.push(`skip below ${usdShort(f.minMcapUsd)} mcap`);
  if (f.minLiquiditySol !== undefined) fl.push(`liquidity ≥ ${f.minLiquiditySol} SOL`);
  if (f.minTargetBuySol !== undefined) fl.push(`their buy ≥ ${f.minTargetBuySol} SOL`);
  if (f.minAgeSec !== undefined) fl.push(`age ≥ ${f.minAgeSec} s`);
  if (f.maxAgeSec !== undefined) fl.push(`age ≤ ${f.maxAgeSec} s`);
  if (f.maxDevPct !== undefined) fl.push(`dev ≤ ${f.maxDevPct}%`);
  if (f.maxTop10Pct !== undefined) fl.push(`top 10 ≤ ${f.maxTop10Pct}%`);
  if (f.maxBundledPct !== undefined) fl.push(`bundled ≤ ${f.maxBundledPct}%`);
  if (f.mintRevoked) fl.push("mint revoked");
  if (f.freezeRevoked) fl.push("freeze revoked");
  if (f.requireSocials?.length) fl.push(`needs ${f.requireSocials.join(", ")}`);
  if (f.venues?.length) fl.push(`only ${f.venues.map((v) => VENUE_LABEL[v]).join(", ")}`);
  if (f.include?.length) fl.push(`name has ${f.include.join(" or ")}`);
  if (f.exclude?.length) fl.push(`not ${f.exclude.join(", ")}`);
  fl.push(f.firstBuyOnly ? "first buy only" : "every buy");
  s.push(`Filters: ${fl.join(" · ")}`);
  const x = p.exit;
  const ex: string[] = [];
  for (const t of x.takeProfit ?? []) ex.push(`TP ${t.atMultiple}x ${t.sellPct}%`);
  if (x.stopLossPct !== undefined) ex.push(`SL ${x.stopLossPct}%`);
  if (x.trailingStopPct !== undefined) ex.push(`trail ${x.trailingStopPct}%`);
  for (const t of x.timeSells ?? []) ex.push(`${t.sellPct}% after ${t.afterSec} s`);
  for (const t of x.mcapTargets ?? []) ex.push(`${t.sellPct}% at ${usdShort(t.atMcapUsd)}`);
  if (x.timeoutMin !== undefined) ex.push(`all after ${x.timeoutMin} min`);
  s.push(`Exits: ${ex.join(" · ") || "none (sells only when they sell, if mirrored)"}`);
  const l = p.limits;
  s.push(`Limits: ${fmtSol(l.maxSolPerTrade)}/trade · ${fmtSol(l.maxSolPerWalletDay)}/wallet/day · ${fmtSol(l.maxSolTotalDay)}/day · ${l.maxOpenCopies} open · ${l.tokenCooldownSec} s cooldown`);
  s.push(`Execution: ${p.preset.toUpperCase()}${p.mev ? ` · MEV ${p.mev}` : ""}${p.delayMs ? ` · ${p.delayMs} ms delay` : ""}`);
  return s;
}
