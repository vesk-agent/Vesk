/**
 * The can-sell check's I/O (v19), through YOUR RPC and Jupiter:
 *  1. getAccountInfo(mint, jsonParsed): authorities and Token-2022 extensions (strategy/honeypot.ts).
 *  2. With simulate on: a current holder's wallet (getTokenLargestAccounts → owners, keeping only System-owned wallets:
 *     not a pool, a curve or a vault), a Jupiter quote for 10% of its tokens back to SOL, the swap built for that
 *     holder, and simulateTransaction with signatures not checked (sigVerify false, replaceRecentBlockhash true).
 *     Nothing is signed or sent. A coin you can't sell fails here the way it would fail for you.
 * Before you hold a coin you can't simulate your own sell, so a holder's is the closest real test. A brand-new coin
 * whose only holder is its pool has no one to simulate from; then the mint's extensions decide and the note says so.
 */
import type { Rpc } from "../rpc.js";
import { jupQuote, jupSwapTx, WSOL } from "../trade/jupiter.js";
import { nonFunderLabel, SYSTEM_PROGRAM } from "../data/clusterExclude.js";
import { honeypotVerdict, mintRisks, type HoneypotVerdict, type MintRisks, type SellSim } from "./honeypot.js";
import type { HoneypotSettings } from "./settings.js";

export interface CanSellResult extends HoneypotVerdict { risks?: MintRisks; sell?: SellSim; ms: number }
type Largest = { value: Array<{ address: string; amount: string; uiAmount: number | null }> };
type Parsed = { value: Array<{ owner?: string; data?: { parsed?: { info?: { owner?: string; tokenAmount?: { amount?: string } } } } } | null> };

export async function checkCanSell(rpc: Rpc, mint: string, c: HoneypotSettings, o: { exclude?: string[]; quote?: typeof jupQuote; swap?: typeof jupSwapTx } = {}): Promise<CanSellResult> {
  const t0 = Date.now();
  const acc = await rpc.call<unknown>("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }]).catch(() => null);
  const risks = mintRisks(acc);
  if (!risks) return { ok: false, reason: "can't check: the address isn't a token mint (or your RPC didn't answer)", notes: [], ms: Date.now() - t0 };
  const first = honeypotVerdict(c, risks);
  if (!first.ok || !c.simulate) return { ...first, risks, ms: Date.now() - t0 };

  const sell: SellSim = { route: false, simulated: false };
  try {
    const largest = await rpc.call<Largest>("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]);
    const accts = (largest?.value ?? []).filter((a) => a.amount !== "0").slice(0, 8);
    const parsed = accts.length ? await rpc.call<Parsed>("getMultipleAccounts", [accts.map((a) => a.address), { encoding: "jsonParsed" }]) : { value: [] };
    const cands = accts.map((a, i) => ({ owner: parsed.value[i]?.data?.parsed?.info?.owner ?? "", amount: BigInt(parsed.value[i]?.data?.parsed?.info?.tokenAmount?.amount ?? a.amount ?? "0") }))
      .filter((x) => x.owner && x.amount > 0n && !nonFunderLabel(x.owner, { exclude: o.exclude }));
    // a person's wallet is owned by the System Program (or has no account data at all); pools and vaults aren't
    const owners = cands.length ? await rpc.call<{ value: Array<{ owner?: string } | null> }>("getMultipleAccounts", [cands.map((x) => x.owner), { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]) : { value: [] };
    const holder = cands.find((_, i) => { const w = owners.value[i]; return !w || w.owner === SYSTEM_PROGRAM; });
    // the route back to SOL (for a holder's 10%, or a nominal amount when there's no holder yet)
    const amount = holder ? (holder.amount / 10n > 0n ? holder.amount / 10n : holder.amount) : 1_000_000n;
    const quote = await (o.quote ?? jupQuote)({ inputMint: mint, outputMint: WSOL, amount, slippageBps: 5000 }).catch(() => null);
    sell.route = !!quote && BigInt(String(quote.outAmount ?? "0")) > 0n;
    if (quote && sell.route && holder) {
      sell.holder = holder.owner;
      const tx = await (o.swap ?? jupSwapTx)({ quote, userPublicKey: holder.owner });
      const sim = await rpc.call<{ value: { err: unknown; logs?: string[] | null } }>("simulateTransaction", [tx, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "processed" }]);
      sell.simulated = true;
      sell.ok = sim.value.err === null || sim.value.err === undefined;
      if (!sell.ok) sell.error = simError(sim.value.err, sim.value.logs ?? []);
    }
  } catch (e) {
    // the RPC or Jupiter failed: not proof either way; the mint's extensions already passed
    if (!sell.route) return { ok: false, reason: `can't check a sell route: ${(e as Error).message.slice(0, 80)}`, notes: [], risks, sell, ms: Date.now() - t0 };
  }
  return { ...honeypotVerdict(c, risks, sell), risks, sell, ms: Date.now() - t0 };
}

/** A short reason from a simulation error and its logs. */
export function simError(err: unknown, logs: string[]): string {
  const line = [...logs].reverse().find((l) => /error|failed|frozen|insufficient|not allowed/i.test(l));
  if (line) return line.replace(/^Program log:\s*/, "").replace(/^Program \w+ /, "").slice(0, 90);
  return typeof err === "string" ? err.slice(0, 60) : JSON.stringify(err).slice(0, 60);
}
