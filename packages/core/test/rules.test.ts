import { test } from "node:test";
import assert from "node:assert/strict";
import { afterFire, decideBuy, evaluateExit, evaluateOrders, matchLaunch, matchSignal, matchXPost, positionPnl } from "../src/rules/engine.js";
import { defaultRule, validateRule } from "../src/rules/validate.js";
import type { LaunchEvent, MarketSnapshot, Order, Position, Rule, XPost } from "../src/types.js";
import { MINT_A, MINT_B, WALLET_1 } from "./fixtures.js";

const xRule = (o: Partial<Rule> = {}): Rule =>
  defaultRule({ name: "t", enabled: true, trigger: { kind: "x-post", handles: ["Alpha_Calls"], mode: "ca-in-post" }, buy: { amountSol: 0.5, slippageBps: 1500, venue: "auto", maxMcapUsd: 50_000 }, ...o });
const post = (text: string, o: Partial<XPost> = {}): XPost => ({ id: "1", handle: "alpha_calls", text, urls: [], createdAt: "", ...o });
const mkt = (mcapUsd: number): MarketSnapshot => ({ mint: MINT_A, priceSol: 1e-6, priceUsd: 2e-4, mcapUsd, liquiditySol: 30, onCurve: true, at: 0 });
const none = { buysToday: 0, holding: new Set<string>() };

test("x rule fires on a CA from a watched handle (case-insensitive, with @)", () => {
  const r = xRule({ trigger: { kind: "x-post", handles: ["@Alpha_Calls"], mode: "ca-in-post" } });
  const m = matchXPost(r, post(`CA ${MINT_A}`));
  assert.equal(m.match, true);
});

test("x rule ignores other accounts, reposts and replies by default", () => {
  assert.equal(matchXPost(xRule(), post(`CA ${MINT_A}`, { handle: "someone" })).match, false);
  assert.equal(matchXPost(xRule(), post(`CA ${MINT_A}`, { isRepost: true })).match, false);
  assert.equal(matchXPost(xRule(), post(`CA ${MINT_A}`, { isReply: true })).match, false);
});

test("ca-in-post mode needs the address in the text, not only a link", () => {
  assert.equal(matchXPost(xRule(), post("live", { urls: [`https://pump.fun/coin/${MINT_A}`] })).match, false);
});

test("two CAs in one post are skipped unless multiCa=first", () => {
  assert.equal(matchXPost(xRule(), post(`${MINT_A} or ${MINT_B}`)).match, false);
  const m = matchXPost(xRule({ multiCa: "first" }), post(`${MINT_A} or ${MINT_B}`));
  assert.equal(m.match && m.mint, MINT_A);
});

test("keyword + link mode", () => {
  const r = xRule({ trigger: { kind: "x-post", handles: ["alpha_calls"], mode: "keyword-link", keywords: ["launching"] } });
  assert.equal(matchXPost(r, post("launching now", { urls: [`https://pump.fun/coin/${MINT_A}`] })).match, true);
  assert.equal(matchXPost(r, post("gm", { urls: [`https://pump.fun/coin/${MINT_A}`] })).match, false);
  assert.equal(matchXPost(r, post("launching soon")).match, false);
});

test("disabled rules never match", () => {
  assert.equal(matchSignal(xRule({ enabled: false }), { kind: "x-post", post: post(`CA ${MINT_A}`) }).match, false);
});

test("decideBuy enforces max mcap, daily max, cooldown and holdings", () => {
  const r = xRule({ cooldownSec: 60, maxBuysPerDay: 2 });
  const m = matchXPost(r, post(`CA ${MINT_A}`));
  assert.equal(decideBuy(r, m, mkt(40_000), none).ok, true);
  const hi = decideBuy(r, m, mkt(80_000), none);
  assert.equal(!hi.ok && hi.code, "mcap-too-high");
  const day = decideBuy(r, m, mkt(40_000), { buysToday: 2, holding: new Set() });
  assert.equal(!day.ok && day.code, "daily-max");
  const cool = decideBuy(r, m, mkt(40_000), { buysToday: 0, lastFiredAt: 1_000, holding: new Set() }, 30_000);
  assert.equal(!cool.ok && cool.code, "cooldown");
  const held = decideBuy(r, m, mkt(40_000), { buysToday: 0, holding: new Set([MINT_A]) });
  assert.equal(!held.ok && held.code, "already-holding");
  const nomkt = decideBuy(r, m, null, none);
  assert.equal(!nomkt.ok && nomkt.code, "no-market");
});

const launch = (o: Partial<LaunchEvent> = {}): LaunchEvent => ({
  mint: MINT_B, name: "Night Cat", symbol: "NCAT", creator: WALLET_1, devTokens: 30_000_000, totalSupply: 1_000_000_000,
  liquiditySol: 32, mcapUsd: 6_000, socials: { x: "https://x.com/ncat", telegram: "https://t.me/ncat", website: "https://ncat.xyz" }, at: "", ...o,
});
const lRule = (filters: object) => defaultRule({ name: "l", enabled: true, trigger: { kind: "new-launch", launchpad: "pumpfun", filters } });

test("launch filters: dev %, socials, liquidity, blocklist, rug checks", () => {
  assert.equal(matchLaunch(lRule({ maxDevHoldingPct: 5 }), launch()).match, true);
  assert.equal(matchLaunch(lRule({ maxDevHoldingPct: 2 }), launch()).match, false);
  assert.equal(matchLaunch(lRule({ requireSocials: ["x", "telegram"] }), launch({ socials: { x: "a" } })).match, false);
  assert.equal(matchLaunch(lRule({ minLiquiditySol: 50 }), launch()).match, false);
  assert.equal(matchLaunch(lRule({ blocklist: ["cat"] }), launch()).match, false);
  assert.equal(matchLaunch(lRule({ rugChecks: { mintAuthorityRevoked: true } }), launch({ mintAuthorityRevoked: false })).match, false);
  assert.equal(matchLaunch(lRule({ rugChecks: { maxTop10Pct: 20 } }), launch({ top10Pct: 45 })).match, false);
});

