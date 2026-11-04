/**
 * Everything a Pulse row can show, with where each number comes from. One registry (ROW_ELEMENTS) drives the
 * Row elements settings, the live preview and docs/26-data-sources.md; `rowFacts` computes the values.
 * A value we can't compute is `null` and the UI shows it as unavailable. Nothing is invented.
 */
import { exchangeOf } from "../data/exchanges.js";
import { type BlacklistIndex } from "./blacklist.js";
import { pulseAudits, type PulseAudits, type PulseEnrichment } from "./audits.js";
import { PULSE_PROTOCOLS, reusedImage, reusedX, xHandle, type PulseState, type PulseToken } from "./pulse.js";

export type RowGroup = "token" | "metrics" | "audit";
export type RowAvail = "live" | "rpc" | "external" | "own-list" | "unavailable";

export interface RowElement {
  id: string;
  group: RowGroup;
  label: string;
  /** live: from the PumpPortal stream; rpc: from your RPC (enrichment); external: a public API (DexScreener, pump.fun);
   *  own-list: from your own address book / blacklist; unavailable: not derivable from public data, never shown. */
  avail: RowAvail;
  how: string;
  /** On by default. */
  def: boolean;
}

export const ROW_ELEMENTS: RowElement[] = [
  // token info
  { id: "socials", group: "token", label: "Socials", avail: "live", how: "X, Telegram, website and Discord links from the coin's metadata JSON (its URI).", def: true },
  { id: "quote", group: "token", label: "Quote chip", avail: "live", how: "The quote asset of the coin's curve or pool: SOL for pump.fun and LetsBonk.", def: false },
  { id: "quoteTicker", group: "token", label: "Quote ticker", avail: "live", how: "Ticker shown as TICKER/SOL.", def: false },
  { id: "xLink", group: "token", label: "X link", avail: "live", how: "The X link in the metadata, opened in a new tab.", def: true },
  { id: "xRenames", group: "token", label: "X renames", avail: "unavailable", how: "Needs the account's name history, which no public source here provides.", def: false },
  { id: "communities", group: "token", label: "Communities", avail: "live", how: "Marks an X link that points to an X Community (x.com/i/communities/…) rather than an account.", def: true },
  { id: "launchpad", group: "token", label: "Launchpad", avail: "live", how: "From the stream's pool field (pump, bonk) or the program that created the pool.", def: true },
  { id: "pumpLive", group: "token", label: "Pump live", avail: "external", how: "pump.fun's currently-live list (an unofficial endpoint, checked through the edge function). Shown only when it answers.", def: false },
  { id: "website", group: "token", label: "Website", avail: "live", how: "Website link from the metadata.", def: true },
  { id: "telegram", group: "token", label: "Telegram", avail: "live", how: "Telegram link from the metadata.", def: true },
  { id: "discord", group: "token", label: "Discord", avail: "live", how: "Discord link from the metadata, when the coin sets one (most don't).", def: false },
  { id: "feeSplit", group: "token", label: "Fee split", avail: "unavailable", how: "Creator-fee sharing settings aren't in the stream or the metadata.", def: false },
  { id: "indicators", group: "token", label: "Indicators", avail: "live", how: "Small marks for reused X link, reused image and blacklisted funder.", def: true },
  { id: "boosts", group: "token", label: "Boosts", avail: "external", how: "Active DexScreener boosts on the coin's pairs (DexScreener token API).", def: false },
  { id: "xSearch", group: "token", label: "X search", avail: "live", how: "A link that searches X for the contract address.", def: true },
  { id: "imageReuse", group: "token", label: "Image reuse", avail: "live", how: "The same image URL was used by an earlier coin on the board (URL match, not a visual match).", def: true },
  { id: "xHandle", group: "token", label: "X handle", avail: "live", how: "The @handle in the coin's X link.", def: false },
  { id: "xFollowing", group: "token", label: "X following", avail: "unavailable", how: "Needs the X API user lookup; not fetched for every coin (rate limits).", def: false },
  { id: "xFollowers", group: "token", label: "X followers", avail: "unavailable", how: "Needs the X API user lookup; not fetched for every coin (rate limits).", def: false },
  // metrics
  { id: "volume", group: "metrics", label: "Volume", avail: "live", how: "Sum of SOL traded since the board started watching, × SOL price.", def: true },
  { id: "mcap", group: "metrics", label: "Market cap", avail: "live", how: "marketCapSol from the latest trade × SOL price.", def: true },
  { id: "fees", group: "metrics", label: "Fees", avail: "live", how: "Volume × 1.25% (an estimate of launchpad trading fees).", def: true },
  { id: "tx", group: "metrics", label: "TX", avail: "live", how: "Buys + sells seen.", def: true },
  { id: "traders", group: "metrics", label: "Traders", avail: "live", how: "Distinct wallets seen trading.", def: false },
  { id: "holders", group: "metrics", label: "Holders", avail: "rpc", how: "Token accounts with a balance (getProgramAccounts, curve removed); stream count until your RPC answers.", def: true },
  { id: "proTraders", group: "metrics", label: "Pro traders", avail: "unavailable", how: "There's no public, checkable definition of a pro trader.", def: false },
  { id: "kols", group: "metrics", label: "KOLs", avail: "own-list", how: "Holders that you marked as KOL in your address book. Nobody else's list.", def: false },
  { id: "devMigrations", group: "metrics", label: "Dev migrations", avail: "live", how: "Coins by the same dev that migrated, as seen by this board (a lower bound).", def: false },
  { id: "devCreations", group: "metrics", label: "Dev creations", avail: "live", how: "Coins by the same dev seen by this board (a lower bound).", def: false },
  // audit
  { id: "top10", group: "audit", label: "Top 10", avail: "rpc", how: "Share of supply in the 10 largest holders (getTokenLargestAccounts, curve removed).", def: true },
  { id: "devHolding", group: "audit", label: "Dev holding", avail: "live", how: "The dev's balance / supply from the stream.", def: true },
  { id: "trackDev", group: "audit", label: "Track dev", avail: "own-list", how: "Highlights coins by devs you track in your address book.", def: true },
  { id: "fundingAmount", group: "audit", label: "Funding amount", avail: "rpc", how: "SOL in the dev wallet's funding transfer (oldest transfer among its last 25 signatures).", def: false },
  { id: "fundingWallet", group: "audit", label: "Funding wallet", avail: "rpc", how: "Who sent that transfer.", def: false },
  { id: "fundedExchange", group: "audit", label: "Funded exchange", avail: "rpc", how: "The funding wallet matched against labelled exchange hot wallets (data/exchanges.ts).", def: false },
  { id: "fundingTime", group: "audit", label: "Funding time", avail: "rpc", how: "How long before the create the dev wallet was funded (block time of the funding transfer).", def: false },
  { id: "flagged", group: "audit", label: "Flagged", avail: "own-list", how: "The dev or the dev's funder is on your blacklist.", def: true },
  { id: "snipers", group: "audit", label: "Snipers", avail: "live", how: "Supply held by wallets whose first buy came within 3 s of the create.", def: true },
  { id: "insiders", group: "audit", label: "Insiders", avail: "rpc", how: "Supply held by wallets funded by the dev, the dev's funder or a shared funder.", def: true },
  { id: "bundlers", group: "audit", label: "Bundlers", avail: "live", how: "Supply bought in the creation block by wallets funded together (upper bound without funding data).", def: true },
  { id: "tax", group: "audit", label: "Tax", avail: "rpc", how: "Token-2022 transfer fee from the mint's transferFeeConfig extension (0 for classic SPL mints).", def: false },
  { id: "dexPaid", group: "audit", label: "DEX paid", avail: "external", how: "DexScreener orders API: an approved paid order (token profile) for this coin.", def: false },
];

