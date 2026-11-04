/**
 * Launch plans. Pure logic, no I/O: validation, pump.fun curve estimates, the public disclosure text for
 * team wallets, the PumpPortal bundle requests, and the launch guardrail. Shared by the CLI, MCP server,
 * Telegram bot, chat, the web panel and the hosted backend, so every surface launches the same way.
 *
 * Two modes:
 *  - standard: create + dev buy in ONE transaction (the dev buy is part of pump.fun's create), so it lands with the
 *    create and can't be front-run. No Jito tip or priority fee is needed: both default to 0 and are optional
 *    ("Advanced"). Optional disclosed team wallets buy in the same Jito bundle; only then is a tip required, and an
 *    automatic minimum is used when none is set.
 *  - manual: create only. No buying. Cheapest.
 *
 * Team wallets are ALWAYS disclosed. Their full addresses are appended to the coin description (which the
 * launchpad shows on the coin page) and to the treasury report. A plan with team wallets and
 * `disclosed: false` is refused here, so no surface can launch one.
 *
 * Things Vesk does not build: stealth or "block 0" presets, MEV layers, temporary holder wallets,
 * hidden or CEX-routed funding, "bubble map" evasion, randomized "organic-looking" buys, volume or
 * market-maker bots. They exist to deceive buyers.
 */
import { forbiddenIntent, type GuardResult } from "../guardrails.js";
import type { PumpPortalRequest } from "../trade/pumpportal.js";
import type { Address, Launchpad, Limits } from "../types.js";
import type { FieldError } from "../rules/validate.js";
import { launchpad, type CreatorFeeMode, type QuoteAsset } from "./launchpads.js";
import { feeRange, planFee } from "./capabilities.js";
import { BRAND } from "../brand.js";

export type LaunchMode = "standard" | "manual";

export interface TokenDetails {
  name: string;
  symbol: string;
  description: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  quote: QuoteAsset;
  creatorFees: CreatorFeeMode;
  /** v23: creator fee in percent, for pairs where the creator sets it (non-SOL, `creatorFeeRange`). Ignored on SOL (fixed). */
  creatorFeePct?: number;
  /** v26: with creatorFees "split": up to 10 recipients and their share in percent (sums to 100). Custom pairs only. */
  feeSplit?: Array<{ address: string; pct: number }>;
}

export interface TeamAllocation {
  /** Owner's own wallets (imported into the keystore / hosted vault). Max 4: a Jito bundle holds 5 transactions. */
  wallets: Address[];
  /** Same amount for every wallet. No randomized amounts. */
  solEach: number;
  /** Must be true. The addresses are published in the coin description and the treasury report. */
  disclosed: boolean;
}

export interface LaunchPlan {
  launchpad: Launchpad;
  mode: LaunchMode;
  token: TokenDetails;
  /** Creator's buy in the create transaction. 0 in manual mode. */
  devBuySol: number;
  /**
   * Optional Jito tip, paid by the first transaction (PumpPortal uses the first request's priorityFee as the tip).
   * 0 = none: a create + dev buy is one transaction and goes through your RPC. Team wallets need a bundle, so
   * 0 then means the automatic minimum (AUTO_BUNDLE_TIP_SOL). A tip above 0 sends even a solo launch as a bundle.
   */
  jitoTipSol: number;
  /** Optional priority fee (0 = none): on the create when it goes through your RPC, and on each team buy. */
  priorityFeeSol: number;
  slippagePct: number;
  team?: TeamAllocation | null;
}


export const MAX_TEAM_WALLETS = 4;
export const DESCRIPTION_MAX = 500;
export const MAX_DEV_BUY_SOL = 50;
/** Tip used for a team-wallet bundle when none is set (a Jito bundle must tip). */
export const AUTO_BUNDLE_TIP_SOL = 0.0001;

/** pump.fun bonding curve at creation (public program constants). Used for estimates only. */
export const PUMP_CURVE = {
  virtualSol: 30,
  virtualTokens: 1_073_000_000,
  realTokens: 793_100_000,
  totalSupply: 1_000_000_000,
  /** Total trade fee on the curve, approximate. Fees change; treat every number from this as an estimate. */
  feeBps: 125,
} as const;

