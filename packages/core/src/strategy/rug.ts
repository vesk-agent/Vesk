/**
 * The rug check (v19): holder and authority checks before a strategy buy, each switchable. Pure.
 * v20: early concentration and spike-then-dump (the "fake pump" checks, fakePump.ts).
 * Numbers come from watch/audits.ts (the same definitions as Pulse and the coin page) and, when funding data is
 * there, they never link wallets through pools, curves, programs or exchanges (data/clusterExclude.ts).
 */
import type { PulseAudits } from "../watch/audits.js";
import type { RugSettings } from "./settings.js";
import type { Concentration, SpikeDump } from "./fakePump.js";

export interface RugFacts {
  bundledPct?: number | null;
  /** false: bundled was worked out without funding data (an upper bound). */
  bundledExact?: boolean;
  devPct?: number | null;
  top10Pct?: number | null;
  snipersPct?: number | null;
  insidersPct?: number | null;
  holders?: number | null;
  /** The dev's earlier coins this agent has seen (lower bounds). */
  devLaunches?: number | null;
  devRugs?: number | null;
  mintRevoked?: boolean | null;
  freezeRevoked?: boolean | null;
  /** AMM pools only; undefined on a bonding curve. */
  lpLocked?: boolean | null;
  onCurve?: boolean;
  /** v20 (fakePump.ts): undefined = not watched from creation; null = nobody bought a share. */
  concentration?: Concentration | null;
  spikeDump?: SpikeDump;
}

export type RugState = "pass" | "fail" | "unknown" | "off";
export interface RugRow { key: string; label: string; state: RugState; value: string; reason?: string }
export interface RugResult { ok: boolean; reason?: string; rows: RugRow[] }

const pct = (n: number) => `${n % 1 ? n.toFixed(1) : n}%`;

/** Facts from Pulse audits (and what the mint account says). */
export function rugFactsFromAudits(a: PulseAudits, x: { bundledExact?: boolean; devRugs?: number; mintRevoked?: boolean | null; freezeRevoked?: boolean | null; lpLocked?: boolean | null; onCurve?: boolean } = {}): RugFacts {
  return { bundledPct: a.bundledPct, bundledExact: x.bundledExact ?? a.source === "rpc", devPct: a.devPct, top10Pct: a.top10Pct, snipersPct: a.snipersPct, insidersPct: a.insidersPct, holders: a.holders, devLaunches: Math.max(0, a.devLaunches - 1), devRugs: x.devRugs ?? null, mintRevoked: x.mintRevoked, freezeRevoked: x.freezeRevoked, lpLocked: x.lpLocked, onCurve: x.onCurve };
}

