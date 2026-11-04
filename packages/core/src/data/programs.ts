import { BRAND } from "../brand.js";
/**
 * Solana program IDs Vesk watches for new pools (logsSubscribe on your RPC, watch/poolWatch.ts).
 *
 * Only IDs we're confident of are listed, each with where it comes from. Log instruction names are the program's
 * own Anchor log lines ("Program log: Instruction: <Name>"); Raydium AMM v4 is not Anchor and logs "initialize2".
 * The names are taken from the programs' published IDLs / source as we know them; verify against live logs on
 * your RPC before relying on a protocol (see docs/26-data-sources.md). Anything we're not sure of is a TODO below,
 * not a guess.
 */
export interface PoolProgram {
  /** Program ID (base58). */
  id: string;
  /** Pulse protocol id it maps to (watch/pulse.ts PULSE_PROTOCOLS). */
  protocol: "meteora-dbc" | "raydium-launchlab" | "raydium" | "orca" | "meteora-amm" | "meteora-amm-v2" | "pumpswap" | "moonshot" | "pumpfun";
  name: string;
  /** Log lines that mean "a new pool / curve was created". Matched as substrings of a "Program log:" line. */
  create: string[];
  /** Where the ID comes from. */
  source: string;
}

export const POOL_PROGRAMS: PoolProgram[] = [
  { id: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", protocol: "pumpfun", name: "pump.fun bonding curve", create: ["Instruction: Create"], source: `pump.fun program, also used by PumpPortal; used by ${BRAND.name}'s launch code (launch/pumpfun.ts)` },
  { id: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", protocol: "pumpswap", name: "PumpSwap (Pump AMM)", create: ["Instruction: CreatePool"], source: "pump.fun's AMM that migrated coins move to (PumpPortal pool \"pump-amm\")" },
  { id: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", protocol: "meteora-dbc", name: "Meteora Dynamic Bonding Curve", create: ["Instruction: InitializeVirtualPoolWithSplToken", "Instruction: InitializeVirtualPoolWithToken2022"], source: "Meteora docs (DBC program); launchpads built on it (Believe, Bags, Jupiter Studio and others) aren't told apart here" },
  { id: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj", protocol: "raydium-launchlab", name: "Raydium LaunchLab", create: ["Instruction: Initialize", "Instruction: InitializeV2"], source: "Raydium docs (LaunchLab program); LetsBonk launches use it" },
  { id: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", protocol: "raydium", name: "Raydium AMM v4", create: ["initialize2"], source: "Raydium docs (Liquidity Pool v4)" },
  { id: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", protocol: "raydium", name: "Raydium CPMM", create: ["Instruction: Initialize"], source: "Raydium docs (CPMM program)" },
  { id: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", protocol: "orca", name: "Orca Whirlpools", create: ["Instruction: InitializePool", "Instruction: InitializePoolV2"], source: "Orca docs (Whirlpools program)" },
  { id: "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB", protocol: "meteora-amm", name: "Meteora Dynamic AMM (DAMM v1)", create: ["Instruction: InitializePermissionlessConstantProductPoolWithConfig", "Instruction: InitializePermissionlessPool"], source: "Meteora docs (Dynamic AMM program)" },
  { id: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", protocol: "meteora-amm-v2", name: "Meteora DAMM v2", create: ["Instruction: InitializePool", "Instruction: InitializeCustomizablePool", "Instruction: InitializePoolWithDynamicConfig"], source: "Meteora docs (DAMM v2 program)" },
];

/**
 * TODO (not watched until someone confirms the program ID and its create log line):
 * Moonshot, Boop, Bonkers, Printr, Stonk.fun, Liquid, LiquidAF, Surge, Soar, Haven, Wordless, daos.fun, Candle,
 * Sugar, Moonit, PancakeSwap (Solana), Wavebreak, LiquidAF MM, RiseRich, MetaDAO, pve.win, Mayhem.
 */
export const POOL_PROGRAM_TODO = ["moonshot", "boop", "bonkers", "printr", "stonkfun", "liquid", "liquidaf", "surge", "soar", "haven", "wordless", "daosfun", "candle", "sugar", "moonit", "pancakeswap", "wavebreak", "liquidaf-mm", "riserich", "metadao", "pvewin", "mayhem"];

/** Quote mints that are never "the new coin" in a pool. */
export const QUOTE_MINTS: Record<string, string> = {
  So11111111111111111111111111111111111111112: "SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB: "USD1",
};
