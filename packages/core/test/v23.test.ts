/**
 * v23: the Claim page's logic (per-asset totals, claim-all groups, coverage, the agent's own rows, chat), the creator
 * fee range on non-SOL pairs (capabilities.ts `creatorFeeRange`; v26: 0.05-1% on custom pairs). v26 removed the swap.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { feePresets, feeRange, planFee, PUMPFUN_CAPS, snapFee, unverifiedSettings } from "../src/launch/capabilities.js";
import { createParams, defaultPlan, validatePlan, type LaunchPlan } from "../src/launch/plan.js";
import {
  canClaimRow, claimableByAsset, claimCovers, claimGroups, claimRequest, claimTotals, parseClaimRequest, rowsFromLaunches,
  type CreatorFeeRow, type LaunchedCoin,
} from "../src/launch/claim.js";
import { parseIntent } from "../src/rules/parse.js";
import { MINT_A, MINT_B, MINT_C, WALLET_1, WALLET_2 } from "./fixtures.js";

const USDC = PUMPFUN_CAPS.quoteAssets.find((q) => q.id === "USDC")!.mint!;
const plan = (t: Partial<LaunchPlan["token"]> = {}): LaunchPlan => {
  const p = defaultPlan();
  return { ...p, token: { ...p.token, name: "Tide Pool", symbol: "TIDE", description: "d", ...t } };
};
const row = (o: Partial<CreatorFeeRow>): CreatorFeeRow => ({
  mint: MINT_A, name: "A", symbol: "A", launchpad: "pumpfun", quote: "SOL", mode: "creator", creator: WALLET_1, signer: "hosted",
  unclaimed: 0.2, unclaimedSol: 0.2, claimedTotal: 0, claimedTotalSol: 0, lastClaimedAt: null, ...o,
});

test("v26: creator fee range: none on SOL, 0.05-1% in 0.05 steps on custom pairs, presets 0.05 / 0.25 / 0.5 / 1 and snapping", () => {
  assert.equal(feeRange(PUMPFUN_CAPS, "SOL"), null, "SOL: fixed by pump.fun, no range");
  for (const q of ["USDC", "USD1", "NVDAx", "SPYx"]) assert.deepEqual(feeRange(PUMPFUN_CAPS, q), { min: 0.05, max: 1, step: 0.05 }, q);
  const r = feeRange(PUMPFUN_CAPS, "USDC")!;
  assert.deepEqual(feePresets(r), [0.05, 0.25, 0.5, 1]);
  assert.equal(snapFee(r, 0.33), 0.35);
  assert.equal(snapFee(r, 0.32), 0.3);
  assert.equal(snapFee(r, 9), 1);
  assert.equal(snapFee(r, 0), 0.05);
  assert.equal(snapFee(r, Number.NaN), 0.05, "not a number: the default (min)");
  assert.equal(planFee(PUMPFUN_CAPS, "SOL", 0.5), null, "a fee on a SOL plan is ignored");
  assert.equal(planFee(PUMPFUN_CAPS, "USDC"), 0.05, "default is the minimum");
  assert.equal(planFee(PUMPFUN_CAPS, "USDC", 0.25), 0.25);
});

test("v26: the create request carries the fee in basis points only on custom pairs; validation keeps the range and step", () => {
  const F = PUMPFUN_CAPS.createParams.creatorFee.field;
  assert.equal(createParams(plan())[F], undefined, "SOL: nothing sent");
  assert.equal(createParams(plan({ creatorFeePct: 0.5 }))[F], undefined, "SOL ignores a stray fee");
  assert.equal(createParams(plan({ quote: "USDC" }))[F], "5", "USDC default 0.05%");
  assert.equal(createParams(plan({ quote: "USDC", creatorFeePct: 0.25 }))[F], "25");
  assert.equal(createParams(plan({ quote: "USD1", creatorFeePct: 1 }))[F], "100");
  assert.equal(createParams(plan({ quote: "USDC", creatorFeePct: 0.5 }))[PUMPFUN_CAPS.createParams.quote.field], USDC);
  for (const ok of [0.05, 0.25, 0.5, 1]) assert.deepEqual(validatePlan(plan({ quote: "USDC", creatorFeePct: ok })), [], `${ok}% is valid`);
  for (const bad of [0.01, 0.07, 1.5, 3]) assert.match(validatePlan(plan({ quote: "USDC", creatorFeePct: bad })).map((e) => e.field).join(), /creatorFeePct/, `${bad}% is refused`);
  assert.deepEqual(validatePlan(plan({ creatorFeePct: 7 })).filter((e) => e.field === "creatorFeePct"), [], "SOL never validates a fee it doesn't send");
  assert.ok(unverifiedSettings(PUMPFUN_CAPS, "USDC", "creator").includes("the USDC creator fee"));
  assert.ok(!unverifiedSettings(PUMPFUN_CAPS, "SOL", "creator").some((x) => /fee/.test(x)));
});

test("v23: claimable per asset (the hero), claim-all groups by asset and wallet, and what one claim covers", () => {
  const rows = [
    row({ mint: MINT_A, symbol: "OWL", unclaimed: 0.4, unclaimedSol: 0.4 }),
    row({ mint: MINT_B, symbol: "DIAL", unclaimed: 0.1, unclaimedSol: 0.1 }),
    row({ mint: MINT_C, symbol: "TIDE", quote: "USDC", unclaimed: 38.4, unclaimedSol: 0.252 }),
    row({ mint: "K" + MINT_C.slice(1), symbol: "KELP", quote: "USDC", unclaimed: 12, unclaimedSol: 0.079 }),
    row({ mint: "L" + MINT_C.slice(1), symbol: "LAMP", quote: "USD1", mode: "holders", unclaimed: null, unclaimedSol: null }),
    row({ mint: "Q" + MINT_C.slice(1), symbol: "QUIET", signer: "browser", unclaimed: 0.02, unclaimedSol: 0.02 }),
    row({ mint: "Z" + MINT_C.slice(1), symbol: "ZERO", unclaimed: 0, unclaimedSol: 0, creator: WALLET_2 }),
  ];
  const byAsset = claimableByAsset(rows);
  assert.deepEqual(byAsset.map((a) => a.asset), ["SOL", "USDC"], "SOL first; holder and browser rows don't count");
  assert.ok(Math.abs(byAsset[0].amount - 0.5) < 1e-9 && byAsset[0].coins === 2);
  assert.ok(Math.abs(byAsset[1].amount - 50.4) < 1e-9 && Math.abs(byAsset[1].sol - 0.331) < 1e-9 && byAsset[1].coins === 2);
  const t = claimTotals(rows);
  assert.equal(t.claimable, 4);
  assert.equal(t.holders, 1);
  const g = claimGroups(rows);
  assert.deepEqual(g.map((x) => [x.asset, x.mints.length]), [["SOL", 2], ["USDC", 2]], "one claim per asset and creator wallet; a zero row isn't claimed");
  assert.deepEqual(g[1].symbols, ["TIDE", "KELP"]);
  assert.ok(Math.abs((g[1].amount ?? 0) - 50.4) < 1e-9);
  assert.deepEqual(claimCovers(rows, MINT_C), [MINT_C, "K" + MINT_C.slice(1)], "a USDC claim names the wallet and asset, so it covers both USDC coins");
  assert.deepEqual(claimGroups(rows, (r) => r.symbol === "KELP").map((x) => x.mints), [["K" + MINT_C.slice(1)]], "a filter picks one coin");
  assert.equal(canClaimRow(row({ unclaimed: null })), true, "an unreported amount can still be claimed");
  assert.equal(canClaimRow(row({ mode: "holders" })), false);
  // a claim request names wallet + asset only (no coin), which is why one claim covers the group
  assert.equal("mint" in claimRequest(WALLET_1, "USDC", PUMPFUN_CAPS), false);
});

test("v23: the agent's own rows come from its launches and claims; unclaimed isn't guessed", () => {
  const launched: LaunchedCoin[] = [
    { mint: MINT_A, name: "Night Owl", symbol: "OWL", launchpad: "pumpfun", quote: "SOL", mode: "creator", creator: WALLET_1, at: 1 },
    { mint: MINT_C, name: "Tide Pool", symbol: "TIDE", launchpad: "pumpfun", quote: "USDC", mode: "creator", creator: WALLET_1, feePct: 2.5, at: 2 },
    { mint: MINT_B, name: "Lantern", symbol: "LAMP", launchpad: "pumpfun", quote: "SOL", mode: "holders", creator: WALLET_1, at: 3 },
  ];
  const claims = [{ at: 1_800_000_000_000, mint: MINT_A, sol: 0.3 }, { at: 1_800_000_100_000, mint: MINT_C, sol: 0.16, asset: "USDC", amount: 25 }];
  const rows = rowsFromLaunches(launched, claims);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].unclaimed, null, "not reported, never invented");
  assert.equal(rows[0].claimedTotal, 0.3);
  assert.equal(rows[1].claimedTotal, 25, "USDC claimed, in USDC");
  assert.equal(rows[1].claimedTotalSol, 0.16);
  assert.equal(rows[1].lastClaimedAt, new Date(1_800_000_100_000).toISOString());
  assert.equal(rows[2].mode, "holders");
  assert.deepEqual(claimGroups(rows).map((x) => x.asset), ["SOL", "USDC"], "holder-reward coins aren't claimed");
});

test("v23/v26: chat: 'claim my fees' (or one coin) is a claim; other sentences aren't; no swap any more", () => {
  const a = parseIntent("claim my fees");
  assert.equal(a.kind, "claim");
  assert.ok(a.kind === "claim" && a.all && !("swap" in a));
  const c = parseClaimRequest("collect fees for $owl");
  assert.equal(c?.symbol, "OWL");
  assert.equal(c?.all, false);
  assert.ok(!parseClaimRequest("claim my creator fees and swap to SOL")?.summary.some((x) => /swap|jupiter/i.test(x)), "the claim summary never mentions a swap");
  assert.equal(parseClaimRequest("snipe anything @x posts and claim fees"), null);
  assert.equal(parseClaimRequest("what are fees on pump.fun?"), null, "no verb, no claim");
  assert.notEqual(parseIntent("launch a coin called Owl ($OWL) with a 0.2 SOL dev buy, then claim creator fees").kind, "claim");
});