export function rugCheck(c: RugSettings, f: RugFacts): RugResult {
  const rows: RugRow[] = [];
  if (!c.enabled) return { ok: true, rows: [{ key: "rug", label: "Rug check", state: "off", value: "off" }] };
  const maxRow = (key: string, label: string, on: boolean, max: number, v: number | null | undefined, why: (v: number) => string, unknownWhy: string) => {
    if (!on) return void rows.push({ key, label, state: "off", value: "off" });
    if (v === null || v === undefined) return void rows.push({ key, label, state: "unknown", value: "unknown", reason: unknownWhy });
    rows.push(v > max ? { key, label, state: "fail", value: pct(v), reason: why(v) } : { key, label, state: "pass", value: pct(v) });
  };
  if (c.allowBundled) rows.push({ key: "bundled", label: "Bundled", state: "off", value: "allowed" });
  else maxRow("bundled", "Bundled", c.maxBundledPct.on, c.maxBundledPct.max, f.bundledPct, (v) => `bundled ${pct(v)} (max ${c.maxBundledPct.max}%)${f.bundledExact === false ? ", without funding data" : ""}`, "bundled unknown");
  maxRow("dev", "Dev holding", c.maxDevPct.on, c.maxDevPct.max, f.devPct, (v) => `dev holds ${v.toFixed(1)}% (max ${c.maxDevPct.max}%)`, "dev holding unknown");
  maxRow("top10", "Top 10", c.maxTop10Pct.on, c.maxTop10Pct.max, f.top10Pct, (v) => `top 10 hold ${v.toFixed(0)}% (max ${c.maxTop10Pct.max}%)`, "top 10 unknown");
  maxRow("snipers", "Snipers", c.maxSnipersPct.on, c.maxSnipersPct.max, f.snipersPct, (v) => `snipers hold ${pct(v)} (max ${c.maxSnipersPct.max}%)`, "snipers unknown");
  maxRow("insiders", "Insiders", c.maxInsidersPct.on, c.maxInsidersPct.max, f.insidersPct, (v) => `insiders hold ${pct(v)} (max ${c.maxInsidersPct.max}%)`, "insiders unknown (no funding data yet)");
  // v20: the fake-pump checks
  const ec = c.earlyConcentration;
  if (!ec || !ec.on) rows.push({ key: "concentration", label: "Early concentration", state: "off", value: "off" });
  else if (f.concentration === undefined) rows.push({ key: "concentration", label: "Early concentration", state: "unknown", value: "unknown", reason: "early buys unknown (not watched from creation)" });
  else if (f.concentration && f.concentration.pct > ec.maxPct) rows.push({ key: "concentration", label: "Early concentration", state: "fail", value: pct(f.concentration.pct), reason: `${f.concentration.who} bought ${pct(f.concentration.pct)} of supply in the first ${Math.max(1, Math.round(f.concentration.sec))} s (max ${ec.maxPct}%)` });
  else rows.push({ key: "concentration", label: "Early concentration", state: "pass", value: f.concentration ? pct(f.concentration.pct) : "0%" });
  const sd = c.spikeDump;
  if (!sd || !sd.on) rows.push({ key: "spikeDump", label: "Spike then dump", state: "off", value: "off" });
  else if (f.spikeDump === undefined) rows.push({ key: "spikeDump", label: "Spike then dump", state: "unknown", value: "unknown", reason: "trades unknown (not watched from creation)" });
  else if (f.spikeDump.hit) rows.push({ key: "spikeDump", label: "Spike then dump", state: "fail", value: "yes", reason: f.spikeDump.reason });
  else rows.push({ key: "spikeDump", label: "Spike then dump", state: "pass", value: "no" });
  if (!c.minHolders.on) rows.push({ key: "holders", label: "Holders", state: "off", value: "off" });
  else if (f.holders === null || f.holders === undefined) rows.push({ key: "holders", label: "Holders", state: "unknown", value: "unknown", reason: "holder count unknown" });
  else rows.push(f.holders < c.minHolders.min ? { key: "holders", label: "Holders", state: "fail", value: String(f.holders), reason: `${f.holders} holders (min ${c.minHolders.min})` } : { key: "holders", label: "Holders", state: "pass", value: String(f.holders) });
  if (!c.devHistory.on) rows.push({ key: "devHistory", label: "Dev history", state: "off", value: "off" });
  else {
    const rugs = f.devRugs ?? 0, launches = f.devLaunches ?? 0;
    if (f.devRugs !== null && f.devRugs !== undefined && rugs > c.devHistory.maxRugs) rows.push({ key: "devHistory", label: "Dev history", state: "fail", value: `${rugs} rugs`, reason: `dev rugged ${rugs} coin${rugs === 1 ? "" : "s"} before (max ${c.devHistory.maxRugs})` });
    else if (launches > c.devHistory.maxLaunches) rows.push({ key: "devHistory", label: "Dev history", state: "fail", value: `${launches} launches`, reason: `dev launched ${launches} coins before (max ${c.devHistory.maxLaunches})` });
    else rows.push({ key: "devHistory", label: "Dev history", state: "pass", value: `${launches} earlier${f.devRugs ? `, ${rugs} rugs` : ""}` });
  }
  const auth = (key: string, label: string, on: boolean, v: boolean | null | undefined, reason: string) => {
    if (!on) return void rows.push({ key, label, state: "off", value: "off" });
    if (v === null || v === undefined) return void rows.push({ key, label, state: "unknown", value: "unknown", reason: `${label.toLowerCase()} unknown` });
    rows.push(v ? { key, label, state: "pass", value: "yes" } : { key, label, state: "fail", value: "no", reason });
  };
  auth("mint", "Mint authority revoked", c.mintRevoked, f.mintRevoked, "mint authority not revoked");
  auth("freeze", "Freeze authority revoked", c.freezeRevoked, f.freezeRevoked, "freeze authority not revoked");
  if (!c.lpLocked) rows.push({ key: "lp", label: "LP burned or locked", state: "off", value: "off" });
  else if (f.onCurve || f.lpLocked === undefined) rows.push({ key: "lp", label: "LP burned or locked", state: "pass", value: f.onCurve ? "bonding curve" : "no LP" });
  else auth("lp", "LP burned or locked", true, f.lpLocked, "LP not burned or locked");

  const fail = rows.find((r) => r.state === "fail");
  if (fail) return { ok: false, reason: fail.reason, rows };
  const unknown = rows.find((r) => r.state === "unknown");
  if (unknown && c.unknown === "refuse") return { ok: false, reason: `${unknown.reason} (you refuse unknowns)`, rows };
  return { ok: true, rows };
}

/**
 * A dev "rug" as the dev-history check counts it: the dev sold at least 80% of the tokens it got at creation within
 * 10 minutes of the create. `sells` are the dev's sells of that coin (tokens, ms).
 */
export function isDevRug(createdAt: number, devInitialTokens: number, sells: Array<{ at: number; tokens: number }>): boolean {
  if (devInitialTokens <= 0) return false;
  const sold = sells.filter((s) => s.at - createdAt <= 10 * 60_000).reduce((a, s) => a + s.tokens, 0);
  return sold >= devInitialTokens * 0.8;
}
