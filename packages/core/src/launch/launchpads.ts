/**
 * Launchpads Vesk knows about, and what it can actually do on each.
 *
 * Only launchpads with status "ready" can be selected anywhere (panel, CLI, MCP, chat). A launchpad is
 * "ready" only when the agent has a working, tested code path for it. Today that is pump.fun, through
 * PumpPortal's local-transaction API (we build, PumpPortal returns unsigned transactions, you sign).
 * pump.fun's non-SOL quote pairs and holder rewards (v22) are offered but not yet verified live: capabilities.ts.
 *
 * Not ready yet, and why:
 *  - LetsBonk: PumpPortal can trade the bonk pool, but Vesk's create path for it isn't built or tested.
 *  - Meteora DBC: needs Meteora's Dynamic Bonding Curve SDK; not integrated yet.
 *  - The rest: no public create API we've integrated.
 */
import type { Chain, Launchpad } from "../types.js";
import { PUMPFUN_CAPS, type CreateCapabilities } from "./capabilities.js";

/** v25.1: a pair added to capabilities.ts PUMPFUN_PAIRS works without touching this type (one line per pair). */
export type QuoteAsset = "SOL" | "USDC" | "USD1" | "custom" | (string & {});
/** v26: "cashback" (fees back to traders) and "split" (up to 10 recipients) are custom-pair settings; TODO-verify. */
export type CreatorFeeMode = "creator" | "holders" | "cashback" | "split";

export interface LaunchpadInfo {
  id: Launchpad;
  name: string;
  chain: Chain;
  status: "ready" | "soon";
  /** One line for the picker. */
  note: string;
  /** How Vesk talks to it, when ready. */
  via?: string;
  /** Quote assets the launchpad offers, and which of those Vesk can use. */
  quotes: { offered: QuoteAsset[]; supported: QuoteAsset[] };
  /**
   * The launchpad's own creator-fee setting, if it has one. `supported` lists the modes Vesk can set at
   * create time; anything offered but not supported is shown disabled with `reason`.
   */
  creatorFees?: { offered: CreatorFeeMode[]; supported: CreatorFeeMode[]; reason?: string };
  /** Create + first buys can go out as one Jito bundle (max 5 transactions). */
  bundle: boolean;
  /** v22: settings offered at create that a live launch hasn't confirmed yet (see capabilities.ts). */
  caps?: CreateCapabilities;
}

export const LAUNCHPADS: LaunchpadInfo[] = [
  {
    id: "pumpfun", name: "pump.fun", chain: "solana", status: "ready", via: "PumpPortal local transactions + Jito bundle",
    note: "Bonding curve, graduates to PumpSwap.",
    // v22: quote assets and holder rewards come from capabilities.ts (TODO-verify on the first live launch)
    quotes: { offered: PUMPFUN_CAPS.quoteAssets.map((q) => q.id), supported: PUMPFUN_CAPS.quoteAssets.map((q) => q.id) },
    creatorFees: { offered: ["creator", "holders", "cashback", "split"], supported: ["creator", "holders", "cashback", "split"] },
    bundle: true,
    caps: PUMPFUN_CAPS,
  },
  // v19: an adapter scaffold exists (launch/stonkfun.ts); it stays "soon" until its program ID and create interface are
  // confirmed (docs/38-launchpads.md says what's needed). Never guessed.
  { id: "stonkfun", name: "StonkFun", chain: "solana", status: "soon", note: "Adapter ready to wire; waiting on a confirmed program ID and create API.", quotes: { offered: ["SOL"], supported: [] }, bundle: false },
  { id: "letsbonk", name: "LetsBonk", chain: "solana", status: "soon", note: "Create path not built yet (trading works).", quotes: { offered: ["SOL", "USD1"], supported: [] }, bundle: false },
  { id: "bags", name: "Bags", chain: "solana", status: "soon", note: "Not integrated yet.", quotes: { offered: ["SOL"], supported: [] }, bundle: false },
  { id: "anoncoin", name: "Anoncoin", chain: "solana", status: "soon", note: "Not integrated yet.", quotes: { offered: ["SOL"], supported: [] }, bundle: false },
  { id: "surge", name: "Surge", chain: "solana", status: "soon", note: "Not integrated yet.", quotes: { offered: ["SOL"], supported: [] }, bundle: false },
  { id: "printr", name: "Printr", chain: "solana", status: "soon", note: "Not integrated yet.", quotes: { offered: ["SOL"], supported: [] }, bundle: false },
  { id: "meteora-dbc", name: "Meteora DBC", chain: "solana", status: "soon", note: "Needs Meteora's DBC SDK. Not integrated yet.", quotes: { offered: ["SOL", "USD1", "custom"], supported: [] }, bundle: false },
  { id: "stoxes", name: "Stoxes", chain: "solana", status: "soon", note: "Not integrated yet.", quotes: { offered: ["SOL"], supported: [] }, bundle: false },
  { id: "lesgo", name: "Lesgo", chain: "solana", status: "soon", note: "Not integrated yet.", quotes: { offered: ["SOL"], supported: [] }, bundle: false },
  { id: "memefun", name: "meme.fun", chain: "solana", status: "soon", note: "Not integrated yet.", quotes: { offered: ["SOL"], supported: [] }, bundle: false },
];

export const CHAINS: Array<{ id: Chain; name: string; status: "ready" | "soon" }> = [
  { id: "solana", name: "Solana", status: "ready" },
  { id: "base", name: "Base", status: "soon" },
  { id: "bnb", name: "BNB Chain", status: "soon" },
  { id: "ethereum", name: "Ethereum", status: "soon" },
];

export function launchpad(id: Launchpad): LaunchpadInfo {
  const l = LAUNCHPADS.find((x) => x.id === id);
  if (!l) throw new Error(`Unknown launchpad ${id}`);
  return l;
}

export function isLaunchpad(id: string): id is Launchpad {
  return LAUNCHPADS.some((x) => x.id === id);
}
