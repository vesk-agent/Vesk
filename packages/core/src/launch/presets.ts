/**
 * Named launch presets: one place for "how I launch". Used by Deploy and Instant deploy in the tracker and by
 * launch-on-post rules. Pure logic: validation, the plan a preset produces, and an honest cost estimate.
 */
import type { FieldError } from "../rules/validate.js";
import { validateExit } from "../rules/validate.js";
import type { ExitSpec, Launchpad } from "../types.js";
import { defaultLaunchRule, type ImageSource, type LaunchOnPostRule } from "./onpost.js";
import { launchpad, type CreatorFeeMode, type QuoteAsset } from "./launchpads.js";
import { AUTO_BUNDLE_TIP_SOL, COSTS, defaultPlan, estimateCurveBuys, MAX_TEAM_WALLETS, type LaunchMode, type LaunchPlan, type TokenDetails } from "./plan.js";
import { BRAND } from "../brand.js";

/**
 * What a launch costs even with no dev buy (account rent + network fees, approx.).
 * Check pump.fun's current fees before relying on it: launchpads change them.
 */
export const FREE_LAUNCH_COST_SOL = 0.02;

export interface LaunchPreset {
  id: string;
  name: string;
  launchpad: Launchpad;
  quote: QuoteAsset;
  creatorFees: CreatorFeeMode;
  mode: LaunchMode;
  /** 0 = free launch (no dev buy). */
  devBuySol: number;
  jitoTipSol: number;
  priorityFeeSol: number;
  slippagePct: number;
  teamWallets: number;
  teamSolEach: number;
  links: { website?: string; twitter?: string; telegram?: string };
  image: ImageSource;
  defaultImage?: string;
  naming: "model" | "template";
  nameTemplate: string;
  tickerTemplate: string;
  descriptionTemplate: string;
  exit: ExitSpec;
  /** Instant deploy asks once before its first use (setting). */
  confirmFirstInstant?: boolean;
}

export function defaultPreset(p: Partial<LaunchPreset> = {}): LaunchPreset {
  return {
    id: p.id ?? `pr_${Math.random().toString(36).slice(2, 8)}`, name: "Standard", launchpad: "pumpfun", quote: "SOL", creatorFees: "creator", mode: "standard",
    devBuySol: 0.3, jitoTipSol: 0, priorityFeeSol: 0, slippagePct: 10, teamWallets: 0, teamSolEach: 0.1, links: {}, image: "post",
    naming: "template", nameTemplate: "{Word}", tickerTemplate: "{WORD}", descriptionTemplate: "{text}",
    exit: { mcapTargets: [{ atMcapUsd: 100_000, sellPct: 50 }, { atMcapUsd: 250_000, sellPct: 100 }], stopBelowMcapUsd: 5_000 },
    confirmFirstInstant: true,
    ...p,
  };
}

export const PRESET_EXAMPLES: LaunchPreset[] = [
  defaultPreset({ id: "pr_standard", name: "Standard · 0.3 SOL" }),
  defaultPreset({ id: "pr_free", name: "Free launch", devBuySol: 0, mode: "manual", exit: {} }),
  defaultPreset({ id: "pr_devsell", name: "Dev sells at 5 s", devBuySol: 0.5, exit: { timeSells: [{ afterSec: 5, sellPct: 100 }] } }),
];

export function validatePreset(p: LaunchPreset): FieldError[] {
  const e: FieldError[] = [];
  const info = launchpad(p.launchpad);
  if (!p.name.trim() || p.name.length > 40) e.push({ field: "name", message: "Give the preset a name (up to 40 characters)." });
  if (info.status !== "ready") e.push({ field: "launchpad", message: `${info.name} is coming soon.` });
  if (!info.quotes.supported.includes(p.quote)) e.push({ field: "quote", message: `${info.name} via ${BRAND.name} supports ${info.quotes.supported.join(", ")} only.` });
  if (info.creatorFees ? !info.creatorFees.supported.includes(p.creatorFees) : p.creatorFees !== "creator") e.push({ field: "creatorFees", message: info.creatorFees?.reason ?? "Not offered by this launchpad." });
  if (p.mode === "manual" && p.devBuySol !== 0) e.push({ field: "devBuySol", message: "Manual mode has no dev buy. Use 0, or Standard." });
  if (!(p.devBuySol >= 0 && p.devBuySol <= 50)) e.push({ field: "devBuySol", message: "Dev buy: 0-50 SOL (0 = free launch)." });
  if (!(p.jitoTipSol >= 0 && p.jitoTipSol <= 0.1)) e.push({ field: "jitoTipSol", message: "Jito tip: 0-0.1 SOL." });
  if (!(p.priorityFeeSol >= 0 && p.priorityFeeSol <= 0.05)) e.push({ field: "priorityFeeSol", message: "Priority fee: 0-0.05 SOL." });
  if (!(p.slippagePct >= 1 && p.slippagePct <= 50)) e.push({ field: "slippagePct", message: "Slippage: 1-50%." });
  if (!(p.teamWallets >= 0 && p.teamWallets <= MAX_TEAM_WALLETS)) e.push({ field: "teamWallets", message: `Team wallets: 0-${MAX_TEAM_WALLETS}, always disclosed.` });
  if (p.teamWallets && p.mode !== "standard") e.push({ field: "teamWallets", message: "Team wallets need Standard mode." });
  for (const [k, v] of Object.entries(p.links)) if (v && !/^https:\/\/\S+$/.test(v)) e.push({ field: `links.${k}`, message: "Links must start with https://" });
  if (p.image === "mine" && !p.defaultImage) e.push({ field: "defaultImage", message: "Add your image, or pick From post." });
  if ((p.exit.timeSells?.length ?? 0) > 0 && p.devBuySol === 0) e.push({ field: "exit.timeSells", message: "Timed dev sells need a dev buy." });
  e.push(...validateExit(p.exit));
  return e;
}