export type RowElementId = (typeof ROW_ELEMENTS)[number]["id"];
export const defaultRowElements = (): Record<string, boolean> => Object.fromEntries(ROW_ELEMENTS.map((e) => [e.id, e.avail !== "unavailable" && e.def]));

/** Token-2022 transfer fee (bps) from a jsonParsed mint account; 0 when the mint has no transfer-fee extension. */
export function token2022TaxBps(parsed: unknown): number | undefined {
  const info = (parsed as { value?: { data?: { parsed?: { info?: { extensions?: Array<{ extension?: string; state?: { newerTransferFee?: { transferFeeBasisPoints?: number } } }> } } } } })?.value?.data?.parsed?.info;
  if (!info) return undefined;
  const ext = info.extensions?.find((x) => x.extension === "transferFeeConfig");
  return ext ? Number(ext.state?.newerTransferFee?.transferFeeBasisPoints ?? 0) : 0;
}

/** DexScreener orders response → paid (an approved order exists). */
export function dexPaidFromOrders(orders: unknown): boolean | undefined {
  if (!Array.isArray(orders)) return undefined;
  return orders.some((o) => (o as { status?: string }).status === "approved");
}

/** DexScreener token pairs → active boosts (max across pairs). */
export function boostsFromPairs(pairs: unknown): number | undefined {
  const list = Array.isArray(pairs) ? pairs : (pairs as { pairs?: unknown[] })?.pairs;
  if (!Array.isArray(list)) return undefined;
  return list.reduce((m: number, p) => Math.max(m, Number((p as { boosts?: { active?: number } }).boosts?.active ?? 0)), 0);
}

