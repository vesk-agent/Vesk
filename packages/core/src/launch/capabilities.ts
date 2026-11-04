/**
 * Launchpad capabilities that are not yet verified against a live launch (v22). Data only.
 *
 * Source: the project owner's report (October 2026) that pump.fun's create flow
 *  - lets the creator pick a quote asset other than SOL, and
 *  - lets the creator send creator rewards to holders.
 * Network access was blocked while this was written, so neither the asset list nor how PumpPortal / pump.fun's
 * create API takes these settings could be checked.
 *
 * TODO-verify on the first live launch (LAUNCH-READINESS.md, "verify on first live launch"):
 *  1. which quote assets pump.fun offers at create (the list below beyond SOL is from the report, not from pump.fun);
 *  2. the create-request field names and values in `createParams`;
 *  3. that PumpPortal passes them through (if it rejects a field, the build fails before anything is signed or sent);
 *  4. (v23) the creator-fee field on non-SOL pairs (`creatorFeeBps`); v26: the range is 0.05-1% (pairs.ts);
 *  5. (v23) claiming non-SOL creator fees (`claim.quoteField`); they are paid in the quote asset.
 *  6. (v26) the custom-pair fee range (0.05-1%), Cashback and the fee split (`createParams.cashback` / `split`).
 *
 * Until verified, the panel offers these with an "unverified" mark and never blocks them. The default launch
 * (SOL pair, fees to the creator) sends none of these fields, so it is unchanged from the tested path.
 */
import type { CreatorFeeMode, QuoteAsset } from "./launchpads.js";
import { QUOTE_MINTS } from "../data/programs.js";

// ------------------------------------------------------------------------------------------------ v26: the pair list
// The registry is launch/pairs.ts (pump.fun Custom Pairs, by category, with sources and a status per asset).
import { CUSTOM_PAIR_FEE, CUSTOM_PAIR_FEE_PRESETS, MAX_FEE_RECIPIENTS, PUMPFUN_PAIRS, pairSelectable, type FeeRange, type PairAsset } from "./pairs.js";
export { PUMPFUN_PAIRS, pairSelectable, CUSTOM_PAIR_FEE, CUSTOM_PAIR_FEE_PRESETS, MAX_FEE_RECIPIENTS, type FeeRange, type PairAsset };

/** The mint for a symbol, from the on-disk table only (data/programs.ts QUOTE_MINTS). Never guessed. */
export function mintOf(symbol: string): string | null {
  return Object.entries(QUOTE_MINTS).find(([, s]) => s === symbol)?.[0] ?? null;
}

export interface QuoteAssetInfo {
  id: QuoteAsset;
  label: string;
  /** Token mint for the create request. null where we aren't sure of the address: then the symbol is sent. */
  mint: string | null;
  /** true only when a live launch has used it. */
  verified: boolean;
  /**
   * v23: the creator fee for this pair, when the creator can set it (non-SOL pairs), in percent of trade volume.
   * Absent = fixed by the launchpad (SOL): no adjuster and no number are shown, and nothing is sent.
   * TODO-verify the range on the first live launch ("verify on first live launch").
   */
  creatorFeeRange?: FeeRange;
}


export interface CreateCapabilities {
  quoteAssets: QuoteAssetInfo[];
  /** v25.1: every pair Vesk knows about, pickable or not (the panel's tiles and "More pairs") */
  pairs?: PairAsset[];
  creatorFees: Array<{ id: CreatorFeeMode; verified: boolean; /** only on custom (non-SOL) pairs */ customOnly?: boolean }>;
  /** v26: fee split among recipients (custom pairs), up to `max`. TODO-verify. */
  feeSplit?: { max: number; verified: boolean };
  /** v26: fee settings lock once the coin is set up (press). Shown before you launch. */
  feesLock?: boolean;
  /** Fields added to the create request, only when the setting isn't the default. TODO-verify the names. */
  createParams: {
    /** Quote asset other than SOL: `{ [field]: mint ?? symbol }`. */
    quote: { field: string };
    /** Creator rewards to holders: `{ [field]: value }`. */
    holderRewards: { field: string; value: string };
    /** v23: the creator fee on a non-SOL pair, in basis points: `{ [field]: pct * 100 }`. TODO-verify the field. */
    creatorFee: { field: string };
    /** v26: Cashback (creator fees go back to traders): `{ [field]: true }`. TODO-verify. */
    cashback?: { field: string };
    /** v26: a fee split: `{ [field]: [{ address, bps }] }`. TODO-verify. */
    split?: { field: string };
  };
  /**
   * v22.1: claiming creator fees. SOL-pair fees use PumpPortal's `collectCreatorFee` (the tested path; it collects
   * all of the wallet's SOL creator fees at once). Fees paid in a quote token add `{ [quoteField]: mint ?? symbol }`
   * to that request. TODO-verify on the first live claim.
   */
  claim: { quoteField: string; quoteVerified: boolean };
}

