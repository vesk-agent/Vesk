/**
 * What a trade on a coin costs in fees, broken down: protocol fee + creator fee (+ LP fee on AMM pools) + any
 * Token-2022 transfer fee = total. Shown as "Tax %" on the coin page with a "?" that explains each part.
 *
 * The venue fees are the venues' published schedules when this was written. Venues change them (pump.fun has
 * changed its fees several times), so they live in this one table, the page says "published schedule", and a
 * Token-2022 transfer fee is always read from the mint itself (watch/facts.ts token2022TaxBps), never assumed.
 */
export type FeeVenue = "pumpfun-curve" | "pumpswap" | "raydium" | "meteora" | "other";

export interface VenueFee { label: string; protocolBps: number; creatorBps: number; lpBps: number; note: string }
export const VENUE_FEES: Record<FeeVenue, VenueFee> = {
  "pumpfun-curve": { label: "pump.fun bonding curve", protocolBps: 95, creatorBps: 30, lpBps: 0, note: "pump.fun's published curve fees (protocol 0.95%, creator 0.30%). pump.fun can change them." },
  pumpswap: { label: "PumpSwap pool", protocolBps: 5, creatorBps: 5, lpBps: 20, note: "PumpSwap's published pool fees (LP 0.20%, protocol 0.05%, creator 0.05%)." },
  raydium: { label: "Raydium pool", protocolBps: 0, creatorBps: 0, lpBps: 25, note: "A typical Raydium pool fee (0.25%); each pool sets its own." },
  meteora: { label: "Meteora pool", protocolBps: 0, creatorBps: 0, lpBps: 25, note: "Meteora pools set their own fee; 0.25% is a common one." },
  other: { label: "Unknown venue", protocolBps: 0, creatorBps: 0, lpBps: 0, note: "We don't know this venue's fees." },
};

export interface TaxBreakdown { venue: FeeVenue; protocolPct: number; creatorPct: number; lpPct: number; transferPct: number; totalPct: number; known: boolean; note: string }
export function taxBreakdown(venue: FeeVenue, transferTaxBps?: number): TaxBreakdown {
  const f = VENUE_FEES[venue] ?? VENUE_FEES.other;
  const transfer = Math.max(0, transferTaxBps ?? 0);
  const pct = (bps: number) => Math.round(bps) / 100;
  return {
    venue, protocolPct: pct(f.protocolBps), creatorPct: pct(f.creatorBps), lpPct: pct(f.lpBps), transferPct: pct(transfer),
    totalPct: pct(f.protocolBps + f.creatorBps + f.lpBps + transfer), known: venue !== "other", note: f.note,
  };
}