/** Approximate one-time costs, in SOL. */
export const COSTS = {
  /** Mint, metadata and bonding-curve accounts paid by the creator on create (approx). */
  createRent: 0.02,
  /** Token account rent for each wallet that buys. */
  tokenAccountRent: 0.00204,
  /** Base network fee per signature. */
  signatureFee: 0.000005,
} as const;

export function defaultPlan(): LaunchPlan {
  return {
    launchpad: "pumpfun", mode: "standard",
    token: { name: "", symbol: "", description: "", quote: "SOL", creatorFees: "creator" },
    devBuySol: 0.5, jitoTipSol: 0, priorityFeeSol: 0, slippagePct: 10, team: null,
  };
}

/** How a plan is sent: one transaction through your RPC, or a Jito bundle (team wallets, or a tip you set). */
export function launchRoute(p: LaunchPlan): "rpc" | "bundle" {
  if (p.mode !== "standard") return "rpc";
  return (p.team && p.team.wallets.length > 0) || p.jitoTipSol > 0 ? "bundle" : "rpc";
}

/** The Jito tip actually paid: what you set, the automatic minimum for a team bundle, or 0 without a bundle. */
export function effectiveTip(p: LaunchPlan): number {
  if (launchRoute(p) !== "bundle") return 0;
  return p.jitoTipSol > 0 ? p.jitoTipSol : AUTO_BUNDLE_TIP_SOL;
}

/** Sequential buys on a fresh pump.fun curve. Each entry is SOL in; returns tokens and % of total supply. */
export function estimateCurveBuys(solIns: number[]): Array<{ sol: number; tokens: number; pct: number }> {
  let vS = PUMP_CURVE.virtualSol, vT = PUMP_CURVE.virtualTokens, real = PUMP_CURVE.realTokens;
  return solIns.map((sol) => {
    const net = Math.max(0, sol) * (1 - PUMP_CURVE.feeBps / 10_000);
    let out = vT - (vS * vT) / (vS + net);
    if (out > real) out = real;
    vS += net;
    vT -= out;
    real -= out;
    return { sol, tokens: out, pct: (out / PUMP_CURVE.totalSupply) * 100 };
  });
}

export interface PlanSummary {
  devPct: number;
  teamPct: number;
  teamWallets: number;
  teamTotalSol: number;
  /** SOL that buys tokens (dev + team). */
  buySol: number;
  /** Tips, fees and rent, approximate (launchFeeSol + speedSol). */
  feesSol: number;
  /** Rent for the coin's accounts and the buyers' token accounts, plus network fees: what every launch pays. */
  launchFeeSol: number;
  /** Optional Jito tip and priority fees. 0 by default. */
  speedSol: number;
  totalSol: number;
  /** e.g. "Team holds 6.1% across 3 disclosed wallets". Empty when there is no team. */
  teamLine: string;
}

export function summarizePlan(p: LaunchPlan): PlanSummary {
  const team = p.mode === "standard" && p.team ? p.team : null;
  const n = team?.wallets.length ?? 0;
  const est = estimateCurveBuys([p.mode === "standard" ? p.devBuySol : 0, ...Array.from({ length: n }, () => team!.solEach)]);
  const devPct = est[0].pct;
  const teamPct = est.slice(1).reduce((a, b) => a + b.pct, 0);
  const teamTotalSol = n * (team?.solEach ?? 0);
  const dev = p.mode === "standard" ? p.devBuySol : 0;
  const buyers = (dev > 0 ? 1 : 0) + n;
  const launchFeeSol = COSTS.createRent + buyers * COSTS.tokenAccountRent + (1 + n) * COSTS.signatureFee;
  const speedSol = effectiveTip(p) + (launchRoute(p) === "rpc" ? p.priorityFeeSol : n * p.priorityFeeSol);
  const feesSol = launchFeeSol + speedSol;
  return {
    devPct, teamPct, teamWallets: n, teamTotalSol, buySol: dev + teamTotalSol, feesSol, launchFeeSol, speedSol, totalSol: dev + teamTotalSol + feesSol,
    teamLine: n ? `Team holds ${teamPct.toFixed(1)}% across ${n} disclosed wallet${n === 1 ? "" : "s"}` : "",
  };
}

