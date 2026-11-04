import { test } from "node:test";
import { QUOTE_MINTS } from "../src/data/programs.js";
const QUOTE_MINTS_USD1 = Object.keys(QUOTE_MINTS).find((k) => QUOTE_MINTS[k] === "USD1");
import assert from "node:assert/strict";
import {
  bundleRequests, checkLaunch, defaultPlan, disclosureText, estimateCurveBuys, finalDescription, MAX_TEAM_WALLETS, parseLaunchRequest, summarizePlan,
  validatePlan, type LaunchPlan,
} from "../src/launch/plan.js";
import { LAUNCHPADS } from "../src/launch/launchpads.js";
import { AUTO_BUNDLE_TIP_SOL, createParams, effectiveTip, launchRoute } from "../src/launch/plan.js";
import { feeRange, PUMPFUN_CAPS, rewardAsset, unverifiedSettings } from "../src/launch/capabilities.js";
import { claimCovers, claimRequest, claimTotals, claimVerified, type CreatorFeeRow } from "../src/launch/claim.js";
import { parseIntent } from "../src/rules/parse.js";
import { forbiddenIntent } from "../src/guardrails.js";
import type { Limits } from "../src/types.js";
import { MINT_A, MINT_B, MINT_C, WALLET_1, WALLET_2 } from "./fixtures.js";

const limits: Limits = { perTradeMaxSol: 2, dailySpendCapSol: 5, maxOpenPositions: 5, maxBuysPerDay: 20, minSolReserve: 0.05, killSwitch: false };
const plan = (o: Partial<LaunchPlan> = {}): LaunchPlan => ({
  ...defaultPlan(), token: { ...defaultPlan().token, name: "Night Owl", symbol: "OWL", description: "A coin for people who trade at 3am." }, ...o,
});
const team = (n: number, solEach = 0.2, disclosed = true) => ({ wallets: [WALLET_2, MINT_A, MINT_B, MINT_C, "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"].slice(0, n), solEach, disclosed });
const ctx = { limits, ownWallets: [WALLET_1, WALLET_2, MINT_A, MINT_B, MINT_C], creator: WALLET_1, spentTodaySol: 0 };

test("only implemented launchpads are selectable", () => {
  assert.deepEqual(LAUNCHPADS.filter((l) => l.status === "ready").map((l) => l.id), ["pumpfun"]);
  assert.equal(LAUNCHPADS.length, 11);
  assert.match(validatePlan(plan({ launchpad: "letsbonk" })).map((e) => e.message).join(" "), /coming soon/);
  // v22: pump.fun offers non-SOL quote pairs and holder rewards (capabilities.ts, unverified); "custom" isn't offered
  assert.deepEqual(validatePlan(plan({ token: { ...plan().token, quote: "USDC" } })), []);
  assert.deepEqual(validatePlan(plan({ token: { ...plan().token, creatorFees: "holders" } })), []);
  assert.match(validatePlan(plan({ token: { ...plan().token, quote: "custom" } })).map((e) => e.field).join(), /quote/);
});

test("pump.fun curve estimates are monotonic and sane", () => {
  const [one] = estimateCurveBuys([1]);
  assert.ok(one.pct > 3 && one.pct < 3.6, `1 SOL ≈ 3.4% of supply, got ${one.pct}`);
  const seq = estimateCurveBuys([1, 1]);
  assert.ok(seq[1].tokens < seq[0].tokens, "later buys get fewer tokens");
  assert.ok(estimateCurveBuys([500])[0].pct <= 79.31 + 1e-9, "capped at the curve's real reserves");
});

test("team wallets must be disclosed, capped and equal", () => {
  assert.deepEqual(validatePlan(plan({ team: team(3) })), []);
  assert.equal(checkLaunch(plan({ team: team(2, 0.2, false) }), ctx).ok, false);
  const r = checkLaunch(plan({ team: team(2, 0.2, false) }), ctx);
  assert.equal(!r.ok && r.code, "launch-disclosure");
  const big = checkLaunch(plan({ team: team(MAX_TEAM_WALLETS + 1) }), ctx);
  assert.equal(!big.ok && big.code, "launch-team");
  const manual = validatePlan(plan({ mode: "manual", devBuySol: 0, team: team(1) }));
  assert.match(manual.map((e) => e.message).join(" "), /Standard mode/);
});

