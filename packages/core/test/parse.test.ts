import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAmount, parseIntent } from "../src/rules/parse.js";
import { MINT_A } from "./fixtures.js";

test("amounts", () => {
  assert.equal(parseAmount("50k"), 50_000);
  assert.equal(parseAmount("$1.2m"), 1_200_000);
  assert.equal(parseAmount("250"), 250);
});

test("the headline example", () => {
  const r = parseIntent("snipe anything @x posts under 50k mcap with 0.5 SOL");
  assert.equal(r.kind, "rule");
  if (r.kind !== "rule") return;
  assert.deepEqual(r.draft.trigger, { kind: "x-post", handles: ["x"], mode: "ca-in-post" });
  assert.equal(r.draft.buy.amountSol, 0.5);
  assert.equal(r.draft.buy.maxMcapUsd, 50_000);
  assert.equal(r.draft.enabled, false, "drafts start disabled until confirmed");
  assert.deepEqual(r.errors, []);
});

test("rule with exits, limits and fees in one sentence", () => {
  const r = parseIntent("snipe whatever @Alpha_Calls and @beta posts with 0.25 sol, max mcap 120k, sell half if it 3x's, stop loss 30%, trailing 20%, max 2 buys a day, slippage 12%, jito tip 0.001");
  assert.equal(r.kind, "rule");
  if (r.kind !== "rule") return;
  const t = r.draft.trigger;
  assert.ok(t.kind === "x-post" && t.handles.join() === "alpha_calls,beta");
  assert.equal(r.draft.buy.amountSol, 0.25);
  assert.equal(r.draft.buy.maxMcapUsd, 120_000);
  assert.deepEqual(r.draft.exit.takeProfit, [{ atMultiple: 3, sellPct: 50 }]);
  assert.equal(r.draft.exit.stopLossPct, 30);
  assert.equal(r.draft.exit.trailingStopPct, 20);
  assert.equal(r.draft.maxBuysPerDay, 2);
  assert.equal(r.draft.buy.slippageBps, 1200);
  assert.equal(r.draft.buy.jitoTipSol, 0.001);
});

test("exit-only phrases", () => {
  const r = parseIntent("sell half if it 3x's");
  assert.equal(r.kind, "exit");
  if (r.kind === "exit") assert.deepEqual(r.exit.takeProfit, [{ atMultiple: 3, sellPct: 50 }]);
  const r2 = parseIntent("take profit 2x sell 25%, at 5x sell 50%, cut at -40%");
  assert.equal(r2.kind, "exit");
  if (r2.kind === "exit") {
    assert.deepEqual(r2.exit.takeProfit, [{ atMultiple: 2, sellPct: 25 }, { atMultiple: 5, sellPct: 50 }]);
    assert.equal(r2.exit.stopLossPct, 40);
  }
});

test("new launch rule with filters", () => {
  const r = parseIntent("buy 0.1 sol of new pump.fun launches with socials, dev under 5%, liquidity 10 sol, skip cat or dog, rug checks");
  assert.equal(r.kind, "rule");
  if (r.kind !== "rule" || r.draft.trigger.kind !== "new-launch") return assert.fail();
  const f = r.draft.trigger.filters;
  assert.equal(f.maxDevHoldingPct, 5);
  assert.deepEqual(f.requireSocials, ["x", "telegram", "website"]);
  assert.equal(f.minLiquiditySol, 10);
  assert.deepEqual(f.blocklist, ["cat", "dog"]);
  assert.ok(f.rugChecks?.mintAuthorityRevoked);
});

test("keyword + link mode", () => {
  const r = parseIntent('buy 0.2 sol when @dev_guy says "launching" with a link');
  assert.ok(r.kind === "rule" && r.draft.trigger.kind === "x-post" && r.draft.trigger.mode === "keyword-link");
});

test("direct trades and controls", () => {
  const b = parseIntent(`buy 0.3 sol of ${MINT_A}`);
  assert.ok(b.kind === "trade" && b.action === "buy" && b.amountSol === 0.3);
  const s = parseIntent(`sell half of ${MINT_A}`);
  assert.ok(s.kind === "trade" && s.action === "sell" && s.sellPct === 50);
  assert.equal(parseIntent("pause").kind, "control");
  assert.equal(parseIntent("hit the kill switch").kind, "control");
});

test("refuses manipulation", () => {
  for (const s of ["run a volume bot on my coin", "make volume with 5 wallets", "buy followers for launch", "spread buys across wallets to look organic"])
    assert.equal(parseIntent(s).kind, "refuse", s);
});

test("unknown input gets a hint", () => assert.equal(parseIntent("what's the weather").kind, "unknown"));