/** The text appended to the coin description and posted in the treasury report. Full addresses, so anyone can verify. */
export function disclosureText(team: TeamAllocation, teamPct: number): string {
  const n = team.wallets.length;
  return `Team wallets (disclosed): ${n} wallet${n === 1 ? "" : "s"} bought ~${teamPct.toFixed(1)}% of supply at launch, ${team.solEach} SOL each: ${team.wallets.join(", ")}`;
}

/** The description that actually goes on-chain / to the launchpad: the creator's text plus the disclosure, if any. */
export function finalDescription(p: LaunchPlan): string {
  const s = summarizePlan(p);
  const base = p.token.description.trim();
  if (!(p.mode === "standard" && p.team && p.team.wallets.length)) return base;
  const d = disclosureText(p.team, s.teamPct);
  return base ? `${base}\n\n${d}` : d;
}

const httpsOk = (v?: string) => !v || /^https:\/\/\S+$/.test(v);

export function validateToken(t: Partial<TokenDetails>, lp: Launchpad = "pumpfun", reserve = 0): FieldError[] {
  const e: FieldError[] = [];
  const info = launchpad(lp);
  if (!t.name || t.name.trim().length < 2 || t.name.trim().length > 32) e.push({ field: "name", message: "Name must be 2-32 characters." });
  if (!t.symbol || !/^[A-Za-z0-9]{2,10}$/.test(t.symbol)) e.push({ field: "symbol", message: "Ticker must be 2-10 letters or digits." });
  const max = DESCRIPTION_MAX - reserve;
  if ((t.description ?? "").length > max)
    e.push({ field: "description", message: reserve ? `Description must be under ${max} characters (the team-wallet disclosure needs ${reserve}).` : `Description must be under ${max} characters.` });
  if (!httpsOk(t.twitter)) e.push({ field: "twitter", message: "X link must start with https://" });
  if (!httpsOk(t.telegram)) e.push({ field: "telegram", message: "Telegram link must start with https://" });
  if (!httpsOk(t.website)) e.push({ field: "website", message: "Website must start with https://" });
  const quote = t.quote ?? "SOL";
  if (!info.quotes.supported.includes(quote)) e.push({ field: "quote", message: `${info.name} via ${BRAND.name} supports ${info.quotes.supported.join(", ") || "no"} quote pairs.` });
  const range = feeRange(info.caps, quote);
  if (range && t.creatorFeePct !== undefined && !(t.creatorFeePct >= range.min && t.creatorFeePct <= range.max && Math.abs((t.creatorFeePct - range.min) / range.step - Math.round((t.creatorFeePct - range.min) / range.step)) < 1e-6))
    e.push({ field: "creatorFeePct", message: `Creator fee must be ${range.min}-${range.max}% in ${range.step}% steps on a ${quote} pair.` });
  const fees = t.creatorFees ?? "creator";
  if (info.creatorFees && !info.creatorFees.supported.includes(fees)) e.push({ field: "creatorFees", message: info.creatorFees.reason ?? "Not available." });
  if (!info.creatorFees && fees !== "creator") e.push({ field: "creatorFees", message: `${info.name} has no creator-fee setting.` });
  // v26: Cashback and a split exist only on custom (non-SOL) pairs
  const cap = info.caps?.creatorFees.find((x) => x.id === fees);
  if (cap?.customOnly && quote === "SOL") e.push({ field: "creatorFees", message: `${fees === "cashback" ? "Cashback" : "A fee split"} is for custom pairs. Pick a pair other than SOL.` });
  if (fees === "split") {
    const sp = t.feeSplit ?? [];
    const max = info.caps?.feeSplit?.max ?? 10;
    if (!sp.length) e.push({ field: "feeSplit", message: "Add at least one recipient, or pick another fee setting." });
    if (sp.length > max) e.push({ field: "feeSplit", message: `At most ${max} recipients.` });
    if (sp.some((r) => !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.address))) e.push({ field: "feeSplit", message: "Each recipient needs a Solana address." });
    if (new Set(sp.map((r) => r.address)).size !== sp.length) e.push({ field: "feeSplit", message: "Each recipient can be listed once." });
    const sum = sp.reduce((a, r) => a + r.pct, 0);
    if (sp.length && (sp.some((r) => !(r.pct > 0)) || Math.abs(sum - 100) > 1e-6)) e.push({ field: "feeSplit", message: `Shares must be above 0 and add up to 100% (now ${+sum.toFixed(2)}%).` });
  }
  for (const [f, v] of [["name", t.name], ["description", t.description]] as const) {
    const bad = forbiddenIntent(v ?? "");
    if (bad) e.push({ field: f, message: `Refused: ${bad}.` });
  }
  return e;
}