test("team wallets must be the owner's own, and not the creator", () => {
  const strangers = checkLaunch(plan({ team: { wallets: ["9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"], solEach: 0.2, disclosed: true } }), ctx);
  assert.equal(!strangers.ok && strangers.code, "undisclosed-wallet");
  const self = checkLaunch(plan({ team: { wallets: [WALLET_1], solEach: 0.2, disclosed: true } }), ctx);
  assert.equal(!self.ok && self.code, "launch-team");
});

test("limits, kill switch and balances apply to launches", () => {
  assert.equal(checkLaunch(plan(), ctx).ok, true);
  const k = checkLaunch(plan(), { ...ctx, limits: { ...limits, killSwitch: true } });
  assert.equal(!k.ok && k.code, "kill-switch");
  assert.equal(checkLaunch(plan({ mode: "manual", devBuySol: 0 }), { ...ctx, limits: { ...limits, killSwitch: true } }).ok, true);
  const big = checkLaunch(plan({ devBuySol: 3 }), ctx);
  assert.equal(!big.ok && big.code, "per-trade-max");
  const cap = checkLaunch(plan({ devBuySol: 1, team: team(4, 1.2) }), ctx);
  assert.equal(!cap.ok && cap.code, "daily-cap");
  const poor = checkLaunch(plan({ team: team(1) }), { ...ctx, balances: { [WALLET_1]: 2, [WALLET_2]: 0.05 } });
  assert.equal(!poor.ok && poor.code, "reserve");
  assert.equal(checkLaunch(plan({ team: team(1) }), { ...ctx, balances: { [WALLET_1]: 2, [WALLET_2]: 0.5 } }).ok, true);
});

test("disclosure is appended to the on-chain description with full addresses", () => {
  const p = plan({ team: team(2) });
  const d = finalDescription(p);
  assert.ok(d.startsWith("A coin for people who trade at 3am."));
  assert.ok(d.includes(WALLET_2) && d.includes(MINT_A), "full addresses");
  assert.match(d, /Team wallets \(disclosed\): 2 wallets bought ~\d+\.\d% of supply at launch, 0\.2 SOL each/);
  assert.equal(finalDescription(plan()), "A coin for people who trade at 3am.");
  const s = summarizePlan(p);
  assert.match(s.teamLine, /^Team holds \d+\.\d% across 2 disclosed wallets$/);
  assert.ok(s.totalSol > 0.9 && s.totalSol < 1, "0.5 dev + 0.4 team + fees");
  const long = plan({ team: team(4), token: { ...plan().token, description: "x".repeat(400) } });
  assert.match(validatePlan(long).map((e) => e.message).join(" "), /disclosure needs/);
  assert.ok(disclosureText(team(4), 12.3).length < 300);
});

test("bundle requests: create + dev buy first (tip on it), then equal team buys", () => {
  const p = plan({ team: team(2, 0.25), jitoTipSol: 0.002, priorityFeeSol: 0.0003 });
  const r = bundleRequests(p, { creator: WALLET_1, mint: MINT_C, metadataUri: "https://ipfs.io/ipfs/x" });
  assert.equal(r.length, 3);
  assert.equal(r[0].action, "create");
  assert.equal(r[0].amount, 0.5);
  assert.equal(r[0].priorityFee, 0.002);
  assert.deepEqual(r.slice(1).map((x) => [x.action, x.publicKey, x.amount, x.priorityFee]), [["buy", WALLET_2, 0.25, 0.0003], ["buy", MINT_A, 0.25, 0.0003]]);
  const m = bundleRequests(plan({ mode: "manual", devBuySol: 0, team: team(2) }), { creator: WALLET_1, mint: MINT_C, metadataUri: "u" });
  assert.equal(m.length, 1);
  assert.equal(m[0].amount, 0);
});

