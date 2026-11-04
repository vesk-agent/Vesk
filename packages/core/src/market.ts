/**
 * Market data: price, market cap and liquidity for a mint.
 *  - On the pump.fun bonding curve: read the curve account from your RPC (fast, no third party).
 *  - Graduated / other pools: DexScreener's public token endpoint.
 *  - SOL/USD: Jupiter price API.
 */
import { PublicKey } from "@solana/web3.js";
import type { Rpc } from "./rpc.js";
import type { MarketSnapshot } from "./types.js";
import { endpoints } from "./endpoints.js";

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_DECIMALS = 6;
export const PUMP_SUPPLY = 1_000_000_000;
const WSOL = "So11111111111111111111111111111111111111112";

export type Curve = { virtualToken: bigint; virtualSol: bigint; realToken: bigint; realSol: bigint; supply: bigint; complete: boolean };

/** pump.fun bonding-curve account: 8-byte discriminator, five u64 LE fields, then a bool. */
export function parseCurve(data: Uint8Array): Curve {
  if (data.length < 49) throw new Error("bonding curve account too short");
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u64 = (o: number) => v.getBigUint64(o, true);
  return { virtualToken: u64(8), virtualSol: u64(16), realToken: u64(24), realSol: u64(32), supply: u64(40), complete: data[48] === 1 };
}

/** Spot price in SOL per whole token from virtual reserves. */
export function curvePriceSol(c: Curve): number {
  if (c.virtualToken === 0n) return 0;
  return Number(c.virtualSol) / 1e9 / (Number(c.virtualToken) / 10 ** PUMP_DECIMALS);
}

export function bondingCurveAddress(mint: string): string {
  return PublicKey.findProgramAddressSync([new TextEncoder().encode("bonding-curve"), new PublicKey(mint).toBytes()], new PublicKey(PUMP_PROGRAM))[0].toBase58();
}

let solUsdCache: { v: number; at: number } | null = null;
export async function solUsd(): Promise<number> {
  if (solUsdCache && Date.now() - solUsdCache.at < 30_000) return solUsdCache.v;
  const r = await fetch(`${endpoints.jupPrice()}?ids=${WSOL}`);
  if (!r.ok) throw new Error(`price API ${r.status}`);
  const j = (await r.json()) as Record<string, { usdPrice?: number }>;
  const v = Number(j[WSOL]?.usdPrice);
  if (!v) throw new Error("no SOL price");
  solUsdCache = { v, at: Date.now() };
  return v;
}

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export async function curveSnapshot(rpc: Rpc, mint: string): Promise<MarketSnapshot | null> {
  const info = await rpc.getAccountInfo(bondingCurveAddress(mint), "base64");
  if (!info || !Array.isArray(info.data)) return null;
  const c = parseCurve(b64ToBytes(info.data[0]));
  if (c.complete) return null; // graduated: use DEX data
  const priceSol = curvePriceSol(c);
  const usd = await solUsd();
  return { mint, priceSol, priceUsd: priceSol * usd, mcapUsd: priceSol * usd * PUMP_SUPPLY, liquiditySol: Number(c.realSol) / 1e9, onCurve: true, at: Date.now() };
}

export async function dexSnapshot(mint: string): Promise<MarketSnapshot | null> {
  const r = await fetch(`${endpoints.dexScreener()}/tokens/v1/solana/${mint}`);
  if (!r.ok) return null;
  const pairs = (await r.json()) as Array<{ priceNative?: string; priceUsd?: string; marketCap?: number; fdv?: number; liquidity?: { quote?: number; usd?: number }; quoteToken?: { address: string } }>;
  const p = pairs.filter((x) => x.quoteToken?.address === WSOL).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  if (!p) return null;
  return {
    mint, priceSol: Number(p.priceNative ?? 0), priceUsd: Number(p.priceUsd ?? 0), mcapUsd: Number(p.marketCap ?? p.fdv ?? 0),
    liquiditySol: Number(p.liquidity?.quote ?? 0), onCurve: false, at: Date.now(),
  };
}

/** Best available snapshot: the bonding curve first (freshest for new coins), then DEX pools. */
export async function snapshot(rpc: Rpc, mint: string): Promise<MarketSnapshot | null> {
  try {
    const c = await curveSnapshot(rpc, mint);
    if (c) return c;
  } catch {
    /* not a pump.fun coin, or RPC hiccup: fall through */
  }
  return dexSnapshot(mint);
}
