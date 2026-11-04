/**
 * "Anything Web3" chat → structured intent, without a model.
 *
 * This deterministic parser handles the common phrasings ("snipe anything @x posts under 50k mcap
 * with 0.5 SOL", "sell half if it 3x's", "stop loss 30%"). When a model is configured, the agent
 * asks it to fill the same `RuleDraft` shape (see models/intent.ts) and the result goes through the
 * same validation. Either way nothing runs until the user confirms the summary.
 */
import { detectMints } from "../ca.js";
import { forbiddenIntent } from "../guardrails.js";
import type { ExitSpec, LaunchFilters, Rule, TakeProfitStep } from "../types.js";
import { defaultRule, normalizeHandle, validateRule, type FieldError } from "./validate.js";
import { parseLaunchRequest, type LaunchDraft } from "../launch/plan.js";
import { parseLaunchRuleRequest, type LaunchOnPostRule } from "../launch/onpost.js";
import { parseCopyRequest, type CopyDraft } from "../copy/parse.js";
import { parseStrategyRequest, type StrategyChat } from "../strategy/chat.js";
import { parseClaimRequest, type ClaimChat } from "../launch/claim.js";
import { parseLaunchInfoRequest, type LaunchInfoChat } from "../launch/onpost.js";
import { parseSupplyRequest, type SupplyChat } from "../coin/supply.js";

export type ParseResult =
  | { kind: "rule"; draft: Rule; summary: string[]; assumptions: string[]; errors: FieldError[] }
  | { kind: "exit"; exit: ExitSpec; summary: string[] }
  | { kind: "trade"; action: "buy" | "sell"; mint: string; amountSol?: number; sellPct?: number; summary: string[] }
  | { kind: "control"; action: "pause" | "resume" | "kill"; summary: string[] }
  | { kind: "launch"; draft: LaunchDraft; summary: string[] }
  | { kind: "launch-rule"; draft: LaunchOnPostRule; summary: string[]; errors: FieldError[] }
  | { kind: "copy"; draft: CopyDraft; summary: string[]; assumptions: string[]; errors: FieldError[] }
  /** v19: Strategy & safety changes and Rogue mode (strategy/chat.ts). Applied only after you confirm. */
  | StrategyChat
  /** v23: "claim my fees" (launch/claim.ts). Shown as a summary; claims only after you confirm. */
  | ClaimChat
  | LaunchInfoChat
  /** v25: "burn 10% of $DIAL", "lock 20% of $DIAL for 90 days" (coin/supply.ts). Plan first; burns only after you confirm. */
  | SupplyChat
  | { kind: "refuse"; reason: string }
  | { kind: "unknown"; hint: string };

const WORD_PCT: Record<string, number> = { half: 50, "a half": 50, "a third": 33, third: 33, "a quarter": 25, quarter: 25, all: 100, everything: 100, "the rest": 100, rest: 100 };
const WORD_MULT: Record<string, number> = { doubles: 2, double: 2, "2x's": 2, triples: 3, triple: 3, "3x's": 3, quadruples: 4, "4x's": 4, "5x's": 5, "10x's": 10 };

/** "50k" → 50000, "$1.2m" → 1200000, "250" → 250 */
export function parseAmount(s: string): number | null {
  const m = s.replace(/[$,\s]/g, "").match(/^(\d+(?:\.\d+)?)([kmb])?$/i);
  if (!m) return null;
  const mul = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase() as "k" | "m" | "b"] ?? 1;
  return Number(m[1]) * mul;
}

const NUM = String.raw`(\d+(?:\.\d+)?)`;
const AMT = String.raw`\$?\s?(\d+(?:[.,]\d+)?\s?[kKmMbB]?)`;

