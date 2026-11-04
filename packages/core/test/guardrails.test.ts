import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPost, checkTrade, forbiddenIntent, type GuardContext } from "../src/guardrails.js";
import { DEFAULT_LIMITS, type TradeIntent } from "../src/types.js";
import { MINT_A, WALLET_1, WALLET_2 } from "./fixtures.js";

const ctx = (o: Partial<GuardContext> = {}): GuardContext => ({
  limits: { ...DEFAULT_LIMITS, perTradeMaxSol: 0.5, dailySpendCapSol: 2, maxOpenPositions: 3, maxBuysPerDay: 5, minSolReserve: 0.05 },
  ownWallets: [WALLET_1, WALLET_2], spentTodaySol: 0, buysToday: 0, openPositions: 0, walletBalanceSol: 5, recentFills: [], now: 1_000_000_000, ...o,
});
const buy = (o: Partial<TradeIntent> = {}): TradeIntent => ({ action: "buy", mint: MINT_A, wallet: WALLET_1, amountSol: 0.3, reason: "rule", ...o });
const code = (r: ReturnType<typeof checkTrade>) => (r.ok ? "ok" : r.code);

test("normal buy passes", () => assert.equal(code(checkTrade(buy(), ctx())), "ok"));

test("kill switch blocks buys but not sells or withdrawals", () => {
  const k = ctx({ limits: { ...ctx().limits, killSwitch: true } });
  assert.equal(code(checkTrade(buy(), k)), "kill-switch");
  assert.equal(code(checkTrade({ action: "sell", mint: MINT_A, wallet: WALLET_1, sellPct: 100, reason: "exit" }, k)), "ok");
  assert.equal(code(checkTrade({ action: "withdraw", wallet: WALLET_1, to: "Hq4Ae2xXbTZ7nRkd9WcYp3mVfL8sJ6uG1oEt5BvNpump", amountSol: 1, reason: "out" }, k)), "ok");
});

test("only the owner's disclosed wallets can trade", () => {
  assert.equal(code(checkTrade(buy({ wallet: "Hq4Ae2xXbTZ7nRkd9WcYp3mVfL8sJ6uG1oEt5BvNpump" }), ctx())), "undisclosed-wallet");
});

test("spend limits", () => {
  assert.equal(code(checkTrade(buy({ amountSol: 0.6 }), ctx())), "per-trade-max");
  assert.equal(code(checkTrade(buy({ amountSol: 0.5 }), ctx({ spentTodaySol: 1.6 }))), "daily-cap");
  assert.equal(code(checkTrade(buy(), ctx({ buysToday: 5 }))), "daily-buys");
  assert.equal(code(checkTrade(buy(), ctx({ openPositions: 3 }))), "max-positions");
  assert.equal(code(checkTrade(buy(), ctx({ openPositions: 3, holdsMint: true }))), "ok");
  assert.equal(code(checkTrade(buy(), ctx({ walletBalanceSol: 0.32 }))), "reserve");
});

test("no wash trading: no quick round trips", () => {
  const c = ctx({ recentFills: [{ at: 1_000_000_000 - 60_000, mint: MINT_A, side: "sell", wallet: WALLET_1, amountSol: 0.3 }] });
  assert.equal(code(checkTrade(buy(), c)), "wash-trade");
});

test("no multi-wallet buys or self-trades", () => {
  const c = ctx({ recentFills: [{ at: 1_000_000_000 - 60_000, mint: MINT_A, side: "buy", wallet: WALLET_2, amountSol: 0.3 }] });
  assert.equal(code(checkTrade(buy(), c)), "multi-wallet");
  assert.equal(code(checkTrade({ action: "sell", mint: MINT_A, wallet: WALLET_1, sellPct: 50, reason: "x" }, c)), "self-trade");
});

test("buybacks and burns must be disclosed and rate-limited", () => {
  assert.equal(code(checkTrade(buy({ action: "buyback" }), ctx())), "undisclosed-buyback");
  assert.equal(code(checkTrade(buy({ action: "buyback", disclosed: true }), ctx())), "ok");
  assert.equal(code(checkTrade(buy({ action: "buyback", disclosed: true }), ctx({ lastBuybackAt: 1_000_000_000 - 60_000 }))), "buyback-rate");
  assert.equal(code(checkTrade({ action: "burn", mint: MINT_A, wallet: WALLET_1, tokens: 10, reason: "burn" }, ctx())), "undisclosed-buyback");
});

test("forbidden actions are refused whatever the wording", () => {
  assert.equal(code(checkTrade({ ...buy(), action: "volume" as never }, ctx())), "forbidden-action");
  assert.equal(code(checkTrade(buy({ reason: "volume bot run" }), ctx())), "forbidden-action");
  for (const s of ["start a volume bot", "wash trade it", "buy followers", "spin up sockpuppets", "impersonate @ansem", "bundle buy with 5 wallets", "use 10 wallets to buy", "coordinated pump at 9pm"])
    assert.ok(forbiddenIntent(s), s);
  for (const s of ["snipe @alpha under 50k", "sell half at 3x", "post a treasury update"]) assert.equal(forbiddenIntent(s), null, s);
});

test("posting guardrails", () => {
  const pc = { ownAccounts: ["vesk_coin"], recentPosts: [], now: 10_000_000 };
  const pcode = (r: ReturnType<typeof checkPost>) => (r.ok ? "ok" : r.code);
  assert.equal(pcode(checkPost("vesk_coin", "Treasury update: claimed 1.2 SOL in creator fees.", pc)), "ok");
  assert.equal(pcode(checkPost("someone_else", "hi", pc)), "post-account");
  assert.equal(pcode(checkPost("vesk_coin", "Guaranteed 100x, can't lose", pc)), "post-promise");
  assert.equal(pcode(checkPost("vesk_coin", "Everyone buy at 9:00 UTC", pc)), "post-coordination");
  assert.equal(pcode(checkPost("vesk_coin", "Official statement on behalf of solana_foundation", pc)), "post-impersonation");
  const recent = Array.from({ length: 6 }, (_, i) => ({ at: 10_000_000 - i * 1000, account: "vesk_coin", text: `update ${i}` }));
  assert.equal(pcode(checkPost("vesk_coin", "another", { ...pc, recentPosts: recent })), "post-rate");
  assert.equal(pcode(checkPost("vesk_coin", "Update  0", { ...pc, recentPosts: [{ at: 9_999_000, account: "vesk_tg", text: "update 0" }] })), "post-duplicate");
});
