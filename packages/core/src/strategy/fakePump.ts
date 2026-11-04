/**
 * The "fake pump" checks (v20), part of the rug check. Pure.
 *
 *   early concentration   one wallet, or one cluster of linked wallets, buys more than X% of the supply in the first
 *                         N seconds after the coin is created
 *   spike then dump       a big early buyer pushes the price up, buyers pile in, then it sells into them
 *
 * Both read the trades the agent saw on the data stream since the coin's creation (PumpPortal: tokens and SOL per
 * trade, the trader's wallet). Clusters come from funding links when your RPC read them (watch/enrich.ts); without
 * them each wallet stands alone, so a cluster split across fresh wallets can slip under the line (said in the docs).
 */
import type { RugSettings } from "./settings.js";

/** One trade with its token amount (the stream sends both). */
export interface SizedTick { at: number; side: "buy" | "sell"; sol: number; tokens: number; wallet: string }

export interface Concentration { pct: number; who: string; wallets: number; sec: number }

const r1 = (n: number) => Math.round(n * 10) / 10;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/**
 * The largest net share of the supply bought by one wallet or one cluster in the first `windowSec` seconds.
 * `clusterOf(wallet)` names a wallet's cluster (its funder) when known.
 */
export function earlyConcentration(createdAt: number, ticks: SizedTick[], supply: number, windowSec: number, clusterOf?: (wallet: string) => string | undefined): Concentration | null {
  if (!(supply > 0)) return null;
  const end = createdAt + windowSec * 1000;
  const net = new Map<string, { tokens: number; wallets: Set<string>; last: number }>();
  for (const t of ticks) {
    if (t.at < createdAt || t.at > end || !(t.tokens > 0)) continue;
    const key = clusterOf?.(t.wallet) ?? t.wallet;
    const g = net.get(key) ?? { tokens: 0, wallets: new Set<string>(), last: t.at };
    g.tokens += t.side === "buy" ? t.tokens : -t.tokens;
    g.wallets.add(t.wallet);
    g.last = Math.max(g.last, t.at);
    net.set(key, g);
  }
  let best: Concentration | null = null;
  for (const [key, g] of net) {
    const pct = (g.tokens / supply) * 100;
    if (!best || pct > best.pct) best = { pct: r1(pct), who: g.wallets.size > 1 ? `a cluster of ${g.wallets.size} wallets (${short(key)})` : `one wallet (${short([...g.wallets][0])})`, wallets: g.wallets.size, sec: r1((g.last - createdAt) / 1000) };
  }
  return best && best.pct > 0 ? best : null;
}

export interface SpikeDump { hit: boolean; spikePct: number; dumpPct: number; boughtPct: number; wallet?: string; reason?: string }

/**
 * Spike then dump: among wallets that bought at least `minBuyPct` of the supply inside the window, did one sell at
 * least `minDumpPct` of what it bought after the price had risen at least `minSpikePct` from its first buy?
 * Prices are per trade (SOL / tokens).
 */
export function spikeDump(c: RugSettings["spikeDump"], createdAt: number, ticks: SizedTick[], supply: number, minBuyPct = 5): SpikeDump {
  const none: SpikeDump = { hit: false, spikePct: 0, dumpPct: 0, boughtPct: 0 };
  if (!(supply > 0)) return none;
  const end = createdAt + c.windowSec * 1000;
  const inWin = ticks.filter((t) => t.at >= createdAt && t.at <= end && t.tokens > 0 && t.sol > 0).sort((a, b) => a.at - b.at);
  const by = new Map<string, { bought: number; sold: number; firstPrice: number; firstAt: number }>();
  let worst = none;
  let peak = 0;
  for (const t of inWin) {
    const price = t.sol / t.tokens;
    const w = by.get(t.wallet) ?? { bought: 0, sold: 0, firstPrice: 0, firstAt: t.at };
    if (t.side === "buy") { if (!w.bought) { w.firstPrice = price; w.firstAt = t.at; } w.bought += t.tokens; }
    else if (w.bought > 0) {
      w.sold += t.tokens;
      const boughtPct = (w.bought / supply) * 100;
      const spikePct = w.firstPrice > 0 ? ((Math.max(peak, price) - w.firstPrice) / w.firstPrice) * 100 : 0;
      const dumpPct = Math.min(100, (w.sold / w.bought) * 100);
      if (boughtPct >= minBuyPct && spikePct >= c.minSpikePct && dumpPct >= c.minDumpPct) {
        const sec = r1((t.at - w.firstAt) / 1000);
        const cand: SpikeDump = { hit: true, spikePct: r1(spikePct), dumpPct: r1(dumpPct), boughtPct: r1(boughtPct), wallet: t.wallet, reason: `fake pump: ${short(t.wallet)} bought ${r1(boughtPct)}% of supply, price +${Math.round(spikePct)}%, then sold ${Math.round(dumpPct)}% of it in ${sec} s` };
        if (!worst.hit || cand.dumpPct * cand.boughtPct > worst.dumpPct * worst.boughtPct) worst = cand;
      }
    }
    by.set(t.wallet, w);
    peak = Math.max(peak, price);
  }
  return worst;
}

/** Both checks as rug-check facts (rug.ts reads them). */
export function fakePumpFacts(c: Pick<RugSettings, "earlyConcentration" | "spikeDump">, createdAt: number, ticks: SizedTick[], supply: number, clusterOf?: (wallet: string) => string | undefined): { concentration: Concentration | null; spikeDump: SpikeDump } {
  return { concentration: earlyConcentration(createdAt, ticks, supply, c.earlyConcentration.windowSec, clusterOf), spikeDump: spikeDump(c.spikeDump, createdAt, ticks, supply) };
}