/** The plan a preset produces for a given token. Team wallets come from the user's active wallets. */
export function planFromPreset(p: LaunchPreset, token: Omit<TokenDetails, "quote" | "creatorFees">, teamAddresses: string[] = []): LaunchPlan {
  const n = p.mode === "standard" ? Math.min(p.teamWallets, teamAddresses.length) : 0;
  const dev = p.mode === "standard" ? p.devBuySol : 0;
  return {
    ...defaultPlan(), launchpad: p.launchpad, mode: dev === 0 && n === 0 ? "manual" : p.mode,
    token: { ...token, website: token.website ?? p.links.website, twitter: token.twitter ?? p.links.twitter, telegram: token.telegram ?? p.links.telegram, quote: p.quote, creatorFees: p.creatorFees },
    devBuySol: dev === 0 && n === 0 ? 0 : dev, jitoTipSol: p.jitoTipSol, priorityFeeSol: p.priorityFeeSol, slippagePct: p.slippagePct,
    team: n ? { wallets: teamAddresses.slice(0, n), solEach: p.teamSolEach, disclosed: true } : null,
  };
}

/** Plain-language cost line for the UI. */
export function presetCost(p: LaunchPreset): { totalSol: number; line: string; devPct: number } {
  const dev = p.mode === "standard" ? p.devBuySol : 0;
  const team = p.mode === "standard" ? p.teamWallets * p.teamSolEach : 0;
  // v22: a dev buy is in the create transaction (no tip); a team bundle tips (the automatic minimum if none is set)
  const tip = team > 0 ? (p.jitoTipSol > 0 ? p.jitoTipSol : AUTO_BUNDLE_TIP_SOL) : p.jitoTipSol;
  const fees = FREE_LAUNCH_COST_SOL + (dev + team > 0 ? tip + (p.teamWallets ? p.teamWallets * (p.priorityFeeSol + COSTS.tokenAccountRent) : p.priorityFeeSol) + COSTS.tokenAccountRent : p.priorityFeeSol);
  const devPct = dev > 0 ? estimateCurveBuys([dev])[0].pct : 0;
  const line = dev + team === 0
    ? `Free launch: no dev buy. You still pay network and launchpad fees (about ~${FREE_LAUNCH_COST_SOL} SOL).`
    : `About ~${(dev + team + fees).toFixed(3)} SOL: ${dev} SOL dev buy (≈ ${devPct.toFixed(1)}% of supply)${team ? ` + ${team} SOL disclosed team buys` : ""} + ~${fees.toFixed(3)} SOL ${tip > 0 || p.priorityFeeSol > 0 ? "fees, tips and rent" : "launch fee and rent"}.`;
  return { totalSol: dev + team + fees, line, devPct };
}

/** A preset as a launch-on-post rule shape, for Deploy / Instant deploy from the tracker. Limits come from your global limits. */
export function ruleFromPreset(p: LaunchPreset, handle: string): LaunchOnPostRule {
  return {
    ...defaultLaunchRule({ id: `deploy:${p.id}`, name: `Deploy · ${p.name}`, enabled: true, mode: "auto" }),
    trigger: { handles: [handle], requireImage: false },
    coin: { naming: p.naming, nameTemplate: p.nameTemplate, tickerTemplate: p.tickerTemplate, descriptionTemplate: p.descriptionTemplate, image: p.image, defaultImage: p.defaultImage, links: { ...p.links } },
    plan: { mode: p.mode, devBuySol: p.mode === "standard" ? p.devBuySol : 0, jitoTipSol: p.jitoTipSol, priorityFeeSol: p.priorityFeeSol, slippagePct: p.slippagePct, teamWallets: p.teamWallets, teamSolEach: p.teamSolEach },
    exit: p.exit,
    limits: { maxPerHour: 60, maxPerDay: 500, maxSolPerLaunch: 1e9, maxSolPerDay: 1e9, cooldownMin: 0 },
  };
}

/** A launch-on-post rule with its preset applied (if it names one that exists). */
export function effectiveRule(r: LaunchOnPostRule, presets: LaunchPreset[]): LaunchOnPostRule {
  const p = r.presetId ? presets.find((x) => x.id === r.presetId) : undefined;
  if (!p) return r;
  const fromPreset = ruleFromPreset(p, r.trigger.handles[0] ?? "");
  return { ...r, coin: { ...fromPreset.coin, links: { ...fromPreset.coin.links, ...r.coin.links } }, plan: fromPreset.plan, exit: p.exit };
}
