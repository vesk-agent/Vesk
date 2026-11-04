/**
 * Chat → Strategy & safety changes (v19), without a model. "only buy if it does 5 SOL and 20 buys in the first 30
 * seconds", "max dev 8%", "allow bundled", "honeypot check off", "sell if no volume for 2 minutes", "max 4 buys per
 * minute", "use the safe preset", "rogue mode $MOON 0.05 sol each, budget 1 sol, 10 coins". Every change is a list of
 * `setField` patches shown to you first; nothing is saved until you confirm. Pure.
 */
import type { Limits } from "../types.js";
import { setField } from "./fields.js";
import { applyPreset, isStrategyPreset, STRATEGY_PRESETS, type StrategyPresetId, type StrategySettings } from "./settings.js";

export interface StrategyPatch { key: string; value: string }
export type StrategyChat =
  | { kind: "strategy"; patches: StrategyPatch[]; preset?: StrategyPresetId; summary: string[]; errors: string[] }
  | { kind: "rogue"; start: boolean; patches: StrategyPatch[]; summary: string[]; errors: string[] };

const N = String.raw`(\d+(?:\.\d+)?)`;
const secs = (t: string): number | undefined => {
  const m = new RegExp(String.raw`(?:first|in|within|for|over|after)\s+(?:the\s+(?:first\s+)?)?${N}\s*(s|sec|secs|seconds?|m|min|mins|minutes?)\b`, "i").exec(t);
  return m ? Math.round(Number(m[1]) * (/^m/i.test(m[2]) ? 60 : 1)) : undefined;
};
const pctOf = (t: string, words: string): number | undefined => {
  const m = new RegExp(String.raw`(?:max(?:imum)?\s+)?(?:${words})(?:\s+(?:holding|hold|holds|share))?\s*(?:under|below|at most|max|<=?|of|to|=)?\s*${N}\s*%`, "i").exec(t)
    ?? new RegExp(String.raw`(?:${words})\s+(?:can|may)\s+hold\s+(?:up to|at most)\s+${N}\s*%`, "i").exec(t);
  return m ? Number(m[1]) : undefined;
};
const onOff = (t: string): "on" | "off" | undefined => (/\b(off|disable|disabled|stop|no)\b/i.test(t) ? "off" : /\b(on|enable|enabled|start|use)\b/i.test(t) ? "on" : undefined);