export function validatePlan(p: LaunchPlan): FieldError[] {
  const e: FieldError[] = [];
  const info = launchpad(p.launchpad);
  if (info.status !== "ready") e.push({ field: "launchpad", message: `${info.name} is coming soon. ${info.note}` });
  const team = p.team && p.team.wallets.length ? p.team : null;
  const reserve = team && p.mode === "standard" ? disclosureText(team, 99.9).length + 2 : 0;
  e.push(...validateToken(p.token, p.launchpad, reserve));
  if (p.mode === "manual") {
    if (p.devBuySol !== 0) e.push({ field: "devBuySol", message: "Manual mode deploys only. Set the dev buy to 0 or use Standard." });
    if (team) e.push({ field: "team", message: "Team wallets need Standard mode (they buy in the launch bundle)." });
  } else {
    if (!(p.devBuySol >= 0 && p.devBuySol <= MAX_DEV_BUY_SOL)) e.push({ field: "devBuySol", message: `Dev buy must be 0-${MAX_DEV_BUY_SOL} SOL.` });
    // v22: a dev buy needs no tip (it's in the create transaction); a tip, if set, is 0.00001-0.1 SOL
    if (!(p.jitoTipSol === 0 || (p.jitoTipSol >= 0.00001 && p.jitoTipSol <= 0.1))) e.push({ field: "jitoTipSol", message: "Jito tip is optional: 0 (none) or 0.00001-0.1 SOL." });
  }
  if (!(p.priorityFeeSol >= 0 && p.priorityFeeSol <= 0.05)) e.push({ field: "priorityFeeSol", message: "Priority fee must be 0-0.05 SOL." });
  if (!(p.slippagePct >= 1 && p.slippagePct <= 50)) e.push({ field: "slippagePct", message: "Slippage must be 1-50%." });
  if (team) {
    if (!team.disclosed) e.push({ field: "team", message: "Team wallets are always disclosed. Turn on disclosure or remove them." });
    if (team.wallets.length > MAX_TEAM_WALLETS) e.push({ field: "team", message: `At most ${MAX_TEAM_WALLETS} team wallets (a Jito bundle holds 5 transactions).` });
    if (new Set(team.wallets).size !== team.wallets.length) e.push({ field: "team", message: "Each team wallet can be listed once." });
    if (!(team.solEach > 0 && team.solEach <= MAX_DEV_BUY_SOL)) e.push({ field: "team", message: `Amount per wallet must be above 0 and at most ${MAX_DEV_BUY_SOL} SOL.` });
  }
  return e;
}

/**
 * The create-request fields for settings beyond the defaults (a non-SOL quote pair, creator rewards to holders),
 * from the launchpad's capability config. Empty for the default launch. TODO-verify the field names (capabilities.ts).
 */
export function createParams(p: LaunchPlan): Record<string, string | boolean | Array<{ address: string; bps: number }>> {
  const caps = launchpad(p.launchpad).caps;
  if (!caps) return {};
  const out: Record<string, string | boolean | Array<{ address: string; bps: number }>> = {};
  if (p.token.quote !== "SOL") {
    const q = caps.quoteAssets.find((a) => a.id === p.token.quote);
    if (q) out[caps.createParams.quote.field] = q.mint ?? q.id;
  }
  if (p.token.creatorFees === "holders") out[caps.createParams.holderRewards.field] = caps.createParams.holderRewards.value;
  // v23: only where the creator sets the fee (non-SOL pairs); on SOL pump.fun fixes it, so nothing is sent. TODO-verify.
  const fee = planFee(caps, p.token.quote, p.token.creatorFeePct);
  if (fee !== null) out[caps.createParams.creatorFee.field] = String(Math.round(fee * 100));
  // v26: custom-pair fee settings (TODO-verify both fields)
  if (p.token.creatorFees === "cashback" && caps.createParams.cashback) out[caps.createParams.cashback.field] = true;
  if (p.token.creatorFees === "split" && caps.createParams.split && p.token.feeSplit?.length) out[caps.createParams.split.field] = p.token.feeSplit.map((r) => ({ address: r.address, bps: Math.round(r.pct * 100) }));
  return out;
}