const pos = (o: Partial<Position> = {}): Position => ({
  mint: MINT_A, symbol: "A", wallet: WALLET_1, tokens: 1000, costSol: 1, avgEntryPriceSol: 0.001, highestPriceSol: 0.001, tpDone: [], realizedSol: 0, openedAt: 0, ...o,
});

test("exit: take-profit ladder fires in order and once per step", () => {
  const x = { takeProfit: [{ atMultiple: 2, sellPct: 50 }, { atMultiple: 5, sellPct: 100 }] };
  assert.equal(evaluateExit(pos(), x, 0.0015, 0).action, null);
  const a = evaluateExit(pos(), x, 0.0021, 0).action;
  assert.equal(a?.kind, "tp");
  assert.equal(a?.step, 0);
  assert.equal(evaluateExit(pos({ tpDone: [0] }), x, 0.0021, 0).action, null);
  assert.equal(evaluateExit(pos({ tpDone: [0] }), x, 0.006, 0).action?.step, 1);
});

test("exit: stop-loss beats take-profit; trailing stop from the high; timeout", () => {
  assert.equal(evaluateExit(pos(), { stopLossPct: 30, takeProfit: [{ atMultiple: 2, sellPct: 50 }] }, 0.0007, 0).action?.kind, "sl");
  assert.equal(evaluateExit(pos({ highestPriceSol: 0.004 }), { trailingStopPct: 20 }, 0.0031, 0).action?.kind, "trail");
  assert.equal(evaluateExit(pos({ highestPriceSol: 0.004 }), { trailingStopPct: 20 }, 0.0033, 0).action, null);
  assert.equal(evaluateExit(pos(), { timeoutMin: 10 }, 0.001, 11 * 60_000).action?.kind, "timeout");
  assert.equal(evaluateExit(pos(), {}, 0.003, 0).highest, 0.003);
});

test("pnl", () => {
  const p = positionPnl(pos({ tokens: 500, realizedSol: 1 }), 0.003);
  assert.equal(Math.round(p.pnlSol * 100) / 100, 1.5);
  assert.equal(Math.round(p.pnlPct), 150);
});

test("limit orders and DCA", () => {
  const base = { mint: MINT_A, slippageBps: 1000, createdAt: 0, status: "open" as const };
  const orders: Order[] = [
    { ...base, id: "b", kind: "limit-buy", priceSol: 0.001, amountSol: 0.2 },
    { ...base, id: "s", kind: "limit-sell", priceSol: 0.003, sellPct: 50 },
    { ...base, id: "d", kind: "dca", amountSol: 0.1, intervalMin: 30, remaining: 2, nextAt: 0 },
  ];
  assert.deepEqual(evaluateOrders(orders, { mint: MINT_A, priceSol: 0.0009 }, 1).map((f) => f.order.id), ["b", "d"]);
  assert.deepEqual(evaluateOrders(orders, { mint: MINT_A, priceSol: 0.004 }, 1).map((f) => f.order.id), ["s", "d"]);
  const d2 = afterFire(orders[2], 1000);
  assert.equal(d2.remaining, 1);
  assert.equal(d2.nextAt, 1000 + 30 * 60_000);
  assert.equal(afterFire(d2).status, "filled");
});

test("validateRule catches bad input and per-trade max", () => {
  assert.equal(validateRule(xRule()).length, 0);
  const bad = validateRule({ ...xRule(), name: "", maxBuysPerDay: 0, buy: { amountSol: 0, slippageBps: 9000, venue: "auto" }, exit: { takeProfit: [{ atMultiple: 3, sellPct: 50 }, { atMultiple: 2, sellPct: 50 }] } });
  const fields = bad.map((e) => e.field);
  for (const f of ["name", "maxBuysPerDay", "buy.amountSol", "buy.slippageBps", "exit.takeProfit.1.atMultiple"]) assert.ok(fields.includes(f), f);
  const lim = validateRule(xRule(), { perTradeMaxSol: 0.2, dailySpendCapSol: 1, maxOpenPositions: 5, maxBuysPerDay: 10, minSolReserve: 0.02, killSwitch: false });
  assert.equal(lim[0]?.field, "buy.amountSol");
  const h = validateRule({ ...xRule(), trigger: { kind: "x-post", handles: ["not a handle!"], mode: "ca-in-post" } });
  assert.equal(h[0]?.field, "trigger.handles");
});

test("orders: validation and plain-English description", async () => {
  const { validateOrder, describeOrder } = await import("../src/rules/engine.js");
  const base = { id: "o1", mint: MINT_A, slippageBps: 1500, createdAt: 0, status: "open" as const };
  assert.deepEqual(validateOrder({ ...base, kind: "limit-buy", amountSol: 0.1, priceSol: 0.0000004 }), []);
  assert.match(validateOrder({ ...base, kind: "limit-sell", sellPct: 150, priceSol: 1 }).join(" "), /1-100/);
  assert.match(validateOrder({ ...base, kind: "dca", amountSol: 0.1, intervalMin: 0, remaining: 3 }).join(" "), /--every/);
  assert.equal(describeOrder({ ...base, kind: "dca", amountSol: 0.1, intervalMin: 60, remaining: 3 }), "DCA 0.1 SOL every 60 min, 3 more");
});