function handlesIn(t: string): string[] {
  const out = new Set<string>();
  for (const m of t.matchAll(/(?:^|[\s,(])@([A-Za-z0-9_]{1,15})\b/g)) out.add(normalizeHandle(m[1]));
  for (const m of t.matchAll(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\b/gi)) out.add(normalizeHandle(m[1]));
  return [...out];
}

function solAmount(t: string): number | undefined {
  const m =
    t.match(new RegExp(String.raw`(?:with|for|using|size|buy|ape|put|spend)\s+${NUM}\s*(?:sol|◎)\b`, "i")) ??
    t.match(new RegExp(String.raw`\b${NUM}\s*(?:sol|◎)\b`, "i"));
  return m ? Number(m[1]) : undefined;
}

function mcap(t: string): number | undefined {
  const m =
    t.match(new RegExp(String.raw`(?:under|below|less than|<|max(?:imum)?|up to)\s*${AMT}\s*(?:mc|mcap|market\s?cap)`, "i")) ??
    t.match(new RegExp(String.raw`(?:mc|mcap|market\s?cap)\s*(?:under|below|<|max|of at most|up to)?\s*${AMT}`, "i"));
  if (!m) return undefined;
  return parseAmount(m[1].replace(",", ".")) ?? undefined;
}

function pctWord(s: string): number | null {
  const k = s.trim().toLowerCase();
  if (WORD_PCT[k] !== undefined) return WORD_PCT[k];
  const m = k.match(/^(\d{1,3})\s*%$/);
  return m ? Math.min(100, Number(m[1])) : null;
}

function multWord(s: string): number | null {
  const k = s.trim().toLowerCase().replace(/’/g, "'");
  if (WORD_MULT[k] !== undefined) return WORD_MULT[k];
  let m = k.match(/^(\d+(?:\.\d+)?)\s*x(?:'?s|es)?$/);
  if (m) return Number(m[1]);
  m = k.match(/^\+?(\d{2,5})\s*%$/);
  if (m) return 1 + Number(m[1]) / 100;
  return null;
}

/** Take-profit steps: "sell half if it 3x's", "take profit 2x sell 25%", "at 5x sell 50%", "sell 30% at +200%". */
function takeProfits(t: string): TakeProfitStep[] {
  const steps: TakeProfitStep[] = [];
  const P = String.raw`(half|a half|a third|third|a quarter|quarter|all|everything|the rest|rest|\d{1,3}\s*%)`;
  const X = String.raw`(\d+(?:\.\d+)?\s*x(?:'?s|es)?|doubles|double|triples|triple|quadruples|\+?\d{2,5}\s*%)`;
  const re1 = new RegExp(String.raw`sell\s+${P}(?:\s+of\s+it)?\s+(?:if|when|once|at)\s+(?:it\s+|price\s+)?(?:hits\s+|reaches\s+|does\s+|is\s+(?:up\s+)?)?${X}`, "gi");
  const re2 = new RegExp(String.raw`(?:tp|take[\s-]?profit|at|on)\s+${X}\s*,?\s*(?:sell\s+|take\s+)?${P}`, "gi");
  for (const m of t.matchAll(re1)) {
    const p = pctWord(m[1]), x = multWord(m[2]);
    if (p && x && x > 1) steps.push({ atMultiple: x, sellPct: p });
  }
  for (const m of t.matchAll(re2)) {
    const x = multWord(m[1]), p = pctWord(m[2]);
    if (p && x && x > 1 && !steps.some((s) => s.atMultiple === x)) steps.push({ atMultiple: x, sellPct: p });
  }
  return steps.sort((a, b) => a.atMultiple - b.atMultiple);
}

function exitSpec(t: string): ExitSpec {
  const x: ExitSpec = {};
  const tp = takeProfits(t);
  if (tp.length) x.takeProfit = tp;
  const sl = t.match(/(?:stop[\s-]?loss|sl|cut(?:\s+it)?(?:\s+at)?|bail(?:\s+at)?)\s*(?:at|of)?\s*-?\s*(\d{1,2})\s*%/i) ?? t.match(/(?:if|when)\s+(?:it\s+)?(?:drops|dumps|falls|is\s+down)\s+(\d{1,2})\s*%/i);
  if (sl) x.stopLossPct = Number(sl[1]);
  const tr = t.match(/trail(?:ing)?(?:\s+stop)?\s*(?:of|at)?\s*(\d{1,2})\s*%/i);
  if (tr) x.trailingStopPct = Number(tr[1]);
  const to = t.match(/(?:sell|exit|close)\s+(?:everything\s+|all\s+)?(?:after|in)\s+(\d{1,4})\s*(m|min|mins|minutes|h|hr|hrs|hours)\b/i);
  if (to) x.timeoutMin = Number(to[1]) * (/^h/i.test(to[2]) ? 60 : 1);
  return x;
}

function launchFilters(t: string): LaunchFilters {
  const f: LaunchFilters = {};
  const dev = t.match(/dev\s*(?:holds?|holding|wallet|bag|buy)?\s*(?:under|below|<|max|at most|less than)?\s*(\d{1,2}(?:\.\d+)?)\s*%/i);
  if (dev) f.maxDevHoldingPct = Number(dev[1]);
  const soc: Array<"x" | "telegram" | "website"> = [];
  if (/\bwith\s+(?:all\s+)?socials\b|\bsocials\s+(?:present|required|only)\b|\bhas\s+socials\b/i.test(t)) soc.push("x", "telegram", "website");
  else {
    if (/\b(?:with|has|needs?)\s+(?:an?\s+)?(?:x|twitter)\b/i.test(t)) soc.push("x");
    if (/\b(?:with|has|needs?)\s+(?:a\s+)?(?:tg|telegram)\b/i.test(t)) soc.push("telegram");
    if (/\b(?:with|has|needs?)\s+(?:a\s+)?(?:website|site)\b/i.test(t)) soc.push("website");
  }
  if (soc.length) f.requireSocials = soc;
  const liq = t.match(new RegExp(String.raw`(?:min(?:imum)?\s+)?liquidity\s*(?:of|above|over|at least|>)?\s*${NUM}\s*sol`, "i"));
  if (liq) f.minLiquiditySol = Number(liq[1]);
  const block = t.match(/(?:block(?:list)?|skip|avoid|ignore)\s+(?:names?\s+with\s+|anything\s+with\s+)?((?:"[^"]+"|'[^']+'|[\w$]+)(?:\s*(?:,|or|and)\s*(?:"[^"]+"|'[^']+'|[\w$]+))*)/i);
  if (block) {
    const items = block[1].split(/\s*(,|\bor\b|\band\b)\s*/i);
    // ["cat", "or", "dog", ",", "rug"]: an item after a comma that continues as a phrase ("rug checks") starts a new clause
    const end = (block.index ?? 0) + block[0].length;
    if (items.length >= 3 && items[items.length - 2] === "," && /^\s+[a-z]/i.test(t.slice(end))) items.splice(-2, 2);
    f.blocklist = items.filter((_, i) => i % 2 === 0).map((s) => s.replace(/["']/g, "").trim()).filter(Boolean);
  }
  if (/\brug\s*checks?\b|\bsafe\s+only\b|\brenounced\b|\brevoked\b/i.test(t)) f.rugChecks = { mintAuthorityRevoked: true, freezeAuthorityRevoked: true, maxTop10Pct: 30 };
  return f;
}

const fmt = (n: number) => (n >= 1000 ? `$${n >= 1e6 ? +(n / 1e6).toFixed(2) + "M" : +(n / 1e3).toFixed(1) + "k"}` : `$${n}`);

export function describeExit(x: ExitSpec): string[] {
  const s: string[] = [];
  for (const st of x.takeProfit ?? []) s.push(`Sell ${st.sellPct === 100 ? "everything" : st.sellPct + "%"} at ${st.atMultiple}x`);
  if (x.stopLossPct !== undefined) s.push(`Stop-loss at -${x.stopLossPct}%`);
  if (x.trailingStopPct !== undefined) s.push(`Trailing stop ${x.trailingStopPct}% from the high`);
  if (x.timeoutMin !== undefined) s.push(`Sell everything after ${x.timeoutMin} min`);
  const k = (n: number) => (n >= 1e6 ? `$${+(n / 1e6).toFixed(2)}M` : `$${+(n / 1e3).toFixed(1)}k`);
  for (const t of x.timeSells ?? []) s.push(`Sell ${t.sellPct === 100 ? "everything" : t.sellPct + "%"} ${t.afterSec} s after entry`);
  for (const t of x.mcapTargets ?? []) s.push(`Sell ${t.sellPct === 100 ? "the rest" : t.sellPct + "%"} at ${k(t.atMcapUsd)} market cap`);
  if (x.stopBelowMcapUsd !== undefined) s.push(`Sell everything if market cap drops below ${k(x.stopBelowMcapUsd)}`);
  return s;
}

export function describeRule(r: Rule): string[] {
  const s: string[] = [];
  const t = r.trigger;
  if (t.kind === "x-post") {
    const who = t.handles.map((h) => "@" + h).join(", ");
    s.push(t.mode === "ca-in-post" ? `When ${who} posts a contract address` : `When ${who} posts ${t.keywords?.map((k) => `"${k}"`).join(" or ")} with a coin link`);
  } else if (t.kind === "new-launch") {
    const f = t.filters;
    const parts = ["new pump.fun launches"];
    if (f.maxDevHoldingPct !== undefined) parts.push(`dev ≤ ${f.maxDevHoldingPct}%`);
    if (f.nameIncludes?.length) parts.push(`names with ${f.nameIncludes.join(" or ")}`);
    if (f.requireSocials?.length) parts.push(`with ${f.requireSocials.map((x) => ({ x: "X", telegram: "Telegram", website: "a website" })[x]).join(", ")}`);
    if (f.minLiquiditySol !== undefined) parts.push(`liquidity ≥ ${f.minLiquiditySol} SOL`);
    if (f.blocklist?.length) parts.push(`skipping ${f.blocklist.join(", ")}`);
    if (f.rugChecks) parts.push("rug checks on");
    s.push(`On ${parts.join(", ")}`);
  }
  s.push(`Buy ${r.buy.amountSol} SOL${r.buy.maxMcapUsd ? ` if market cap is under ${fmt(r.buy.maxMcapUsd)}` : ""}`);
  s.push(...describeExit(r.exit));
  s.push(`At most ${r.maxBuysPerDay} buy${r.maxBuysPerDay === 1 ? "" : "s"} a day · slippage ${r.buy.slippageBps / 100}%${r.buy.jitoTipSol ? ` · Jito tip ${r.buy.jitoTipSol} SOL` : ""}`);
  return s;
}

/** The whole reply to a prohibited request (wash trading, fake volume, impersonation…): one plain sentence. The
 * guardrails still refuse the action in code whatever the wording; this is only what the chat says. */
export const REFUSAL = "I can't do that one.";

export function parseIntent(input: string, now = new Date()): ParseResult {
  const t = input.trim().replace(/[’‘]/g, "'");
  if (!t) return { kind: "unknown", hint: "Say what you want, for example: snipe anything @handle posts under 50k mcap with 0.5 SOL" };

  const bad = forbiddenIntent(t);
  if (bad) return { kind: "refuse", reason: REFUSAL };

  if (/^(?:pause|stop|halt)(?:\s+(?:the\s+)?agent|\s+everything|\s+trading)?\.?$/i.test(t)) return { kind: "control", action: "pause", summary: ["Pause the agent (rules stop firing; open positions keep their exits)"] };
  if (/^(?:resume|unpause|start)(?:\s+(?:the\s+)?agent|\s+trading)?\.?$/i.test(t)) return { kind: "control", action: "resume", summary: ["Resume the agent"] };
  if (/\bkill[\s-]?switch\b|\bpanic\b/i.test(t)) return { kind: "control", action: "kill", summary: ["Turn on the kill switch: no new buys until you turn it off"] };

  const sp = parseSupplyRequest(t);
  if (sp) return sp;

  const st = parseStrategyRequest(t);
  if (st) return st;

  const li = parseLaunchInfoRequest(t);
  if (li) return li;
  const cl = parseClaimRequest(t);
  if (cl) return cl;

  const cp = parseCopyRequest(t, exitSpec);
  if (cp) return { kind: "copy", ...cp };

  const lr = parseLaunchRuleRequest(t);
  if (lr) return { kind: "launch-rule", ...lr };
  const launch = parseLaunchRequest(t);
  if (launch) return { kind: "launch", ...launch };

  const mints = detectMints(t);
  const handles = handlesIn(t);
  const amount = solAmount(t);
  const exit = exitSpec(t);

  // direct trade on a specific coin
  if (mints.length === 1 && handles.length === 0) {
    const mint = mints[0].mint;
    const sell = t.match(/\bsell\s+(half|a third|third|a quarter|quarter|all|everything|\d{1,3}\s*%)/i);
    if (sell && !/\bif\b|\bwhen\b|\bat\s+\d/i.test(t)) {
      const p = pctWord(sell[1]) ?? 100;
      return { kind: "trade", action: "sell", mint, sellPct: p, summary: [`Sell ${p}% of ${mint.slice(0, 4)}…${mint.slice(-4)}`] };
    }
    if (/\b(buy|ape|get)\b/i.test(t) && amount)
      return { kind: "trade", action: "buy", mint, amountSol: amount, summary: [`Buy ${amount} SOL of ${mint.slice(0, 4)}…${mint.slice(-4)}`] };
  }

  const wantsX = handles.length > 0 && /\b(snipe|buy|ape|watch|follow|whatever|anything|any coin|when|if)\b/i.test(t);
  const wantsLaunch = /\b(new\s+(?:pump(?:\.fun)?\s+)?(?:launch|launches|coins?|tokens?|pairs?)|fresh\s+launches|pump\.?fun\s+launches|every\s+launch|new\s+mints?)\b/i.test(t);

  if (wantsX || wantsLaunch) {
    const assumptions: string[] = [];
    const keywordMode = /\b(?:says?|posts?|mentions?|announces?|tweets?)\s+["'“]?([a-z0-9 $#]{2,24})["'”]?\s+(?:with|and)\s+(?:a\s+)?link/i.exec(t);
    const partial: Partial<Rule> = { enabled: false };
    if (wantsX) {
      partial.trigger = keywordMode
        ? { kind: "x-post", handles, mode: "keyword-link", keywords: [keywordMode[1].trim().toLowerCase()] }
        : { kind: "x-post", handles, mode: "ca-in-post" };
      if (!keywordMode) assumptions.push("Fires only when the post itself contains a full contract address");
      partial.name = `Snipe ${handles.map((h) => "@" + h).join(" ")}`.slice(0, 60);
    } else {
      partial.trigger = { kind: "new-launch", launchpad: "pumpfun", filters: launchFilters(t) };
      partial.name = "New launch snipe";
    }
    const mc = mcap(t);
    const slip = t.match(/slip(?:page)?\s*(?:of|at)?\s*(\d{1,2}(?:\.\d+)?)\s*%/i);
    const prio = t.match(/prio(?:rity)?(?:\s+fee)?\s*(?:of|at)?\s*(\d*\.\d+|\d+)\s*sol/i);
    const jito = t.match(/jito(?:\s+tip)?\s*(?:of|at)?\s*(\d*\.\d+|\d+)\s*(?:sol)?/i);
    const maxDay = t.match(/(?:max(?:imum)?|at most|up to|no more than)\s*(\d{1,3})\s*(?:buys?|snipes?|trades?)?\s*(?:a|per|\/)\s*day/i) ?? t.match(/(\d{1,3})\s*(?:buys?|snipes?)\s*(?:a|per|\/)\s*day/i);
    const base = defaultRule(partial);
    const draft: Rule = {
      ...base,
      buy: {
        ...base.buy,
        amountSol: amount ?? base.buy.amountSol,
        ...(mc !== undefined ? { maxMcapUsd: mc } : {}),
        ...(slip ? { slippageBps: Math.round(Number(slip[1]) * 100) } : {}),
        ...(prio ? { priorityFeeSol: Number(prio[1]) } : {}),
        ...(jito ? { jitoTipSol: Number(jito[1]) } : {}),
      },
      exit: Object.keys(exit).length ? exit : base.exit,
      maxBuysPerDay: maxDay ? Number(maxDay[1]) : base.maxBuysPerDay,
      createdAt: now.toISOString(),
    };
    if (amount === undefined) assumptions.push(`No size given: using ${draft.buy.amountSol} SOL`);
    if (!Object.keys(exit).length) assumptions.push("No exit given: default take-profit 2x (sell 50%) and stop-loss -35%");
    if (!maxDay) assumptions.push(`At most ${draft.maxBuysPerDay} buys a day`);
    if (!slip) assumptions.push(`Slippage ${draft.buy.slippageBps / 100}%`);
    return { kind: "rule", draft, summary: describeRule(draft), assumptions, errors: validateRule(draft) };
  }

  if (Object.keys(exit).length) return { kind: "exit", exit, summary: describeExit(exit) };

  return {
    kind: "unknown",
    hint: 'Try: "snipe anything @handle posts under 50k mcap with 0.5 SOL", "sell half if it 3x\'s", "buy 0.1 SOL of new launches with socials and dev under 5%".',
  };
}