export interface RowFacts extends PulseAudits {
  protocolName: string;
  quote: string;
  xHandle?: string;
  xCommunity: boolean;
  reusedX: boolean;
  reusedImage: boolean;
  kols: number | null;
  trackedDev: boolean;
  flagged: string | null;
  funding: { from: string; sol: number; exchange?: string; beforeCreateMs?: number } | null;
  taxBps: number | null;
  dexPaid: boolean | null;
  boosts: number | null;
  live: boolean | null;
}

/** Every value a row can show. `own` is your own lists: KOL and tracked-dev addresses, and your blacklist. */
export function rowFacts(s: PulseState, t: PulseToken, e: PulseEnrichment | undefined, own: { kols?: Set<string>; trackedDevs?: Set<string>; blacklist?: BlacklistIndex } = {}): RowFacts {
  const a = pulseAudits(s, t, e);
  const holders = e?.largest?.length ? e.largest.map((x) => x.owner) : Object.keys(s.bal[t.mint] ?? {});
  const df = e?.devFunding;
  const flaggedDev = t.creator && own.blacklist ? (own.blacklist.devs.has(t.creator) || own.blacklist.wallets.has(t.creator) ? "dev on your blacklist" : null) : null;
  const flaggedFunder = df && own.blacklist && (own.blacklist.funders.has(df.from) || own.blacklist.wallets.has(df.from)) ? "funder on your blacklist" : null;
  return {
    ...a,
    protocolName: PULSE_PROTOCOLS.find((p) => p.id === t.protocol)?.name ?? t.protocol,
    quote: "SOL",
    xHandle: t.xKind === "community" ? undefined : xHandle(t.socials.x),
    xCommunity: t.xKind === "community",
    reusedX: reusedX(s, t),
    reusedImage: reusedImage(s, t),
    kols: own.kols ? holders.filter((h) => own.kols!.has(h)).length : null,
    trackedDev: !!t.creator && !!own.trackedDevs?.has(t.creator),
    flagged: flaggedDev ?? flaggedFunder,
    funding: df ? { from: df.from, sol: df.sol, exchange: exchangeOf(df.from), ...(df.at ? { beforeCreateMs: Math.max(0, t.createdAt - df.at) } : {}) } : null,
    taxBps: e?.taxBps ?? null,
    dexPaid: e?.dexPaid ?? null,
    boosts: e?.boosts ?? null,
    live: e?.live ?? null,
  };
}
