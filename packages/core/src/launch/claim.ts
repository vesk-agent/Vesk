/**
 * Creator-fee claims (v22.1, v23). Pure logic shared by the agent (CLI, MCP, chat), the hosted function and the
 * panel's Claim page.
 *
 *  - SOL pairs: PumpPortal `collectCreatorFee`, the tested path. pump.fun pays creator fees per creator wallet, so one
 *    claim collects all of that wallet's SOL creator fees at once (every SOL-pair coin it created).
 *  - Custom pairs (USDC, xStocks…): the same request plus the quote field from the capability config. Fees are paid in
 *    the quote asset and stay in it (v26: Vesk no longer swaps them). Like SOL, the request names the wallet and the
 *    asset, not the coin, so one claim is treated as collecting all of the wallet's fees in that asset. Not verified on
 *    a live claim yet (capabilities.ts, LAUNCH-READINESS "verify on first live launch"); never blocked.
 */
import type { PumpPortalRequest } from "../trade/pumpportal.js";
import { rewardAsset, type CreateCapabilities } from "./capabilities.js";
import type { CreatorFeeMode, QuoteAsset } from "./launchpads.js";

/** Priority fee on a claim transaction (same as before v22.1). */
export const CLAIM_PRIORITY_FEE_SOL = 0.0001;

export function claimRequest(owner: string, quote: QuoteAsset, caps?: CreateCapabilities): PumpPortalRequest {
  const base: PumpPortalRequest = { publicKey: owner, action: "collectCreatorFee", priorityFee: CLAIM_PRIORITY_FEE_SOL, pool: "pump" };
  if (quote === "SOL" || !caps) return base;
  const a = rewardAsset(caps, quote);
  // TODO-verify on the first live claim: the field name and that it takes the mint (capabilities.ts `claim`)
  return { ...base, [caps.claim.quoteField]: a.mint ?? a.id } as PumpPortalRequest;
}

/** Is this claim path verified on a live claim? */
export const claimVerified = (quote: QuoteAsset, caps?: CreateCapabilities) => quote === "SOL" || !!caps?.claim.quoteVerified;


/** One coin you launched, as the Claim page shows it. Amounts are in the reward asset (SOL or the quote token). */
export interface CreatorFeeRow {
  mint: string;
  name: string;
  symbol: string;
  image?: string;
  launchpad: string;
  quote: QuoteAsset;
  /** Where creator rewards go. "holders" rows have nothing to claim. */
  mode: CreatorFeeMode;
  /** The creator wallet (fees are paid to it). */
  creator: string;
  /** Who can sign the claim: the hosted wallet or your agent. A browser-wallet creator claims on the launchpad. */
  signer: "hosted" | "agent" | "browser";
  /** Unclaimed, in the reward asset. null when the venue doesn't report it. */
  unclaimed: number | null;
  /** ≈ SOL value of `unclaimed`. */
  unclaimedSol: number | null;
  claimedTotal: number;
  claimedTotalSol: number;
  lastClaimedAt: string | null;
}

export interface ClaimTotals {
  /** ≈ SOL claimable across rows you can claim here. */
  claimableSol: number;
  /** Rows with something to claim here. */
  claimable: number;
  claimedSol: number;
  holders: number;
}

/** A row this page (or the agent) can claim: fees to the creator, signed here, with something (or an unknown amount) waiting. */
export const canClaimRow = (r: CreatorFeeRow) => r.mode === "creator" && r.signer !== "browser" && (r.unclaimed === null || r.unclaimed > 0);

export function claimTotals(rows: CreatorFeeRow[]): ClaimTotals {
  const can = rows.filter((r) => canClaimRow(r) && (r.unclaimed ?? 0) > 0);
  return {
    claimableSol: can.reduce((a, r) => a + (r.unclaimedSol ?? 0), 0),
    claimable: can.length,
    claimedSol: rows.reduce((a, r) => a + r.claimedTotalSol, 0),
    holders: rows.filter((r) => r.mode === "holders").length,
  };
}

/** v23: what's claimable, per asset (the hero): SOL first, then quote tokens, each with its ≈ SOL value and coin count. */
export interface AssetTotal { asset: QuoteAsset; amount: number; sol: number; coins: number }
export function claimableByAsset(rows: CreatorFeeRow[]): AssetTotal[] {
  const m = new Map<QuoteAsset, AssetTotal>();
  for (const r of rows) {
    if (!canClaimRow(r) || !(r.unclaimed && r.unclaimed > 0)) continue;
    const t = m.get(r.quote) ?? { asset: r.quote, amount: 0, sol: 0, coins: 0 };
    t.amount += r.unclaimed; t.sol += r.unclaimedSol ?? 0; t.coins += 1;
    m.set(r.quote, t);
  }
  return [...m.values()].sort((a, b) => (a.asset === "SOL" ? -1 : b.asset === "SOL" ? 1 : b.sol - a.sol));
}

/**
 * The coins one claim collects: every row of the same creator wallet paid in the same asset (the request names the
 * wallet and the asset, not the coin). For SOL this is pump.fun's documented behaviour; for quote tokens it follows
 * from the same request and is part of "verify on first live launch".
 */