test("chat: launch requests become a draft; stealth tricks are refused", () => {
  const r = parseIntent("launch a coin called Night Owl ($OWL) with a 0.5 SOL dev buy");
  assert.equal(r.kind, "launch");
  if (r.kind === "launch") {
    assert.equal(r.draft.name, "Night Owl");
    assert.equal(r.draft.symbol, "OWL");
    assert.equal(r.draft.devBuySol, 0.5);
    assert.equal(r.draft.mode, "standard");
  }
  const m = parseLaunchRequest("deploy my token $GLINT, no dev buy");
  assert.equal(m?.draft.mode, "manual");
  assert.equal(parseIntent("snipe new launches under 20k with 0.1 SOL").kind, "rule");
  for (const s of ["stealth launch with 4 wallets", "hide the bundle from bubble maps", "avoid bubble maps", "use temp holder wallets", "randomize buys so it looks organic", "make it organic-looking", "set up a market maker bot", "add a front-run layer", "fund fresh wallets from a CEX so they're unlinked"])
    assert.ok(forbiddenIntent(s), `should refuse: ${s}`);
  assert.equal(parseIntent("stealth launch my coin").kind, "refuse");
});

test("v22: a dev buy needs no tip: create + dev buy is one transaction through your RPC", () => {
  const p = plan();
  assert.equal(p.jitoTipSol, 0);
  assert.equal(p.priorityFeeSol, 0);
  assert.deepEqual(validatePlan(p), []);
  assert.equal(launchRoute(p), "rpc");
  assert.equal(effectiveTip(p), 0);
  const r = bundleRequests(p, { creator: WALLET_1, mint: MINT_C, metadataUri: "u" });
  assert.equal(r.length, 1);
  assert.equal(r[0].amount, 0.5);
  assert.equal(r[0].priorityFee, 0);
  const s = summarizePlan(p);
  assert.equal(s.speedSol, 0);
  assert.ok(Math.abs(s.totalSol - (0.5 + s.launchFeeSol)) < 1e-12, "launch fee + dev buy only");
  // an optional tip makes a solo launch a bundle; an optional priority fee goes on the create
  assert.equal(launchRoute(plan({ jitoTipSol: 0.001 })), "bundle");
  assert.equal(bundleRequests(plan({ jitoTipSol: 0.001 }), { creator: WALLET_1, mint: MINT_C, metadataUri: "u" })[0].priorityFee, 0.001);
  assert.equal(bundleRequests(plan({ priorityFeeSol: 0.0002 }), { creator: WALLET_1, mint: MINT_C, metadataUri: "u" })[0].priorityFee, 0.0002);
  assert.match(validatePlan(plan({ jitoTipSol: 0.000001 })).map((e) => e.field).join(), /jitoTipSol/);
});

test("v22: team wallets still go as one Jito bundle, with the automatic tip when none is set", () => {
  const p = plan({ team: team(2, 0.2) });
  assert.equal(launchRoute(p), "bundle");
  assert.equal(effectiveTip(p), AUTO_BUNDLE_TIP_SOL);
  const r = bundleRequests(p, { creator: WALLET_1, mint: MINT_C, metadataUri: "u" });
  assert.equal(r.length, 3);
  assert.equal(r[0].priorityFee, AUTO_BUNDLE_TIP_SOL);
  assert.ok(summarizePlan(p).speedSol >= AUTO_BUNDLE_TIP_SOL);
});

test("v22: quote pair and holder rewards go on the create request only when set (capability config, unverified)", () => {
  const base = bundleRequests(plan(), { creator: WALLET_1, mint: MINT_C, metadataUri: "u" })[0] as unknown as Record<string, unknown>;
  assert.equal(base[PUMPFUN_CAPS.createParams.quote.field], undefined);
  assert.equal(base[PUMPFUN_CAPS.createParams.holderRewards.field], undefined);
  const usdc = PUMPFUN_CAPS.quoteAssets.find((q) => q.id === "USDC")!;
  const p = plan({ token: { ...plan().token, quote: "USDC", creatorFees: "holders" } });
  assert.deepEqual(createParams(p), { [PUMPFUN_CAPS.createParams.quote.field]: usdc.mint!, [PUMPFUN_CAPS.createParams.holderRewards.field]: PUMPFUN_CAPS.createParams.holderRewards.value, [PUMPFUN_CAPS.createParams.creatorFee.field]: "5" });
  const r = bundleRequests(p, { creator: WALLET_1, mint: MINT_C, metadataUri: "u" })[0] as unknown as Record<string, unknown>;
  assert.equal(r[PUMPFUN_CAPS.createParams.quote.field], usdc.mint);
  assert.equal(r.action, "create");
  // v25.1: USD1's mint comes from the on-disk table (data/programs.ts QUOTE_MINTS), never from memory
  assert.equal(createParams(plan({ token: { ...plan().token, quote: "USD1" } }))[PUMPFUN_CAPS.createParams.quote.field], QUOTE_MINTS_USD1);
  assert.deepEqual(unverifiedSettings(PUMPFUN_CAPS, "USDC", "holders"), ["USDC quote pair", "creator rewards to holders", "the USDC creator fee"]);
  assert.deepEqual(unverifiedSettings(PUMPFUN_CAPS, "SOL", "creator"), []);
});

