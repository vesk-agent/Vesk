/**
 * v26: per-rule stats for launch-on-post: launches, how often it was first to launch for the post (race reports),
 * the median time from post to landed, PnL on the dev position, and creator fees earned per asset. Pure; the caller
 * passes PnL and fees per mint from its own state (agent) or tables (hosted).
 */
import type { LaunchRecord } from "./onpost.js";

export interface RuleStats { ruleId: string; launches: number; raced: number; firsts: number; firstRate: number | null; medianMs: number | null; pnlSol: number; fees: Array<{ asset: string; amount: number }>; lastAt?: number }

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Post → landed, from a record: the race report's gap, else the last timing mark. */
export const landedMs = (h: LaunchRecord) => h.race?.msAfterPost ?? (h.postAt && h.landedAt ? h.landedAt - h.postAt : h.timings?.find((t) => t.mark === "landed")?.ms);

export function ruleStats(ruleId: string, history: LaunchRecord[], o: { pnlByMint?: Record<string, number>; feesByMint?: Record<string, Array<{ asset: string; amount: number }>> } = {}): RuleStats {
  const mine = history.filter((h) => h.ruleId === ruleId && h.status === "launched" && h.mint);
  const raced = mine.filter((h) => h.race);
  const firsts = raced.filter((h) => h.race!.rank === 1).length;
  const ms = mine.map(landedMs).filter((x): x is number => typeof x === "number" && x >= 0);
  const fees = new Map<string, number>();
  for (const h of mine) for (const f of o.feesByMint?.[h.mint!] ?? []) fees.set(f.asset, (fees.get(f.asset) ?? 0) + f.amount);
  return {
    ruleId, launches: mine.length, raced: raced.length, firsts, firstRate: raced.length ? firsts / raced.length : null, medianMs: median(ms),
    pnlSol: +mine.reduce((a, h) => a + (o.pnlByMint?.[h.mint!] ?? 0), 0).toFixed(6), fees: [...fees].map(([asset, amount]) => ({ asset, amount })),
    lastAt: mine.length ? Math.max(...mine.map((h) => h.at)) : undefined,
  };
}