export const PUMPFUN_CAPS: CreateCapabilities = {
  // v26: the pairs that can be picked (SOL, and every custom pair with a mint); each carries the custom-pair fee range
  quoteAssets: PUMPFUN_PAIRS.filter(pairSelectable).map((p) => ({
    id: p.id as QuoteAsset, label: p.id, mint: p.mint === "native" ? null : p.mint, verified: p.status === "native",
    ...(p.id !== "SOL" ? { creatorFeeRange: CUSTOM_PAIR_FEE } : {}),
  })),
  pairs: PUMPFUN_PAIRS,
  creatorFees: [
    { id: "creator", verified: true },
    // Creator rewards to holders, per the owner's report. TODO-verify the create parameter.
    { id: "holders", verified: false },
    // v26: Cashback and a split, custom pairs only (press). TODO-verify both parameters.
    { id: "cashback", verified: false, customOnly: true },
    { id: "split", verified: false, customOnly: true },
  ],
  feeSplit: { max: MAX_FEE_RECIPIENTS, verified: false },
  feesLock: true,
  createParams: {
    quote: { field: "quoteMint" }, // TODO-verify
    holderRewards: { field: "creatorFeeRecipient", value: "holders" }, // TODO-verify
    creatorFee: { field: "creatorFeeBps" }, // TODO-verify
    cashback: { field: "cashback" }, // TODO-verify
    split: { field: "creatorFeeRecipients" }, // TODO-verify
  },
  claim: { quoteField: "quoteMint", quoteVerified: false }, // TODO-verify on the first live claim
};

/** The creator-fee range for a pair, or null when the launchpad fixes it (SOL). */
export function feeRange(caps: CreateCapabilities | undefined, quote: QuoteAsset): FeeRange | null {
  return caps?.quoteAssets.find((q) => q.id === quote)?.creatorFeeRange ?? null;
}

/** Preset chips for a range: 0.05 / 0.25 / 0.5 / 1 on custom pairs; otherwise every step. */
export function feePresets(r: FeeRange): number[] {
  if (r.min === CUSTOM_PAIR_FEE.min && r.max === CUSTOM_PAIR_FEE.max) return [...CUSTOM_PAIR_FEE_PRESETS];
  const out: number[] = [];
  for (let v = r.min; v <= r.max + 1e-9; v += r.step) out.push(+v.toFixed(4));
  return out;
}

/** A typed or dragged value snapped to the range's step and clamped to it; the default (min) when it isn't a number. */
export function snapFee(r: FeeRange, v: number): number {
  if (!Number.isFinite(v)) return r.min;
  return +Math.min(r.max, Math.max(r.min, r.min + Math.round((v - r.min) / r.step) * r.step)).toFixed(4);
}

/** The fee a plan launches with on a pair: its own when set, else the range's default; null where the launchpad fixes it. */
export function planFee(caps: CreateCapabilities | undefined, quote: QuoteAsset, pct?: number): number | null {
  const r = feeRange(caps, quote);
  return r ? pct ?? r.min : null;
}

/** The asset creator fees are paid in for a pair: SOL, or the quote token. */
export function rewardAsset(caps: CreateCapabilities | undefined, quote: QuoteAsset): { id: QuoteAsset; label: string; mint: string | null } {
  const q = caps?.quoteAssets.find((x) => x.id === quote);
  return q && q.id !== "SOL" ? { id: q.id, label: q.label, mint: q.mint } : { id: "SOL", label: "SOL", mint: null };
}

/** Settings in a plan that rest on an unverified capability, for review screens and logs. */
export function unverifiedSettings(caps: CreateCapabilities | undefined, quote: QuoteAsset, fees: CreatorFeeMode): string[] {
  if (!caps) return [];
  const out: string[] = [];
  const q = caps.quoteAssets.find((x) => x.id === quote);
  if (q && !q.verified) out.push(`${q.label} quote pair`);
  const f = caps.creatorFees.find((x) => x.id === fees);
  if (f && !f.verified) out.push(fees === "holders" ? "creator rewards to holders" : fees === "cashback" ? "Cashback" : fees === "split" ? "the fee split" : `creator fees: ${fees}`);
  if (q?.creatorFeeRange && !q.verified) out.push(`the ${q.label} creator fee`);
  return out;
}