/**
 * PumpPortal requests (POST one to /api/trade-local, or an array for a bundle; get back transactions to sign).
 * The first request is the create (+ dev buy). Sent as a bundle, its priorityFee is the Jito tip; through your RPC,
 * it's the priority fee (0 by default).
 */
export function bundleRequests(p: LaunchPlan, x: { creator: Address; mint: Address; metadataUri: string }): PumpPortalRequest[] {
  const bundle = launchRoute(p) === "bundle";
  const create: PumpPortalRequest = {
    publicKey: x.creator, action: "create", tokenMetadata: { name: p.token.name.trim(), symbol: p.token.symbol.toUpperCase(), uri: x.metadataUri },
    mint: x.mint, denominatedInSol: "true", amount: p.mode === "standard" ? p.devBuySol : 0, slippage: p.slippagePct,
    priorityFee: bundle ? effectiveTip(p) : p.priorityFeeSol, pool: "pump",
    ...createParams(p),
  };
  if (p.mode === "manual" || !p.team) return [create];
  return [
    create,
    ...p.team.wallets.map((w): PumpPortalRequest => ({
      publicKey: w, action: "buy", mint: x.mint, denominatedInSol: "true", amount: p.team!.solEach, slippage: p.slippagePct, priorityFee: p.priorityFeeSol, pool: "pump",
    })),
  ];
}

export interface LaunchGuardContext {
  limits: Limits;
  /** Every wallet the owner has: main + imported. Team wallets must come from here. */
  ownWallets: Address[];
  creator: Address;
  spentTodaySol: number;
  /** Optional live balances, by address. */
  balances?: Record<Address, number>;
}

const no = (code: Extract<GuardResult, { ok: false }>["code"], reason: string): GuardResult => ({ ok: false, code, reason });

/** The launch guardrail. Runs on every surface right before anything is signed. */
export function checkLaunch(p: LaunchPlan, c: LaunchGuardContext): GuardResult {
  const errs = validatePlan(p);
  if (errs.length) {
    const t = errs.find((x) => x.field === "team");
    if (t) return no(/disclosed/.test(t.message) ? "launch-disclosure" : "launch-team", t.message);
    if (errs.some((x) => /^Refused/.test(x.message))) return no("forbidden-action", errs.find((x) => /^Refused/.test(x.message))!.message);
    return no("launch-invalid", errs.map((x) => x.message).join(" "));
  }
  const team = p.mode === "standard" && p.team?.wallets.length ? p.team : null;
  const dev = p.mode === "standard" ? p.devBuySol : 0;
  if (c.limits.killSwitch && (dev > 0 || team)) return no("kill-switch", "Kill switch is on. Launch in Manual mode, or turn it off.");
  if (!c.ownWallets.includes(c.creator)) return no("undisclosed-wallet", "The creator must be one of your own wallets.");
  if (team) {
    if (team.wallets.includes(c.creator)) return no("launch-team", "The creator wallet already buys with the dev buy. Pick other wallets for the team.");
    if (team.wallets.some((w) => !c.ownWallets.includes(w))) return no("undisclosed-wallet", `Team wallets must be wallets you imported into ${BRAND.name}.`);
    if (team.solEach > c.limits.perTradeMaxSol) return no("per-trade-max", `${team.solEach} SOL per team wallet is above your per-trade max (${c.limits.perTradeMaxSol} SOL).`);
  }
  if (dev > c.limits.perTradeMaxSol) return no("per-trade-max", `Dev buy ${dev} SOL is above your per-trade max (${c.limits.perTradeMaxSol} SOL).`);
  const spend = dev + (team ? team.solEach * team.wallets.length : 0);
  if (c.spentTodaySol + spend > c.limits.dailySpendCapSol + 1e-9)
    return no("daily-cap", `This launch spends ${spend} SOL; ${c.spentTodaySol} of ${c.limits.dailySpendCapSol} SOL already spent today.`);
  if (c.balances) {
    const s = summarizePlan(p);
    const creatorNeeds = dev + (s.feesSol - (team ? team.wallets.length * (p.priorityFeeSol + COSTS.tokenAccountRent + COSTS.signatureFee) : 0));
    if ((c.balances[c.creator] ?? 0) < creatorNeeds + c.limits.minSolReserve)
      return no("reserve", `Creator wallet needs about ${creatorNeeds.toFixed(4)} SOL plus your ${c.limits.minSolReserve} SOL reserve.`);
    for (const w of team?.wallets ?? []) {
      const need = team!.solEach + p.priorityFeeSol + COSTS.tokenAccountRent + COSTS.signatureFee;
      if ((c.balances[w] ?? 0) < need) return no("reserve", `${w.slice(0, 4)}…${w.slice(-4)} needs about ${need.toFixed(4)} SOL. Fund it from your main wallet first.`);
    }
  }
  return { ok: true };
}

