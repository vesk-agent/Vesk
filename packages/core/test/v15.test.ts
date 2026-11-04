import { test } from "node:test";
import assert from "node:assert/strict";
import { amountForPct, changeOf, compactUsd, feedSentence, heroParts, rangeMs, rangeStart, shortAgo, slideDone, topTrades } from "../src/ui/feel.js";
import { defaultPanelSettings, defaultToastLook, normalizePanelSettings } from "../src/ui/panelSettings.js";
import { normalizeInstantTrade } from "../src/ui/instantTrade.js";
import type { ClosedPosition } from "../src/portfolio/stats.js";

test("heroParts splits sign, grouped integer and decimals", () => {
  assert.deepEqual(heroParts(1234.5678, 3, { signed: true }), { sign: "+", int: "1,234", dec: ".568" });
  assert.deepEqual(heroParts(-0.2, 2), { sign: "−", int: "0", dec: ".20" });
  assert.deepEqual(heroParts(-0.0001, 2, { signed: true }), { sign: "", int: "0", dec: ".00" });
  assert.deepEqual(heroParts(38800, 0), { sign: "", int: "38,800", dec: "" });
  assert.equal(heroParts(NaN, 2).int, "–");
});

test("changeOf gives direction and arrow", () => {
  assert.deepEqual(changeOf(0.4), { dir: "up", arrow: "▲" });
  assert.deepEqual(changeOf(-1), { dir: "down", arrow: "▼" });
  assert.equal(changeOf(0).dir, "flat");
});

const now = Date.UTC(2026, 9, 24, 12);
const C = (symbol: string, pnl: number, daysAgo: number, origin: ClosedPosition["origin"]): ClosedPosition => ({ mint: `${symbol}mint`, symbol, investedSol: 0.2, returnedSol: 0.2 + pnl, pnlSol: pnl, pnlPct: (pnl / 0.2) * 100, openedAt: now - daysAgo * 86_400_000 - 3600_000, closedAt: now - daysAgo * 86_400_000, origin });
test("topTrades: your winners and each tracked wallet's best copy, this week, biggest first", () => {
  const rows = [
    C("A", 0.4, 1, { kind: "snipe", label: "Snipe" }),
    C("B", -0.1, 1, { kind: "manual", label: "Manual" }),
    C("C", 0.2, 2, { kind: "copy", label: "Night desk", wallet: "W1" }),
    C("D", 0.5, 3, { kind: "copy", label: "Night desk", wallet: "W1" }),
    C("E", 0.3, 4, { kind: "copy", label: "Early bird", wallet: "W2" }),
    C("F", 0.9, 9, { kind: "manual", label: "Manual" }),
  ];
  const t = topTrades(rows, now);
  assert.deepEqual(t.map((x) => [x.symbol, x.who, x.label]), [["D", "tracked", "Night desk"], ["A", "you", "You"], ["E", "tracked", "Early bird"]]);
  assert.equal(topTrades(rows, now, { n: 1 }).length, 1);
});

test("feedSentence and compact formats", () => {
  assert.equal(feedSentence({ label: "Night desk", side: "buy", symbol: "GLINT", mint: "x", sol: 0.4, mcapUsd: 36_000, at: now - 120_000 }, now), "Night desk bought $GLINT · 0.40 SOL at $36K MC · 2m");
  assert.equal(compactUsd(1_240_000), "$1.2M");
  assert.equal(compactUsd(9_400), "$9.4K");
  assert.equal(compactUsd(512), "$512");
  assert.equal(shortAgo(now - 5_000, now), "5s");
  assert.equal(shortAgo(now - 3 * 86_400_000, now), "3d");
});

test("amountForPct keeps a fee reserve on Max and rounds down", () => {
  assert.equal(amountForPct(4.812, 25), 1.203);
  assert.equal(amountForPct(4.812, 100, 0.01), 4.802);
  assert.equal(amountForPct(0.005, 100, 0.01), 0);
  assert.equal(amountForPct(0, 50), 0);
});

test("rangeStart and slideDone", () => {
  assert.equal(rangeStart("24h", now), now - 86_400_000);
  assert.equal(rangeStart("all", now), -Infinity);
  assert.equal(rangeStart("1h", now), now - 3_600_000);
  assert.equal(rangeMs("1w"), 7 * 86_400_000);
  assert.equal(rangeMs("all"), null);
  assert.equal(slideDone(250, 320, 44), false);
  assert.equal(slideDone(255, 320, 44), true);
  assert.equal(slideDone(10, 40, 44), false);
});

test("feel settings default to top-centre toasts and normalize bad input", () => {
  // v19: several toasts show as a list by default ("stacked" is the v17 deck)
  assert.deepEqual(defaultPanelSettings().feel, { toasts: "top", toastStack: "list", toastLook: defaultToastLook(), slideConfirm: false, rollingDigits: true });
  assert.deepEqual(normalizePanelSettings({ feel: { toasts: "bottom-right", slideConfirm: true, rollingDigits: "x" } }).feel, { toasts: "bottom-right", toastStack: "list", toastLook: defaultToastLook(), slideConfirm: true, rollingDigits: true });
  assert.equal(normalizePanelSettings({ feel: { toastStack: "stacked" } }).feel.toastStack, "stacked");
  assert.equal(normalizePanelSettings({ feel: { toastStack: "pile" } }).feel.toastStack, "list");
  assert.equal(normalizePanelSettings({ feel: { toasts: "left" } }).feel.toasts, "top");
  assert.equal(normalizeInstantTrade({ entry: "amount" }).entry, "amount");
  assert.equal(normalizeInstantTrade({ entry: "big" }).entry, "chips");
});
