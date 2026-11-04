/**
 * PumpPortal "local transaction" API: returns an unsigned transaction that we sign locally.
 * Your key never leaves your machine. Docs: https://pumpportal.fun/local-trading-api/trading-api
 * Handles pump.fun bonding-curve trades, PumpSwap after graduation (pool "auto"), coin creation and creator-fee claims.
 */
export const PUMPPORTAL_TRADE = "https://pumpportal.fun/api/trade-local";
/** VESK_PUMPPORTAL_URL overrides it (self-hosted proxy, or the end-to-end test's mock). */
export const pumpPortalUrl = () => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VESK_PUMPPORTAL_URL || PUMPPORTAL_TRADE;

export type PumpPool = "pump" | "pump-amm" | "raydium" | "launchlab" | "bonk" | "auto";

export interface PumpPortalRequest {
  publicKey: string;
  action: "buy" | "sell" | "create" | "collectCreatorFee";
  mint?: string;
  /** SOL (when denominatedInSol) or tokens; sells also accept a percentage string like "50%". */
  amount?: number | string;
  denominatedInSol?: "true" | "false";
  /** Percent, e.g. 15 = 15%. */
  slippage?: number;
  /** SOL. */
  priorityFee?: number;
  pool?: PumpPool;
  tokenMetadata?: { name: string; symbol: string; uri: string };
}

/** Returns the raw serialized VersionedTransaction bytes. */
export async function pumpPortalTx(req: PumpPortalRequest): Promise<Uint8Array> {
  const r = await fetch(pumpPortalUrl(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) });
  if (r.status !== 200) {
    const body = await r.text().catch(() => "");
    throw new Error(`PumpPortal ${req.action} failed (${r.status}) ${body.slice(0, 160)}`);
  }
  return new Uint8Array(await r.arrayBuffer());
}