// ---------- chat: "launch a coin called Night Owl ($OWL) with a 0.5 SOL dev buy" ----------

export interface LaunchDraft {
  launchpad: Launchpad;
  mode?: LaunchMode;
  name?: string;
  symbol?: string;
  description?: string;
  devBuySol?: number;
  teamWallets?: number;
}

export const LAUNCH_REQUEST = /\b(launch|deploy|create|mint)\b(?:\s+(?:a|an|my|our|the|new))*\s+(?:meme\s*)?(?:coin|token|memecoin)\b|\blaunch\s+\$[A-Za-z0-9]{2,10}\b/i;

export function parseLaunchRequest(text: string): { draft: LaunchDraft; summary: string[] } | null {
  const t = text.trim();
  if (!LAUNCH_REQUEST.test(t)) return null;
  const d: LaunchDraft = { launchpad: "pumpfun" };
  const name = t.match(/\b(?:called|named)\s+["“']?([A-Za-z0-9][A-Za-z0-9 ._-]{0,31}?)["”']?(?=\s*(?:\(|,|\.(?:\s|$)|$|\s+(?:with|ticker|\$|on|and|for|about)\b))/i);
  if (name) d.name = name[1].trim();
  const sym = t.match(/\$([A-Za-z0-9]{2,10})\b/) ?? t.match(/\bticker\s+([A-Za-z0-9]{2,10})\b/i);
  if (sym) d.symbol = sym[1].toUpperCase();
  if (/\b(no dev buy|without (a )?dev buy|manual|deploy only)\b/i.test(t)) {
    d.mode = "manual";
    d.devBuySol = 0;
  } else {
    const dev = t.match(/(\d+(?:\.\d+)?)\s*sol\s+dev\s*buy|dev\s*buy\s*(?:of\s*)?(\d+(?:\.\d+)?)/i);
    if (dev) {
      d.mode = "standard";
      d.devBuySol = Number(dev[1] ?? dev[2]);
    }
  }
  const team = t.match(/(\d)\s+(?:disclosed\s+)?team\s+wallets?/i);
  if (team) d.teamWallets = Math.min(MAX_TEAM_WALLETS, Number(team[1]));
  const about = t.match(/\b(?:about|description:?)\s+(.{4,300}?)(?:\.\s|\.$|$)/i);
  if (about) d.description = about[1].trim();
  const summary = [
    `Launch on pump.fun${d.mode ? `, ${d.mode === "standard" ? "Standard (create + dev buy in one Jito bundle)" : "Manual (deploy only)"}` : ""}`,
    d.name || d.symbol ? `Token: ${d.name ?? "(name)"} ${d.symbol ? "$" + d.symbol : "(ticker)"}` : "Token: name and ticker still needed",
    ...(d.devBuySol !== undefined && d.mode === "standard" ? [`Dev buy: ${d.devBuySol} SOL (~${estimateCurveBuys([d.devBuySol])[0].pct.toFixed(1)}% of supply)`] : []),
    ...(d.teamWallets ? [`Team wallets: ${d.teamWallets}, always disclosed on the coin page and in the treasury report`] : []),
    "Opens the Launch page prefilled. Nothing is signed until you review and press Launch.",
  ];
  return { draft: d, summary };
}
