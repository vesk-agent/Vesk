/**
 * Paper test (v17): replay recent events through a rule with the real matcher and buy decision, and report what it
 * would have done. Nothing is sent, nothing is signed. Counters advance as they would live (a buy counts toward the
 * day's limit, starts the cooldown and marks the coin as held), so the daily cap and cooldown show up in the result.
 * When the market cap at the time isn't known (posts from your feed), the market-cap check is reported as not
 * checked rather than guessed.
 */
import { decideBuy, matchLaunch, matchXPost, type SkipCode } from "./engine.js";
import type { LaunchEvent, MarketSnapshot, Rule, XPost } from "../types.js";

export interface PaperEvent { at: number; post?: XPost; launch?: LaunchEvent; market?: MarketSnapshot | null; label: string }
export interface PaperRow { at: number; label: string; would: "buy" | "skip"; reason: string; code?: SkipCode | "mcap-unchecked"; mint?: string; amountSol?: number }
export interface PaperResult { rows: PaperRow[]; buys: number; skips: number; spentSol: number; byReason: Array<{ reason: string; n: number }>; unchecked: number }

export function paperRun(rule: Rule, events: PaperEvent[], startBuysToday = 0): PaperResult {
  const r: Rule = { ...rule, enabled: true }; // a paper test runs even while the rule is off
  const held = new Set<string>();
  let buysToday = startBuysToday, lastFiredAt: number | undefined;
  const rows: PaperRow[] = [];
  let unchecked = 0;
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    const m = e.post ? matchXPost(r, e.post) : e.launch ? matchLaunch(r, e.launch) : { match: false as const, reason: "nothing to match" };
    // a post carries no market data: decide without the market-cap check, and say so
    const noMarket = e.market === undefined;
    const market: MarketSnapshot | null = noMarket && m.match ? { mint: m.mint, priceSol: 0, priceUsd: 0, mcapUsd: 0, liquiditySol: 0, onCurve: true, at: e.at } : e.market ?? null;
    const d = decideBuy(r, m, market, { buysToday, lastFiredAt, holding: held }, e.at);
    if (d.ok) {
      const flag = noMarket && r.buy.maxMcapUsd !== undefined;
      if (flag) unchecked++;
      rows.push({ at: e.at, label: e.label, would: "buy", reason: flag ? `${d.why} (market cap not checked: no price at the time)` : d.why, code: flag ? "mcap-unchecked" : undefined, mint: d.mint, amountSol: d.amountSol });
      buysToday++; lastFiredAt = e.at; held.add(d.mint);
    } else rows.push({ at: e.at, label: e.label, would: "skip", reason: d.reason, code: d.code });
  }
  const counts = new Map<string, number>();
  // group skip reasons: "@kiln is not on this rule" and "@ada is not on this rule" are one reason
  const GROUP: Array<[RegExp, string]> = [
    [/is not on this rule/, "the account isn't on this rule"], [/^dev holds/, "dev holds more than the maximum"], [/^liquidity/, "liquidity under the minimum"],
    [/^mcap \$/, "market cap above the maximum"], [/^top 10 hold/, "top 10 holders above the maximum"], [/addresses in one post/, "several addresses in one post"],
  ];
  const reasonKey = (x: PaperRow) => (x.code !== "no-match" ? x.reason : GROUP.find(([re]) => re.test(x.reason))?.[1] ?? x.reason);
  for (const x of rows) if (x.would === "skip") { const k = reasonKey(x); counts.set(k, (counts.get(k) ?? 0) + 1); }
  const buys = rows.filter((x) => x.would === "buy");
  return {
    rows: rows.reverse(), buys: buys.length, skips: rows.length - buys.length, unchecked,
    spentSol: Math.round(buys.reduce((s, x) => s + (x.amountSol ?? 0), 0) * 1e4) / 1e4,
    byReason: [...counts.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n),
  };
}

/** A Pulse coin as the launch event a new-launch rule sees (pump.fun mints have both authorities revoked). */
export function launchFromPulse(t: { mint: string; name: string; symbol: string; protocol: string; creator?: string; createdAt: number; liquiditySol: number; mcapSol: number; socials: { x?: string; telegram?: string; website?: string } }, devTokens: number, solUsd: number): LaunchEvent {
  const pump = t.protocol === "pumpfun";
  return {
    mint: t.mint, name: t.name, symbol: t.symbol, creator: t.creator ?? "", devTokens, totalSupply: 1_000_000_000,
    liquiditySol: t.liquiditySol, mcapUsd: t.mcapSol * solUsd, socials: { x: t.socials.x || undefined, telegram: t.socials.telegram || undefined, website: t.socials.website || undefined },
    mintAuthorityRevoked: pump ? true : undefined, freezeAuthorityRevoked: pump ? true : undefined, at: new Date(t.createdAt).toISOString(),
  };
}