export function claimCovers(rows: CreatorFeeRow[], mint: string): string[] {
  const r = rows.find((x) => x.mint === mint);
  if (!r) return [];
  return rows.filter((x) => x.creator === r.creator && x.quote === r.quote && x.mode === "creator" && x.signer === r.signer).map((x) => x.mint);
}

/** v23: one claim to send: a creator wallet and an asset, the coins it collects and what's expected. */
export interface ClaimGroup {
  asset: QuoteAsset;
  creator: string;
  signer: CreatorFeeRow["signer"];
  /** Every coin the claim collects; `lead` is the one the request is sent for. */
  mints: string[];
  lead: string;
  symbols: string[];
  /** Expected amount in the asset, or null when not reported. */
  amount: number | null;
  sol: number | null;
}

/** "Claim all": the claimable rows grouped by asset and creator wallet, SOL first. One group = one claim. */
export function claimGroups(rows: CreatorFeeRow[], only?: (r: CreatorFeeRow) => boolean): ClaimGroup[] {
  const out = new Map<string, ClaimGroup>();
  for (const r of rows) {
    if (!canClaimRow(r) || (only && !only(r))) continue;
    const k = `${r.quote}:${r.creator}:${r.signer}`;
    const g = out.get(k) ?? { asset: r.quote, creator: r.creator, signer: r.signer, mints: [], lead: r.mint, symbols: [], amount: 0, sol: 0 };
    g.mints.push(r.mint); g.symbols.push(r.symbol);
    g.amount = g.amount === null || r.unclaimed === null ? null : g.amount + r.unclaimed;
    g.sol = g.sol === null || r.unclaimedSol === null ? null : g.sol + r.unclaimedSol;
    out.set(k, g);
  }
  return [...out.values()].sort((a, b) => (a.asset === b.asset ? 0 : a.asset === "SOL" ? -1 : b.asset === "SOL" ? 1 : a.asset.localeCompare(b.asset)));
}

// ---------------------------------------------------------------- the agent's own launches (CLI, MCP, chat)

/** A coin this agent launched, recorded at launch (state.json `launched`). */
export interface LaunchedCoin {
  mint: string;
  name: string;
  symbol: string;
  launchpad: string;
  quote: QuoteAsset;
  mode: CreatorFeeMode;
  creator: string;
  /** v23: the creator fee set at launch on a non-SOL pair (percent); absent on SOL (fixed by the launchpad). */
  feePct?: number;
  at: number;
  signature?: string;
}

/** A claim the agent made (state.json `treasury`, kind "claim"). `asset`/`amount` from v23; older entries are SOL. */
export interface ClaimEntry { at: number; mint?: string; sol?: number; asset?: string; amount?: number }

/**
 * The agent's Claim rows: one per coin it launched, with what it has claimed so far. The agent can't read unclaimed
 * amounts from the venue (no confirmed read endpoint), so `unclaimed` is null: claiming collects whatever is there and
 * says how much arrived.
 */
export function rowsFromLaunches(launched: LaunchedCoin[], claims: ClaimEntry[]): CreatorFeeRow[] {
  return launched.map((c) => {
    const mine = claims.filter((e) => e.mint === c.mint);
    const inAsset = (e: ClaimEntry) => (e.asset && e.asset !== "SOL" ? e.amount ?? 0 : e.sol ?? 0);
    const last = mine.reduce((a, e) => Math.max(a, e.at), 0);
    return {
      mint: c.mint, name: c.name, symbol: c.symbol, launchpad: c.launchpad, quote: c.quote, mode: c.mode, creator: c.creator, signer: "agent" as const,
      unclaimed: null, unclaimedSol: null,
      claimedTotal: mine.filter((e) => (e.asset ?? "SOL") === c.quote).reduce((a, e) => a + inAsset(e), 0),
      claimedTotalSol: mine.reduce((a, e) => a + (e.sol ?? 0), 0),
      lastClaimedAt: last ? new Date(last).toISOString() : null,
    };
  });
}

// ---------------------------------------------------------------- chat: "claim my fees"

/** v23: a claim asked for in chat. Nothing runs until you confirm. */
export interface ClaimChat { kind: "claim"; all: boolean; symbol?: string; summary: string[] }

/**
 * "claim my fees", "collect fees for $OWL". Returns null for anything else
 * (so "claim" in a snipe rule, or a launch description, isn't taken for a claim).
 */
export function parseClaimRequest(text: string): ClaimChat | null {
  const t = text.trim();
  const verb = /\b(?:claim|collect|withdraw|harvest)\b/i;
  const what = /\b(?:fees?|creator\s+(?:fees?|rewards?)|rewards?|earnings)\b/i;
  if (!verb.test(t) || !what.test(t) || t.length > 160) return null;
  if (/\b(?:snipe|buy|launch\s+(?:a|an|the)\b|copy|when\s+@|if\s+@)/i.test(t)) return null;
  const sym = /\$([A-Za-z][A-Za-z0-9]{1,9})\b/.exec(t)?.[1]?.toUpperCase();
  const summary = [
    sym ? `Claim: creator fees for $${sym}` : "Claim: creator fees from every coin you launched, grouped by asset",
    "Paid in: SOL, or the pair's quote asset",
  ];
  return { kind: "claim", all: !sym, symbol: sym, summary };
}
