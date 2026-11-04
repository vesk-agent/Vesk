/** v14: position origin, exit targets and progress, closed positions from fills, the realized summary, allocations. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { closedFromFills, dailyRealized, utcDay, exitProgress, originOf, parseExitTargets, realizedSummary, seriesChange, slices } from "../src/portfolio/stats.js";

test("origin: explicit, copied wallet, or from the rule text", () => {
  assert.deepEqual(originOf({ copiedFrom: { wallet: "W", label: "Night desk" } }), { kind: "copy", label: "Night desk", wallet: "W" });
  assert.equal(originOf({ rule: "@junopark" }).kind, "snipe");
  assert.equal(originOf({ rule: "Manual" }).kind, "manual");
  assert.equal(originOf({}).kind, "manual");
  assert.equal(originOf({ rule: "Pulse" }).kind, "pulse");
  assert.equal(originOf({ origin: { kind: "launch-on-post", label: "@maraokafor" }, rule: "x" }).kind, "launch-on-post");
});

test("exit targets and progress to the next one", () => {
  const t = parseExitTargets("TP 2x:50,5x:100 · SL −30% · trail 20%");
  assert.deepEqual(t.map((x) => [x.kind, x.at, x.pct ?? null]), [["sl", 0.7, null], ["trail", 0.8, null], ["tp", 2, 50], ["tp", 5, 100]]);
  assert.deepEqual(parseExitTargets("TP 3x · SL −35%").map((x) => x.label), ["SL −35%", "TP 3x"]);
  assert.deepEqual(parseExitTargets("Limit sell 0.0000012"), []);
  const up = exitProgress(1.5, t);
  assert.equal(up.toward, "tp"); assert.equal(up.next?.at, 2); assert.equal(up.pct, 50);
  const past = exitProgress(2.5, t);
  assert.equal(past.next?.at, 5); assert.equal(Math.round(past.pct), 38);
  const down = exitProgress(0.9, t);
  assert.equal(down.toward, "sl"); assert.equal(down.stop?.at, 0.8); assert.equal(Math.round(down.pct), 50);
  assert.equal(exitProgress(1.2, []).toward, "none");
});

test("closed positions from fills: only coins you no longer hold, SOL in vs out, MC at entry and exit", () => {
  const H = 3_600_000, t0 = Date.UTC(2026, 9, 20, 12);
  const fills = [
    { at: t0, mint: "A", side: "buy" as const, sol: 0.5, mcapUsd: 40_000, symbol: "AAA" },
    { at: t0 + H, mint: "A", side: "sell" as const, sol: 0.4, mcapUsd: 90_000 },
    { at: t0 + 2 * H, mint: "A", side: "sell" as const, sol: 0.5, mcapUsd: 120_000 },
    { at: t0, mint: "B", side: "buy" as const, sol: 0.2, symbol: "BBB" },
    { at: t0 + H, mint: "B", side: "sell" as const, sol: 0.12 },
    { at: t0, mint: "C", side: "buy" as const, sol: 1 },
    { at: t0, mint: "D", side: "buy" as const, sol: 1 }, { at: t0 + H, mint: "D", side: "sell" as const, sol: 1.2 },
  ];
  const c = closedFromFills(fills, ["D"]);
  assert.deepEqual(c.map((x) => x.mint), ["A", "B"]);
  const a = c[0];
  assert.equal(a.pnlSol, 0.4); assert.equal(a.pnlPct, 80); assert.equal(a.entryMcapUsd, 40_000); assert.equal(a.exitMcapUsd, 120_000); assert.equal(a.closedAt - a.openedAt, 2 * H);
  assert.equal(c[1].pnlSol, -0.08);
});

test("realized summary: today / 7d / all, win rate, best / worst, daily bars", () => {
  const now = Date.UTC(2026, 9, 24, 15), D = 86_400_000;
  const mk = (pnl: number, ago: number) => ({ mint: String(ago), symbol: "X", investedSol: 1, returnedSol: 1 + pnl, pnlSol: pnl, pnlPct: pnl * 100, openedAt: now - ago - 1000, closedAt: now - ago, origin: { kind: "manual" as const, label: "Manual" } });
  const s = realizedSummary([mk(0.3, 1000), mk(-0.1, 2 * D), mk(0.5, 10 * D), mk(-0.2, 3 * D)], now, 7);
  assert.equal(s.todaySol, 0.3); assert.equal(s.d7Sol, 0); assert.equal(s.allSol, 0.5);
  assert.equal(s.wins, 2); assert.equal(s.losses, 2); assert.equal(s.winRate, 50);
  assert.equal(s.best?.pnlSol, 0.5); assert.equal(s.worst?.pnlSol, -0.2);
  assert.equal(s.daily.length, 7); assert.equal(s.daily[6].day, utcDay(now)); assert.equal(s.daily[6].sol, 0.3); assert.equal(s.daily[4].sol, -0.1);
  assert.equal(realizedSummary([], now).winRate, null);
  assert.equal(dailyRealized([], now, 3).length, 3);
});

test("allocation slices add to 100 % and fold the tail; series change", () => {
  const s = slices([{ key: "a", label: "A", value: 5 }, { key: "b", label: "B", value: 3 }, { key: "a", label: "A", value: 1 }, { key: "c", label: "C", value: 0.5 }, { key: "d", label: "D", value: 0.5 }, { key: "z", label: "Z", value: 0 }], 2);
  assert.deepEqual(s.map((x) => [x.key, x.value]), [["a", 6], ["b", 3], ["other", 1]]);
  assert.equal(Math.round(s.reduce((t, x) => t + x.pct, 0)), 100);
  assert.deepEqual(seriesChange([{ t: 0, v: 2 }, { t: 1, v: 2.5 }]), { abs: 0.5, pct: 25 });
  assert.deepEqual(seriesChange([{ t: 0, v: 2 }]), { abs: 0, pct: null });
});