test("v22.1 / v26: creator fee per pair: fixed on SOL, 0.05-1% on custom pairs, sent as basis points", () => {
  assert.equal(feeRange(PUMPFUN_CAPS, "SOL"), null);
  assert.deepEqual(feeRange(PUMPFUN_CAPS, "USDC"), { min: 0.05, max: 1, step: 0.05 });
  const tok = (o: Partial<LaunchPlan["token"]>) => plan({ token: { ...plan().token, ...o } });
  assert.equal(createParams(tok({}))[PUMPFUN_CAPS.createParams.creatorFee.field], undefined, "SOL: no fee field");
  assert.equal(createParams(tok({ creatorFeePct: 0.5 }))[PUMPFUN_CAPS.createParams.creatorFee.field], undefined, "SOL ignores a fee");
  assert.equal(createParams(tok({ quote: "USDC", creatorFeePct: 0.25 }))[PUMPFUN_CAPS.createParams.creatorFee.field], "25");
  assert.deepEqual(validatePlan(tok({ quote: "USD1", creatorFeePct: 1 })), []);
  assert.match(validatePlan(tok({ quote: "USDC", creatorFeePct: 1.5 })).map((e) => e.field).join(), /creatorFeePct/);
  assert.match(validatePlan(tok({ quote: "USDC", creatorFeePct: 0.01 })).map((e) => e.field).join(), /creatorFeePct/);
});

test("v22.1: claims: SOL is the tested collectCreatorFee; a quote token adds its field; totals and coverage", () => {
  assert.deepEqual(claimRequest(WALLET_1, "SOL", PUMPFUN_CAPS), { publicKey: WALLET_1, action: "collectCreatorFee", priorityFee: 0.0001, pool: "pump" });
  const u = claimRequest(WALLET_1, "USDC", PUMPFUN_CAPS) as unknown as Record<string, unknown>;
  assert.equal(u[PUMPFUN_CAPS.claim.quoteField], rewardAsset(PUMPFUN_CAPS, "USDC").mint);
  assert.equal((claimRequest(WALLET_1, "USD1", PUMPFUN_CAPS) as unknown as Record<string, unknown>)[PUMPFUN_CAPS.claim.quoteField], QUOTE_MINTS_USD1, "the on-disk mint, never a guessed one");
  assert.equal(claimVerified("SOL", PUMPFUN_CAPS), true);
  assert.equal(claimVerified("USDC", PUMPFUN_CAPS), false);
  const row = (o: Partial<CreatorFeeRow>): CreatorFeeRow => ({ mint: MINT_A, name: "A", symbol: "A", launchpad: "pumpfun", quote: "SOL", mode: "creator", creator: WALLET_1, signer: "hosted", unclaimed: 0.2, unclaimedSol: 0.2, claimedTotal: 1, claimedTotalSol: 1, lastClaimedAt: null, ...o });
  const rows = [row({}), row({ mint: MINT_B, unclaimed: 0.1, unclaimedSol: 0.1 }), row({ mint: MINT_C, quote: "USDC", unclaimed: 30, unclaimedSol: 0.2 }), row({ mint: WALLET_2, mode: "holders", unclaimed: null, unclaimedSol: null }), row({ mint: "B" + MINT_A.slice(1), signer: "browser" })];
  const t = claimTotals(rows);
  assert.ok(Math.abs(t.claimableSol - 0.5) < 1e-9, `claimable ${t.claimableSol}`);
  assert.equal(t.claimable, 3);
  assert.equal(t.holders, 1);
  // v23: a browser-wallet launch isn't claimed here, so the agent's claim doesn't count it
  assert.deepEqual(claimCovers(rows, MINT_A), [MINT_A, MINT_B], "one SOL claim covers the wallet's SOL coins");
  assert.deepEqual(claimCovers(rows, MINT_C), [MINT_C]);
});

