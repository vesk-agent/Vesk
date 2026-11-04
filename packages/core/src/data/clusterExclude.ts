/**
 * Addresses that are never a "funder" and never a link between wallets (v19, pool-aware clustering).
 *
 * The bundle, insider and funding heuristics (watch/audits.ts, coin/traders.ts) link two wallets when the same
 * address sent each of them its first SOL. That is right for a person's wallet and wrong for infrastructure: an AMM
 * pool or a bonding curve pays out to every seller, an exchange hot wallet funds thousands of strangers, a program
 * account isn't anyone. Linking through them would make unrelated buyers look like one bundle. So:
 *
 *  1. The addresses below are dropped as funders and as links. Only IDs we're confident of are listed, each with where
 *     it comes from. Anything we're not sure of is in CLUSTER_EXCLUDE_TODO, not guessed.
 *  2. Exchange hot wallets come from data/exchanges.ts (labelled from public explorer tags, see that file).
 *  3. Per coin, the coin's own curve and pool accounts are dropped too (watch/enrich.ts passes the bonding-curve PDA and
 *     any pool accounts it knows).
 *  4. Any funder whose account is owned by a program other than the System Program (a pool, a vault, a PDA) is dropped:
 *     enrichment reads the funders' owners with one getMultipleAccounts call. A person's wallet is System-owned.
 */
import { EXCHANGE_WALLETS } from "./exchanges.js";
import { POOL_PROGRAMS, QUOTE_MINTS } from "./programs.js";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/** address → what it is. Programs and fixed accounts we're confident of. */
export const NON_FUNDERS: Record<string, string> = {
  [SYSTEM_PROGRAM]: "System Program",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token program",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022 program",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token Account program",
  ComputeBudget111111111111111111111111111111: "Compute Budget program",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter aggregator v6",
  // Raydium's AMM v4 authority: the PDA that signs every v4 pool's vault transfers (Raydium docs / SDK constant).
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1": "Raydium AMM v4 authority",
  // the pool / curve programs Vesk already watches (data/programs.ts: each listed with its source)
  ...Object.fromEntries(POOL_PROGRAMS.map((p) => [p.id, `${p.name} program`])),
  // quote mints are tokens, not wallets
  ...Object.fromEntries(Object.entries(QUOTE_MINTS).map(([a, s]) => [a, `${s} mint`])),
};

/**
 * TODO (not excluded until someone confirms the address from the protocol's own docs or source):
 *  - pump.fun fee recipients and the pump.fun migration account
 *  - Raydium CPMM / LaunchLab authorities, Meteora vault authorities, Orca whirlpool vaults (these are program-owned,
 *    so rule 4 already drops them when enrichment can read their owner)
 *  - more exchange hot wallets (add them to data/exchanges.ts with their explorer label)
 */
export const CLUSTER_EXCLUDE_TODO = ["pumpfun-fee-recipients", "pumpfun-migration", "raydium-cpmm-authority", "launchlab-authority", "meteora-vault-authority", "more-cex-hot-wallets"];

/** Why an address is never a link, or undefined when it can be one. */
export function nonFunderLabel(address: string, ctx: { exclude?: ReadonlySet<string> | readonly string[]; programOwned?: ReadonlySet<string> } = {}): string | undefined {
  if (NON_FUNDERS[address]) return NON_FUNDERS[address];
  const ex = EXCHANGE_WALLETS[address];
  if (ex) return `${ex} hot wallet (labelled)`;
  const list = ctx.exclude;
  if (list && (Array.isArray(list) ? list.includes(address) : (list as ReadonlySet<string>).has(address))) return "this coin's curve or pool";
  if (ctx.programOwned?.has(address)) return "a program-owned account (pool, vault or PDA)";
  return undefined;
}
