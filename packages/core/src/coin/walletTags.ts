/**
 * Wallet tags (the icons next to a wallet on the coin page, in Pulse audits and in the copy-trade feed) and the
 * holding status gauge: one place for each tag's name, what it means and how it's worked out, so every tooltip and
 * the legend say the same thing. The rules themselves live in watch/audits.ts (sniper, bundled, insider) and
 * coin/traders.ts (earlyBuyerLabels, earlyBuyers' status).
 */
import { BRAND } from "../brand.js";
import { SNIPER_WINDOW_MS } from "../watch/audits.js";
import type { BuyerLabel, EarlyBuyer } from "./traders.js";

export type WalletTag = BuyerLabel;
export type HoldStatus = Exclude<EarlyBuyer["status"], "unknown">;

/** Display order everywhere: who it is first, then the risk tags. */
export const WALLET_TAGS: WalletTag[] = ["you", "dev", "team", "tracked", "sniper", "bundled", "insider"];
export const HOLD_STATUSES: HoldStatus[] = ["holding", "sold some", "sold all"];
/** Tags that point at a risk when the wallet is someone else's (drawn in amber then, neutral on your own wallets). */
export const RISK_TAGS: ReadonlySet<WalletTag> = new Set(["sniper", "bundled", "insider"]);

export interface TagInfo {
  name: string;
  /** One line: what it means. */
  meaning: string;
  /** How it's worked out. */
  how: string;
  /** How it's worked out when the data for the exact rule is missing (the tag is then approximate or unknown). */
  howApprox?: string;
}

const secs = SNIPER_WINDOW_MS / 1000;

export const TAG_INFO: Record<WalletTag, TagInfo> = {
  you: { name: "You", meaning: "One of your wallets.", how: "Your hosted, imported or signed-linked wallets." },
  dev: { name: "Dev", meaning: "Created this coin.", how: "The wallet that signed the coin's create transaction." },
  team: { name: "Team (disclosed)", meaning: "A team wallet disclosed at launch.", how: `Listed in the coin's description and treasury report; ${BRAND.name} launches always disclose them.` },
  tracked: { name: "Tracked", meaning: "In your address book with Track on.", how: "Your list in Wallets → Address book; its label and image show here." },
  sniper: { name: "Sniper", meaning: "Bought right at launch, usually a bot.", how: `First buy within ${secs} seconds of the coin's creation, and not the dev.` },
  bundled: {
    name: "Bundled", meaning: "Bought in the creation block together with linked wallets.",
    how: "In the creation block, and the dev, funded by the dev or the dev's funder, or funded by the same wallet as another block buyer (first SOL transfer, read through your RPC).",
    howApprox: "No funding data: every creation-block buyer counts, so it's approximate (an upper bound).",
  },
  insider: {
    name: "Insider", meaning: "Funded by someone close to the coin.",
    how: "Its first SOL came from the dev, the dev's funder, or the same wallet as another early buyer (read through your RPC).",
    howApprox: "Unknown without funding data, so not shown.",
  },
};

export const STATUS_INFO: Record<HoldStatus, TagInfo> = {
  holding: { name: "Holding", meaning: "Still holds what it bought.", how: "The largest holder accounts when it's among them, otherwise bought minus sold in the loaded trades." },
  "sold some": { name: "Sold part", meaning: "Sold some, still holds the rest.", how: "Holds less than 98% of what it bought: the largest holder accounts, or bought minus sold in the loaded trades." },
  "sold all": { name: "Sold all", meaning: "Sold everything it bought.", how: "Holds 2% or less of what it bought: the largest holder accounts, or bought minus sold in the loaded trades." },
};

/** Tooltip text for a tag: title, the one-line meaning, and how it's derived (the approximate rule when `approx`). */
export function tagTooltip(tag: WalletTag | HoldStatus, opts: { approx?: boolean } = {}): { label: string; desc: string; how: string } {
  const i = (TAG_INFO as Record<string, TagInfo>)[tag] ?? STATUS_INFO[tag as HoldStatus];
  return { label: i.name, desc: i.meaning, how: opts.approx && i.howApprox ? i.howApprox : i.how };
}

/** Amber only for a risk tag on someone else's wallet; your own (you / disclosed team) stay neutral. */
export function tagTone(tag: WalletTag, tagsOfWallet: readonly WalletTag[]): "risk" | "accent" | "neutral" {
  if (tag === "you" || tag === "tracked") return "accent";
  if (RISK_TAGS.has(tag)) return tagsOfWallet.includes("you") || tagsOfWallet.includes("team") ? "neutral" : "risk";
  return "neutral";
}

/** Sort a wallet's tags into the display order. */
export const orderTags = (tags: readonly WalletTag[]): WalletTag[] => WALLET_TAGS.filter((t) => tags.includes(t));
