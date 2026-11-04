/**
 * RPC enrichment for Pulse audits, through YOUR RPC:
 *  - largest holders: getTokenLargestAccounts → owners via getMultipleAccounts (jsonParsed), minus the pump.fun
 *    bonding-curve PDA (and any pool accounts you pass);
 *  - funding source per wallet: the sender of the oldest SOL transfer into it among its most recent
 *    `sigLimit` signatures. Fresh sniper and insider wallets have only a few signatures, so this is usually the
 *    funding transfer; for old, busy wallets it's only the oldest transfer in that page (approximate).
 * The same logic runs in the hosted edge function (`pulse-enrich`) for the panel.
 */
import { PublicKey } from "@solana/web3.js";
import type { Rpc } from "../rpc.js";
import { b58encode } from "../base58.js";
import { countHolders, funderFromTx, fundingFromTx, holderScanParams, type PulseEnrichment } from "./audits.js";
import { boostsFromPairs, dexPaidFromOrders, token2022TaxBps } from "./facts.js";
import { SYSTEM_PROGRAM } from "../data/clusterExclude.js";

export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

export function bondingCurvePda(mint: string): string {
  return PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBytes()], new PublicKey(PUMP_PROGRAM_ID))[0].toBase58();
}

type Parsed = { value: Array<{ data?: { parsed?: { info?: { owner?: string } } } } | null> };

export async function enrichCoin(rpc: Rpc, mint: string, o: { dev?: string; exclude?: string[]; maxFunding?: number; sigLimit?: number; countHolders?: boolean } = {}): Promise<PulseEnrichment> {
  const out: PulseEnrichment = { at: Date.now() };
  const skip = new Set([bondingCurvePda(mint), ...(o.exclude ?? [])]);
  // Holder count: every token account of the mint (owner + amount only). Some RPCs refuse getProgramAccounts;
  // then the count stays the stream's (wallets seen trading).
  // The mint account (jsonParsed): its token program (for the holder scan) and any Token-2022 transfer fee (tax).
  const info = await rpc.call<{ value: { owner: string; data?: unknown } | null }>("getAccountInfo", [mint, { encoding: "jsonParsed" }]).catch(() => null);
  const tax = token2022TaxBps(info);
  if (tax !== undefined) out.taxBps = tax;
  if (o.countHolders !== false) {
    const prog = info?.value?.owner;
    if (prog) {
      const rows = await rpc.call<Array<{ account?: { data?: [string, string] } }>>("getProgramAccounts", holderScanParams(prog, mint)).catch(() => null);
      if (Array.isArray(rows)) out.holders = countHolders(rows, skip, b58encode);
    }
  }
  const largest = await rpc.call<{ value: Array<{ address: string; uiAmount: number | null }> }>("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]).catch(() => null);
  if (largest?.value?.length) {
    const accts = largest.value.slice(0, 20);
    const parsed = await rpc.call<Parsed>("getMultipleAccounts", [accts.map((a) => a.address), { encoding: "jsonParsed" }]).catch(() => null);
    out.largest = accts
      .map((a, i) => ({ owner: parsed?.value?.[i]?.data?.parsed?.info?.owner ?? a.address, amount: a.uiAmount ?? 0 }))
      .filter((x) => !skip.has(x.owner) && x.amount > 0);
  }
  const wallets = [...new Set([...(o.dev ? [o.dev] : []), ...(out.largest ?? []).map((x) => x.owner)])].slice(0, o.maxFunding ?? 10);
  const funding: Record<string, string> = {};
  for (const w of wallets) {
    const sigs = await rpc.call<Array<{ signature: string }>>("getSignaturesForAddress", [w, { limit: o.sigLimit ?? 25 }]).catch(() => []);
    const oldest = sigs[sigs.length - 1]?.signature;
    if (!oldest) continue;
    const tx = await rpc.call<unknown>("getTransaction", [oldest, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]).catch(() => null);
    const f = funderFromTx(tx, w);
    if (f) funding[w] = f;
    if (w === o.dev) { const df = fundingFromTx(tx, w); if (df) out.devFunding = df; }
  }
  if (Object.keys(funding).length) out.funding = funding;
  // v19: the coin's own curve / pool accounts are never links, and neither is a funder owned by a program (a pool, a
  // vault, a PDA): one getMultipleAccounts on the distinct funders says who owns each. A person's wallet is owned by
  // the System Program (or doesn't exist yet).
  out.exclude = [...skip];
  const funders = [...new Set(Object.values(funding))];
  if (funders.length) {
    const owners = await rpc.call<{ value: Array<{ owner?: string } | null> }>("getMultipleAccounts", [funders, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]).catch(() => null);
    const po = funders.filter((_, i) => { const o = owners?.value?.[i]?.owner; return !!o && o !== SYSTEM_PROGRAM; });
    if (po.length) out.programOwned = po;
  }
  return out;
}

/**
 * DexScreener extras for one coin (public API, no key): paid orders (token profile / ads) and active boosts.
 * Network calls to api.dexscreener.com; returns only what answered.
 */
export async function dexScreenerExtras(mint: string, f: typeof fetch = fetch): Promise<Pick<PulseEnrichment, "dexPaid" | "boosts">> {
  const out: Pick<PulseEnrichment, "dexPaid" | "boosts"> = {};
  const get = (u: string) => f(u, { signal: AbortSignal.timeout(5000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [orders, pairs] = await Promise.all([get(`https://api.dexscreener.com/orders/v1/solana/${mint}`), get(`https://api.dexscreener.com/token-pairs/v1/solana/${mint}`)]);
  const paid = dexPaidFromOrders(orders);
  if (paid !== undefined) out.dexPaid = paid;
  const b = boostsFromPairs(pairs);
  if (b !== undefined) out.boosts = b;
  return out;
}