/** A Strategy & safety request, or null (then the other parsers run). */
export function parseStrategyRequest(input: string): StrategyChat | null {
  const t = input.trim().toLowerCase().replace(/[’‘]/g, "'");
  // Rogue mode
  if (/\brogue\b/.test(t)) {
    if (/\b(stop|end|turn off|disable|exit|cancel)\b.*\brogue\b|\brogue\b.*\b(off|stop)\b/.test(t)) return { kind: "rogue", start: false, patches: [], summary: ["Turn Rogue mode off (open coins keep their exits)"], errors: [] };
    const p: StrategyPatch[] = [];
    const tick = /\$([a-z0-9]{2,12})\b/.exec(t)?.[1] ?? /\bticker\s+([a-z0-9]{2,12})\b/.exec(t)?.[1];
    if (tick) p.push({ key: "rogue.ticker", value: tick.toUpperCase() });
    const kw = /\b(?:keywords?|named|name has|names? with)\s+["']?([a-z0-9 ,]{2,60}?)["']?(?:[.;]|$|\s+(?:for|with|budget|at)\b)/.exec(t)?.[1];
    if (kw) p.push({ key: "rogue.keywords", value: kw.split(/,|\band\b/).map((x) => x.trim()).filter(Boolean).join(",") });
    const each = new RegExp(String.raw`${N}\s*sol\s*(?:each|per coin|a coin|apiece)`).exec(t)?.[1];
    if (each) p.push({ key: "rogue.perCoinSol", value: each });
    const budget = new RegExp(String.raw`budget\s*(?:of\s*)?${N}\s*sol|${N}\s*sol\s*(?:budget|total|in total|max total)`).exec(t);
    if (budget) p.push({ key: "rogue.budgetSol", value: budget[1] ?? budget[2] });
    const coins = /(\d{1,2})\s*coins/.exec(t)?.[1];
    if (coins) p.push({ key: "rogue.maxCoins", value: coins });
    const win = /\bfor\s+(\d{1,3})\s*(?:min|mins|minutes)\b/.exec(t)?.[1];
    if (win) p.push({ key: "rogue.windowMin", value: win });
    const keep = /\bkeep\s+(?:the\s+)?top\s+([12])\b/.exec(t)?.[1];
    if (keep) p.push({ key: "rogue.keepTop", value: keep });
    if (/\b(?:no|without|skip)\s+(?:the\s+)?(?:honeypot|can[\s-]?sell)/.test(t)) p.push({ key: "rogue.honeypot", value: "off" });
    const errors = !tick && !kw ? ["Rogue mode needs a target: a $TICKER or name keywords."] : [];
    const summary = ["Start Rogue mode", ...p.map((x) => `${x.key.replace("rogue.", "")}: ${x.value}`), "Skips the early-volume trigger and the holder checks; your hard limits, the kill switch and one wallet per coin still apply"];
    if (p.some((x) => x.key === "rogue.honeypot")) summary.push("The can-sell check would be OFF for this session (you'll be asked twice)");
    return { kind: "rogue", start: true, patches: p, summary, errors };
  }
  // other agents' things: snipe rules, copies, launches, @handles
  if (/@[a-z0-9_]{1,15}\b|\bcopy\b|\blaunch(?:es|ing)?\b|\bsnipe\b/.test(t)) return null;
  const p: StrategyPatch[] = [];
  let preset: StrategyPresetId | undefined;
  const pm = /\b(?:use|switch to|apply|go|set|pick)\s+(?:the\s+|to\s+)?(safe|balanced|degen)\b/.exec(t) ?? /\b(safe|balanced|degen)\s+(?:preset|strategy|mode)\b/.exec(t);
  if (pm && isStrategyPreset(pm[1])) preset = pm[1];
  if (/\b(early[\s-]?volume|volume in the first|in the first|within the first|first\s+\d+\s*(?:s|sec|seconds|min))\b/.test(t)) {
    if (/\b(?:turn off|disable|no)\s+(?:the\s+)?early[\s-]?volume|early[\s-]?volume\s+(?:trigger\s+)?off\b/.test(t)) p.push({ key: "entry.earlyVolume.enabled", value: "off" });
    else {
      p.push({ key: "entry.earlyVolume.enabled", value: "on" });
      const w = secs(t);
      if (w !== undefined) p.push({ key: "entry.earlyVolume.windowSec", value: String(w) });
      const v = new RegExp(String.raw`${N}\s*sol(?:\s+(?:of\s+)?(?:volume|vol))?`).exec(t)?.[1];
      if (v) p.push({ key: "entry.earlyVolume.minVolSol", value: v });
      const b = /(\d{1,5})\s*buys\b/.exec(t)?.[1];
      if (b) p.push({ key: "entry.earlyVolume.minBuys", value: b });
      const u = /(\d{1,5})\s*(?:unique\s+)?(?:buyers|wallets)\b/.exec(t)?.[1];
      if (u) p.push({ key: "entry.earlyVolume.minBuyers", value: u });
      if (/\bor\b/.test(t) && [v, b, u].filter(Boolean).length > 1) p.push({ key: "entry.earlyVolume.need", value: "any" });
      else if ([v, b, u].filter(Boolean).length > 1) p.push({ key: "entry.earlyVolume.need", value: "all" });
    }
  }
  const checks: Array<[string, string]> = [["rug.maxDevPct", "dev|devs|creator"], ["rug.maxBundledPct", "bundled|bundle|bundles"], ["rug.maxTop10Pct", "top\\s?10|top ten"], ["rug.maxSnipersPct", "snipers?"], ["rug.maxInsidersPct", "insiders?"]];
  for (const [key, words] of checks) {
    const v = pctOf(t, words);
    if (v !== undefined) p.push({ key, value: String(v) });
    else if (new RegExp(String.raw`\b(?:turn off|disable|ignore|skip)\s+(?:the\s+)?(?:${words})\s+check`).test(t)) p.push({ key, value: "off" });
  }
  if (/\b(?:allow|ride|buy)\s+(?:heavily\s+)?bundled\b/.test(t) && !/\b(?:don'?t|do not|never|stop)\s+(?:allow|ride|buy)/.test(t)) p.push({ key: "rug.allowBundled", value: "on" });
  else if (/\b(?:don'?t|do not|never|stop)\s+(?:allow(?:ing)?|rid(?:e|ing)|buy(?:ing)?)\s+bundled|\brefuse\s+bundled/.test(t)) p.push({ key: "rug.allowBundled", value: "off" });
  const h = /(?:min(?:imum)?|at least)\s+(\d{1,6})\s+holders/.exec(t)?.[1];
  if (h) p.push({ key: "rug.minHolders", value: h });
  if (/\b(honeypot|can[\s-]?sell)\b/.test(t) && onOff(t)) p.push({ key: "honeypot.enabled", value: onOff(t)! });
  const tax = new RegExp(String.raw`tax\s*(?:under|below|max|at most|<=?|of|to)?\s*${N}\s*%`).exec(t)?.[1];
  if (tax) p.push({ key: "honeypot.maxTaxPct", value: tax });
  if (/\bno[\s-]?volume\b|\bvolume (?:dies|stalls|dries up)\b|\bgoes quiet\b/.test(t)) {
    p.push({ key: "exits.noVolume.enabled", value: /\b(?:turn off|disable)\b/.test(t) ? "off" : "on" });
    const w = secs(t);
    if (w !== undefined) p.push({ key: "exits.noVolume.windowSec", value: String(w) });
    const v = new RegExp(String.raw`(?:under|below|less than)\s*${N}\s*sol`).exec(t)?.[1];
    if (v) p.push({ key: "exits.noVolume.minVolSol", value: v });
  }
  const bpm = /(\d{1,3})\s*buys?\s*(?:a|per|\/)\s*min(?:ute)?\b/.exec(t)?.[1];
  if (bpm) p.push({ key: "limits.maxBuysPerMinute", value: bpm });
  if (/\b(?:auto[\s-]?buy|buy)\s+new\s+coins(?:\s+automatically)?\b/.test(t)) p.push({ key: "entry.autoNewCoins", value: onOff(t) === "off" ? "off" : "on" });
  if (!p.length && !preset) return null;
  return { kind: "strategy", patches: p, preset, summary: [...(preset ? [`Use the ${STRATEGY_PRESETS[preset].label} preset: ${STRATEGY_PRESETS[preset].line}`] : []), ...p.map((x) => `${x.key}: ${x.value}`)], errors: [] };
}

/**
 * Apply chat patches (after you confirm). Returns the new strategy and any hard-limit changes, the lines to show, and
 * the first error (nothing is applied when there is one).
 */
export function applyStrategyChat(s: StrategySettings, r: StrategyChat, limits: Limits, now = Date.now()): { ok: true; strategy: StrategySettings; limits?: Partial<Limits>; lines: string[] } | { ok: false; error: string } {
  if (r.kind === "rogue" && !r.start) return { ok: true, strategy: { ...s, mode: "normal", rogueStartedAt: undefined }, lines: ["Rogue mode off"] };
  let cur = r.kind === "strategy" && r.preset ? applyPreset(s, r.preset) : s;
  let lim: Partial<Limits> | undefined;
  const lines: string[] = r.kind === "strategy" && r.preset ? [`${STRATEGY_PRESETS[r.preset].label} preset`] : [];
  for (const x of r.patches) {
    const res = setField(cur, x.key, x.value, { ...limits, ...lim } as Limits);
    if (!res.ok) return { ok: false, error: res.error };
    cur = res.strategy;
    if (res.limits) lim = { ...lim, ...res.limits };
    lines.push(res.text);
  }
  if (r.kind === "rogue") { cur = { ...cur, mode: "rogue", rogueStartedAt: now }; lines.unshift("Rogue mode on"); }
  return { ok: true, strategy: cur, limits: lim, lines };
}
