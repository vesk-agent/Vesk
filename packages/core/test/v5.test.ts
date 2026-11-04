import { test } from "node:test";
import assert from "node:assert/strict";
import { accessState, GATE_EXEMPT, signInMessage, VESK_GATE_MIN_DEFAULT } from "../src/access.js";
import { defaultPreset, effectiveRule, FREE_LAUNCH_COST_SOL, planFromPreset, presetCost, ruleFromPreset, validatePreset } from "../src/launch/presets.js";
import { defaultLaunchRule } from "../src/launch/onpost.js";
import { evaluateExit, TIME_STEP } from "../src/rules/engine.js";
import { columnsFor, enrichPost, inColumn, matchFilter, trackedHandles } from "../src/watch/tracker.js";
import type { Position, XPost } from "../src/types.js";
import { MINT_A } from "./fixtures.js";

const NOW = 1_800_000_000_000;

test("presets: validation, free launch honesty, plan", () => {
  assert.deepEqual(validatePreset(defaultPreset({ name: "Std" })), []);
  const free = defaultPreset({ name: "Free", devBuySol: 0, mode: "manual", exit: {} });
  assert.deepEqual(validatePreset(free), []);
  assert.match(presetCost(free).line, new RegExp(`Free launch: no dev buy\\. You still pay network and launchpad fees \\(about ~${FREE_LAUNCH_COST_SOL} SOL\\)`));
  // v22: pump.fun's extra quote pairs and holder rewards are offered (unverified, capabilities.ts); "custom" isn't
  assert.deepEqual(validatePreset(defaultPreset({ name: "x", quote: "USD1" })), []);
  assert.deepEqual(validatePreset(defaultPreset({ name: "x", creatorFees: "holders" })), []);
  assert.match(validatePreset(defaultPreset({ name: "x", quote: "custom" })).map((e) => e.field).join(), /quote/);
  assert.match(validatePreset(defaultPreset({ name: "x", devBuySol: 0, mode: "manual", exit: { timeSells: [{ afterSec: 5, sellPct: 100 }] } })).map((e) => e.message).join(), /need a dev buy/);
  const plan = planFromPreset(defaultPreset({ name: "x", teamWallets: 2 }), { name: "Cat", symbol: "CAT", description: "" }, ["A", "B", "C"]);
  assert.deepEqual(plan.team?.wallets, ["A", "B"]);
  assert.equal(plan.token.quote, "SOL");
  assert.equal(planFromPreset(free, { name: "Cat", symbol: "CAT", description: "" }).mode, "manual");
});

test("presets drive launch-on-post rules and deploys", () => {
  const p = defaultPreset({ id: "pr1", name: "Fast", devBuySol: 0.5, exit: { timeSells: [{ afterSec: 5, sellPct: 100 }] } });
  const r = effectiveRule({ ...defaultLaunchRule({ trigger: { handles: ["a"], requireImage: true } }), presetId: "pr1" }, [p]);
  assert.equal(r.plan.devBuySol, 0.5);
  assert.deepEqual(r.exit.timeSells, [{ afterSec: 5, sellPct: 100 }]);
  assert.equal(ruleFromPreset(p, "b").trigger.handles[0], "b");
});

test("timed dev sells fire in seconds, in order, once", () => {
  const pos: Position = { mint: "M", symbol: "CAT", wallet: "W", tokens: 1000, costSol: 0.5, avgEntryPriceSol: 0, highestPriceSol: 0, tpDone: [], realizedSol: 0, openedAt: NOW };
  const x = { timeSells: [{ afterSec: 5, sellPct: 50 }, { afterSec: 30, sellPct: 100 }] };
  assert.equal(evaluateExit(pos, x, 0, NOW + 4_000).action, null);
  const a = evaluateExit(pos, x, 0, NOW + 5_000).action!;
  assert.deepEqual([a.kind, a.sellPct, a.step], ["timed", 50, TIME_STEP]);
  assert.equal(evaluateExit({ ...pos, tpDone: [TIME_STEP] }, x, 0, NOW + 10_000).action, null);
  assert.equal(evaluateExit({ ...pos, tpDone: [TIME_STEP] }, x, 0, NOW + 30_000).action?.step, TIME_STEP + 1);
});

test("tracker: CA detection, latency, groups, columns, filters", () => {
  const groups = [{ id: "f", name: "Founders", handles: ["alice"], sound: true, notify: false }];
  const post: XPost = { id: "1", handle: "Alice", text: `new thing ${MINT_A}`, urls: [], createdAt: new Date(NOW - 850).toISOString(), media: [{ type: "photo", url: "https://x/a.jpg" }] };
  const fp = enrichPost(post, groups, NOW);
  assert.equal(fp.latencyMs, 850);
  assert.equal(fp.ca?.mint, MINT_A);
  assert.deepEqual(fp.groups, ["f"]);
  const cols = columnsFor(groups);
  assert.deepEqual(cols.map((c) => c.id), ["all", "g:f", "ca"]);
  assert.ok(cols.every((c) => inColumn(fp, c)));
  const plain = enrichPost({ ...post, id: "2", handle: "bob", text: "gm", media: undefined }, groups, NOW);
  assert.equal(inColumn(plain, cols[2]), false);
  assert.equal(matchFilter(plain, { hasMedia: true }), false);
  assert.equal(matchFilter(fp, { keywords: ["THING"] }), true);
  assert.equal(matchFilter(fp, { minFollowers: 1000 }), false);
  assert.deepEqual(trackedHandles(groups, ["@Bob", "alice"]), ["alice", "bob"]);
});

test("holder access: off until the mint is set, sums wallets, exempts funds and reads", () => {
  assert.equal(accessState({ mint: null, balances: [] }).enabled, false);
  assert.equal(accessState({ mint: null, balances: [] }).ok, true);
  const s = accessState({ mint: "VESK", balances: [300_000, 250_000] });
  assert.deepEqual([s.enabled, s.held, s.min, s.ok], [true, 550_000, VESK_GATE_MIN_DEFAULT, true]);
  assert.equal(accessState({ mint: "VESK", min: 1_000_000, balances: [550_000] }).ok, false);
  for (const a of ["hosted-withdraw", "hosted-export", "wallets-return", "access-verify"]) assert.ok(GATE_EXEMPT.has(a));
  assert.ok(!GATE_EXEMPT.has("hosted-trade") && !GATE_EXEMPT.has("launch"));
  const m = signInMessage({ domain: "veskagent.com", address: "Addr1", nonce: "n0nce", issuedAt: "2026-10-14T00:00:00Z", accountId: "acct" });
  assert.match(m, /^veskagent\.com wants you to sign in with your Solana account:\nAddr1\n/);
  assert.match(m, /does not move funds/);
  assert.match(m, /Nonce: n0nce/);
});
