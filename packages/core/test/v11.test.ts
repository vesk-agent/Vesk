/**
 * v11: order types (limit at market cap, stop-loss, trailing, DCA with slices and a market-cap band, TWAP,
 * dev-sell), callouts (text rules, holder check, rate limits, flags), trader stats and the fee breakdown.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  afterFail, afterFire, dcaSlice, describeOrder, devSellMints, evaluateOrders, inBand, matchDevSell, normalizeOrders, notePrice, twapSchedule, validateOrder,
} from "../src/rules/engine.js";
import { CALLOUT_RULES, cleanCalloutText, flagCallout, holderCheck, rateCheck, visibleCallouts, type Callout } from "../src/coin/callouts.js";
import { earlyBuyers, stats5m, topTraders, type TradeLite } from "../src/coin/traders.js";
import { taxBreakdown } from "../src/coin/fees.js";
import type { Order } from "../src/types.js";

const MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const DEV = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const base = { id: "o", mint: MINT, slippageBps: 1500, createdAt: 0, status: "open" as const };
const mk = (o: Partial<Order>): Order => ({ ...base, kind: "limit-buy", ...o } as Order);

test("orders: limit buy / sell and stop-loss on market cap as well as price", () => {
  const orders = [
    mk({ id: "lb", kind: "limit-buy", amountSol: 0.1, atMcapUsd: 40_000 }),
    mk({ id: "ls", kind: "limit-sell", sellPct: 50, atMcapUsd: 120_000 }),
    mk({ id: "sl", kind: "stop-loss", sellPct: 100, priceSol: 0.00000002 }),
  ];
  assert.deepEqual(evaluateOrders(orders, { mint: MINT, priceSol: 0.00000003, mcapUsd: 39_000 }, 1).map((f) => f.order.id), ["lb"]);
  assert.deepEqual(evaluateOrders(orders, { mint: MINT, priceSol: 0.00000003, mcapUsd: 130_000 }, 1).map((f) => [f.order.id, f.action, f.sellPct]), [["ls", "sell", 50]]);
  assert.deepEqual(evaluateOrders(orders, { mint: MINT, priceSol: 0.00000001, mcapUsd: 60_000 }, 1).map((f) => f.order.id), ["sl"]);
  // no market cap in the snapshot: market-cap triggers wait instead of guessing
  assert.deepEqual(evaluateOrders(orders.slice(0, 2), { mint: MINT, priceSol: 1 }, 1), []);
  assert.equal(afterFire(orders[0]).status, "filled");
});

test("orders: trailing stop follows the high and fires trailPct below it", () => {
  let o = mk({ id: "tr", kind: "trailing", trailPct: 20, sellPct: 100 });
  for (const p of [1, 1.5, 2, 1.8]) o = notePrice(o, p);
  assert.equal(o.peakPriceSol, 2);
  assert.deepEqual(evaluateOrders([o], { mint: MINT, priceSol: 1.7 }, 1), [], "15% below the high: not yet");
  const f = evaluateOrders([o], { mint: MINT, priceSol: 1.6 }, 1);
  assert.equal(f.length, 1); assert.equal(f[0].action, "sell");
  assert.equal(notePrice(o, 1.9), o, "unchanged below the high");
  assert.match(describeOrder(o), /trailing stop: sell 100% 20% below the high \(high 2 SOL\)/);
});

test("orders: DCA runs its slices on the interval and waits outside its market-cap band", () => {
  let o = mk({ id: "d", kind: "dca", amountSol: dcaSlice(0.3, 3), intervalSec: 2, remaining: 3, slices: 3, nextAt: 0, minMcapUsd: 10_000, maxMcapUsd: 80_000 });
  assert.equal(o.amountSol, 0.1);
  let t = 1_000;
  const fills: number[] = [];
  for (let step = 0; step < 20 && o.status === "open"; step++, t += 1_000) {
    const mcapUsd = step === 3 ? 95_000 : 50_000; // one tick above the band
    const f = evaluateOrders([o], { mint: MINT, priceSol: 1, mcapUsd }, t);
    if (f.length) { fills.push(t); o = afterFire(o, t); }
  }
  assert.equal(o.status, "filled");
  assert.equal(o.fills, 3);
  assert.deepEqual(fills, [1_000, 3_000, 5_000]);
  assert.equal(inBand({ minMcapUsd: 10_000 }, undefined), false, "unknown market cap with a band: wait");
  assert.equal(inBand({}, undefined), true);
  assert.match(describeOrder(mk({ kind: "dca", amountSol: 0.1, intervalSec: 30, remaining: 3, maxMcapUsd: 80_000 })), /DCA 0\.1 SOL every 30 s, 3 more while market cap ≤ \$80K/);
});

test("orders: TWAP schedule is even (or weighted), adds up exactly, and fills in order", () => {
  const s = twapSchedule({ side: "buy", total: 1, durationSec: 60, slices: 3 }, 1_000);
  assert.deepEqual(s.map((x) => x.at), [1_000, 31_000, 61_000]);
  assert.deepEqual(s.map((x) => x.amountSol), [0.333333333, 0.333333333, 0.333333334]);
  assert.equal(s.reduce((a, x) => a + (x.amountSol ?? 0), 0).toFixed(9), "1.000000000");
  const w = twapSchedule({ side: "sell", total: 90, durationSec: 100, weights: [50, 30, 20] }, 0);
  assert.deepEqual(w.map((x) => x.sellPct), [45, 27, 18]);
  let o = mk({ id: "tw", kind: "twap", side: "buy", totalSol: 1, durationSec: 60, schedule: s, slices: 3 });
  assert.deepEqual(validateOrder(o), []);
  assert.deepEqual(evaluateOrders([o], { mint: MINT, priceSol: 1 }, 500), [], "nothing before the first slice");
  const f1 = evaluateOrders([o], { mint: MINT, priceSol: 1 }, 1_000);
  assert.equal(f1[0].slice, 0); assert.equal(f1[0].amountSol, 0.333333333);
  o = afterFire(o, 1_000, 0);
  assert.deepEqual(evaluateOrders([o], { mint: MINT, priceSol: 1 }, 20_000), [], "slice 2 not due yet");
  o = afterFire(o, 31_000, evaluateOrders([o], { mint: MINT, priceSol: 1 }, 31_000)[0].slice);
  o = afterFire(o, 61_000, evaluateOrders([o], { mint: MINT, priceSol: 1 }, 61_000)[0].slice);
  assert.equal(o.status, "filled");
  assert.match(describeOrder({ ...o, status: "open" }), /TWAP buy 1 SOL over 1 min in 3 slices, 0 left/);
  assert.match(validateOrder(mk({ kind: "twap", totalSol: 1, durationSec: 5, schedule: s })).join(" "), /10 s to 7 days/);
});

test("orders: dev-sell fires only on that dev's sell of that coin, above the minimum", () => {
  const o = mk({ id: "ds", kind: "dev-sell", side: "buy", amountSol: 0.2, dev: DEV, minDevSellSol: 0.5 });
  assert.deepEqual(validateOrder(o), []);
  assert.deepEqual(evaluateOrders([o], { mint: MINT, priceSol: 1 }, 1), [], "never fires on price");
  assert.deepEqual(matchDevSell([o], { mint: MINT, trader: DEV, side: "buy", sol: 3 }), []);
  assert.deepEqual(matchDevSell([o], { mint: MINT, trader: "someone-else", side: "sell", sol: 3 }), []);
  assert.deepEqual(matchDevSell([o], { mint: MINT, trader: DEV, side: "sell", sol: 0.1 }), [], "below the minimum");
  const f = matchDevSell([o], { mint: MINT, trader: DEV, side: "sell", sol: 2 });
  assert.equal(f.length, 1); assert.equal(f[0].action, "buy"); assert.equal(f[0].amountSol, 0.2);
  assert.deepEqual(devSellMints([o, { ...o, id: "x", status: "cancelled" }]), [MINT]);
  assert.match(validateOrder({ ...o, dev: "nope" }).join(" "), /dev's wallet/);
  assert.match(describeOrder(o), /when the dev \(9WzD…AWWM\) sells ≥ 0\.5 SOL: buy 0\.2 SOL/);
});

test("orders: failures keep the order open with the reason; normalize drops invalid ones", () => {
  const o = mk({ id: "lb", kind: "limit-buy", amountSol: 0.1, priceSol: 1 });
  const failed = afterFail(o, "Kill switch is on.");
  assert.equal(failed.status, "open"); assert.equal(failed.lastError, "Kill switch is on.");
  const n = normalizeOrders([o, { ...o, id: "bad", amountSol: 0 }, { foo: 1 }, { ...o, id: "c", status: "cancelled" }]);
  assert.deepEqual(n.map((x) => [x.id, x.status]), [["lb", "open"], ["c", "cancelled"]]);
  assert.match(validateOrder(mk({ kind: "dca", amountSol: 0.1, intervalSec: 1, remaining: 3 })).join(" "), /at least 2 s/);
  assert.match(validateOrder(mk({ kind: "dca", amountSol: 0.1, intervalSec: 5, remaining: 3, minMcapUsd: 9, maxMcapUsd: 5 })).join(" "), /below max/);
  assert.match(validateOrder(mk({ kind: "trailing", trailPct: 95 })).join(" "), /1-90%/);
});

test("callouts: plain text only, short, no links or addresses", () => {
  assert.deepEqual(cleanCalloutText("  dev   still holding,​ chart looks fine  "), { ok: true, text: "dev still holding, chart looks fine" });
  for (const bad of ["buy at https://scam.example", "join t.me/pumpgroup", "check www.coin.io", `next one: ${MINT}`, "x".repeat(CALLOUT_RULES.maxLen + 1), "   ", 42]) {
    assert.equal(cleanCalloutText(bad).ok, false, String(bad).slice(0, 30));
  }
});

test("callouts: holder check needs the minimum in USD and a known price", () => {
  assert.equal(holderCheck(2_000_000, 0.00005).ok, true, "$100 exactly");
  const low = holderCheck(1_000_000, 0.00005);
  assert.equal(low.ok, false); assert.match(low.reason ?? "", /at least \$100 .* You hold \$50\.00/);
  assert.equal(holderCheck(1e12, undefined).ok, false, "no price, no callout");
  assert.equal(holderCheck(10, 20, { minHoldUsd: 150 }).ok, true);
});

test("callouts: rate limits per author per coin, per author per hour, per coin per hour", () => {
  const now = 10_000_000;
  const mine = [{ author: "a", mint: MINT, at: now - 60_000 }];
  const r1 = rateCheck(mine, "a", MINT, now);
  assert.equal(r1.ok, false); assert.equal(r1.retryInMs, 9 * 60_000);
  assert.equal(rateCheck(mine, "a", MINT, now + 9 * 60_000 + 1).ok, true);
  const many = Array.from({ length: 6 }, (_, i) => ({ author: "a", mint: `m${i}`, at: now - 1_000 * (i + 1) }));
  assert.match(rateCheck(many, "a", MINT, now).reason ?? "", /6 callouts an hour/);
  const busy = Array.from({ length: 30 }, (_, i) => ({ author: `u${i}`, mint: MINT, at: now - 1_000 }));
  assert.match(rateCheck(busy, "a", MINT, now).reason ?? "", /a lot of callouts/);
});

test("callouts: three distinct flags hide a callout; authors can't flag their own", () => {
  let c: Callout = { id: "c1", mint: MINT, author: "acct-a", wallet: DEV, text: "hi", at: 1, holdUsd: 120, flags: [] };
  c = flagCallout(c, "acct-a");
  assert.equal(c.flags.length, 0);
  c = flagCallout(flagCallout(flagCallout(c, "b"), "b"), "c");
  assert.equal(c.flags.length, 2); assert.equal(!!c.hidden, false);
  c = flagCallout(c, "d");
  assert.equal(c.hidden, true);
  const shown = visibleCallouts([c, { ...c, id: "c2", hidden: false, flags: ["x"], at: 5 }]);
  assert.deepEqual(shown.map((x) => [x.id, x.flagCount]), [["c2", 1]]);
  assert.equal("author" in shown[0], false, "account ids never reach the page");
});

test("traders: realized PnL on average cost, partial when they sold more than we saw them buy", () => {
  const t: TradeLite[] = [
    { at: 1, side: "buy", wallet: "A", sol: 1, tokens: 1000 },
    { at: 2, side: "buy", wallet: "A", sol: 3, tokens: 1000 },
    { at: 3, side: "sell", wallet: "A", sol: 3, tokens: 1000 }, // avg cost 2 per 1000 → +1
    { at: 4, side: "sell", wallet: "B", sol: 2, tokens: 500 }, // bought before the window
    { at: 5, side: "buy", wallet: "C", sol: 0.5, tokens: 100 },
  ];
  const rows = topTraders(t, 0.004);
  const a = rows.find((r) => r.wallet === "A")!;
  assert.equal(a.realizedSol, 1); assert.equal(a.unrealizedSol, 4); assert.equal(a.partial, false);
  assert.equal(a.pnlSol, 3, "realized +1, plus 1000 tokens worth 4 that cost 2");
  const b = rows.find((r) => r.wallet === "B")!;
  assert.equal(b.partial, true); assert.equal(b.realizedSol, 0, "no invented cost");
  assert.equal(rows[0].wallet, "A");
  const s = stats5m([...t.map((x) => ({ ...x, at: 1_000_000 - x.at })), { at: 1, side: "buy", wallet: "old", sol: 99, tokens: 1 }], 1_000_000);
  assert.deepEqual(s, { volSol: 9.5, buys: 3, sells: 2, buySol: 4.5, sellSol: 5, netSol: -0.5 });
});

test("traders: early buyers in order, with holding status from the RPC when given", () => {
  const t: TradeLite[] = [
    { at: 3, side: "buy", wallet: "C", sol: 1, tokens: 100 },
    { at: 1, side: "buy", wallet: "A", sol: 1, tokens: 100 },
    { at: 2, side: "sell", wallet: "Z", sol: 1, tokens: 100 },
    { at: 2, side: "buy", wallet: "B", sol: 2, tokens: 200 },
    { at: 4, side: "sell", wallet: "A", sol: 1.5, tokens: 100 },
    { at: 5, side: "sell", wallet: "B", sol: 0.5, tokens: 50 },
  ];
  const e = earlyBuyers(t, 2);
  assert.deepEqual(e.map((x) => [x.rank, x.wallet, x.status]), [[1, "A", "sold all"], [2, "B", "sold some"]]);
  const h = earlyBuyers(t, 3, new Map([["B", 200], ["C", 40]]));
  assert.deepEqual(h.map((x) => x.status), ["sold all", "holding", "sold some"]);
});

test("fees: protocol + creator (+ LP) + transfer tax = total", () => {
  const p = taxBreakdown("pumpfun-curve");
  assert.equal(p.totalPct, 1.25); assert.equal(p.protocolPct + p.creatorPct, 1.25);
  const s = taxBreakdown("pumpswap", 100);
  assert.equal(s.transferPct, 1); assert.equal(s.totalPct, 1.3);
  assert.equal(taxBreakdown("other").known, false);
});

test("settings: v11 display tiles, X card elements and quick-buy appearance normalise and keep older saves working", async () => {
  const { defaultPanelSettings, normalizePanelSettings, qbVars, X_CARD_ELS } = await import("../src/ui/panelSettings.js");
  const d = defaultPanelSettings();
  assert.equal(d.display.imageShape, "square", "square avatars by default");
  assert.equal(d.display.spacedTables, "merged");
  assert.equal(d.hover.xCard.renames, false, "renames off by default (X doesn't expose rename history publicly)");
  assert.equal(X_CARD_ELS.every((k) => typeof d.hover.xCard[k] === "boolean"), true);
  const n = normalizePanelSettings({ display: { spacedTables: "spaced", unhideOnMigrated: true }, hover: { xCard: { media: false, bogus: true } }, qb: { size: "xl", grey: false, ultraGlow: false } });
  assert.equal(n.display.spacedTables, "spaced"); assert.equal(n.display.unhideOnMigrated, true);
  assert.equal(n.hover.xCard.media, false); assert.equal(n.hover.xCard.likes, true); assert.equal("bogus" in n.hover.xCard, false);
  assert.match(qbVars(n.qb).cls, /qb-xl qbs-accent/);
  // a v9 save with only `style`
  const old = normalizePanelSettings({ qb: { size: "ultra", style: "wide-ultra" } });
  assert.equal(old.qb.grey, false); assert.equal(old.qb.ultraWider, true); assert.equal(old.qb.ultraGlow, true);
  assert.match(qbVars(old.qb).cls, /qb-ultra qbs-accent qb-uglow qb-wider/);
  assert.match(qbVars(normalizePanelSettings({ qb: { style: "gray" } }).qb).cls, /qbs-gray/);
  assert.equal(normalizePanelSettings({ display: { spacedTables: "weird" } }).display.spacedTables, "merged");
});
