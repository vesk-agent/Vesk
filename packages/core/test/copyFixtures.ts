/**
 * Transaction fixtures for copy-trade classification, in the shape `getTransaction` returns with
 * encoding "jsonParsed" and maxSupportedTransactionVersion 0 (accountKeys objects, pre/post balances,
 * pre/post token balances with owner + uiTokenAmount, inner instructions with programId, log lines).
 *
 * HAND-BUILT, not recorded from mainnet: the build machine has no mainnet RPC access. Program IDs are the real
 * ones (data/programs.ts, Jupiter v6); addresses, amounts and signatures are made up. Before relying on the
 * classifier for a venue, record a real transaction from your RPC and add it here (see docs/27-copy-trading.md).
 */
import type { ParsedTx } from "../src/copy/classify.js";

export const TARGET = "9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT";
export const COIN = "Hq4Ae2xXbTZ7nRkd9WcYp3mVfL8sJ6uG1oEt5BvNpump";
export const COIN2 = "A8bYk2mN3pQrStUv4WxYz5aBcDeFgHiJkLmNoPq6pump";
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMPSWAP = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const CPMM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const DLMM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const CB = "ComputeBudget111111111111111111111111111111";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYS = "11111111111111111111111111111111";
const CURVE = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const POOL = "Cm6fNnMk7NfzStP9CZpsQA2v3jjzbcYGAxdJySmHpump";

const tb = (accountIndex: number, mint: string, owner: string, ui: number, decimals = 6) => ({
  accountIndex, mint, owner, programId: TOKEN, uiTokenAmount: { amount: String(Math.round(ui * 10 ** decimals)), decimals, uiAmount: ui, uiAmountString: String(ui) },
});
const keys = (list: string[], signers = 1) => list.map((pubkey, i) => ({ pubkey, signer: i < signers, writable: true, source: "transaction" }));

function tx(o: { sig: string; slot?: number; blockTime?: number; fee?: number; keys: string[]; pre: number[]; post: number[]; preTok: ReturnType<typeof tb>[]; postTok: ReturnType<typeof tb>[]; outer: string[]; inner?: Array<{ index: number; programs: string[] }>; err?: unknown }): ParsedTx {
  return {
    slot: o.slot ?? 312_000_000, blockTime: o.blockTime ?? 1_760_000_000,
    meta: {
      err: o.err ?? null, fee: o.fee ?? 5000, preBalances: o.pre, postBalances: o.post, preTokenBalances: o.preTok, postTokenBalances: o.postTok,
      innerInstructions: (o.inner ?? []).map((g) => ({ index: g.index, instructions: g.programs.map((programId) => ({ programId })) })),
      logMessages: o.outer.map((p) => `Program ${p} invoke [1]`),
    },
    transaction: { signatures: [o.sig], message: { accountKeys: keys(o.keys), instructions: o.outer.map((programId) => ({ programId })) } },
  };
}

/** pump.fun curve buy: 0.5 SOL in (plus fee and a new token account), 17.5M tokens out. */
export const PUMP_BUY = tx({
  sig: "pumpBuy111", keys: [TARGET, CURVE, PUMP, ATA, CB, SYS],
  pre: [2_000_000_000, 30_000_000_000, 1, 1, 1, 1], post: [2_000_000_000 - 500_000_000 - 5000 - 2_039_280, 30_495_000_000, 1, 1, 1, 1],
  preTok: [tb(1, COIN, CURVE, 800_000_000)], postTok: [tb(1, COIN, CURVE, 782_500_000), tb(6, COIN, TARGET, 17_500_000)],
  outer: [CB, ATA, PUMP],
});

/** pump.fun curve sell of half the bag: 8.75M of 17.5M tokens → 0.31 SOL. */
export const PUMP_SELL = tx({
  sig: "pumpSell222", keys: [TARGET, CURVE, PUMP, CB],
  pre: [1_500_000_000, 30_495_000_000, 1, 1], post: [1_500_000_000 + 310_000_000 - 5000, 30_185_000_000, 1, 1],
  preTok: [tb(1, COIN, CURVE, 782_500_000), tb(4, COIN, TARGET, 17_500_000)], postTok: [tb(1, COIN, CURVE, 791_250_000), tb(4, COIN, TARGET, 8_750_000)],
  outer: [CB, PUMP],
});

/** PumpSwap buy paid from a wrapped-SOL account that stays open: 0.2 WSOL spent. */
export const PUMPSWAP_BUY = tx({
  sig: "pumpswapBuy333", keys: [TARGET, POOL, PUMPSWAP, CB],
  pre: [900_000_000, 1, 1, 1], post: [900_000_000 - 5000, 1, 1, 1],
  preTok: [tb(5, WSOL, TARGET, 1.0, 9), tb(6, COIN2, TARGET, 1000)], postTok: [tb(5, WSOL, TARGET, 0.8, 9), tb(6, COIN2, TARGET, 251_000)],
  outer: [CB, PUMPSWAP],
});

/** Jupiter route: 1.2 SOL → coin through Raydium CPMM and Meteora DLMM (temporary WSOL account opened and closed inside; the coin account is new). */
export const JUPITER_BUY = tx({
  sig: "jupRoute444", keys: [TARGET, JUP, CPMM, DLMM, CB],
  pre: [5_000_000_000, 1, 1, 1, 1], post: [5_000_000_000 - 1_200_000_000 - 5000 - 2_039_280, 1, 1, 1, 1],
  preTok: [], postTok: [tb(7, COIN, TARGET, 3_000_000)],
  outer: [CB, JUP], inner: [{ index: 1, programs: [TOKEN, CPMM, TOKEN, DLMM, TOKEN] }],
});

/** USDC → coin through Jupiter: no SOL moved, not copied. */
export const USDC_SWAP = tx({
  sig: "usdcSwap555", keys: [TARGET, JUP, CB],
  pre: [100_000_000, 1, 1], post: [100_000_000 - 5000, 1, 1],
  preTok: [tb(3, USDC, TARGET, 500), tb(4, COIN, TARGET, 0)], postTok: [tb(3, USDC, TARGET, 400), tb(4, COIN, TARGET, 1_000_000)],
  outer: [CB, JUP],
});

/** A failed buy (slippage): never copied. */
export const FAILED_BUY = tx({ ...{ sig: "failed666", keys: [TARGET, PUMP], pre: [1e9, 1], post: [1e9 - 5000, 1], preTok: [], postTok: [], outer: [PUMP] }, err: { InstructionError: [0, { Custom: 6002 }] } });

/** Sell everything and close the token account (its rent comes back with the proceeds). */
export const PUMP_SELL_ALL_CLOSE = tx({
  sig: "sellAll777", keys: [TARGET, CURVE, PUMP],
  pre: [1_000_000_000, 30e9, 1], post: [1_000_000_000 + 400_000_000 + 2_039_280 - 5000, 29.6e9, 1],
  preTok: [tb(1, COIN, CURVE, 791_250_000), tb(4, COIN, TARGET, 8_750_000)], postTok: [tb(1, COIN, CURVE, 800_000_000)],
  outer: [PUMP],
});
