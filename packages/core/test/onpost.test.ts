import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkAutoLaunch, claimIn, defaultLaunchRule, disclaimer, draftToken, enforceHonesty, matchLaunchPost, parseLaunchRuleRequest, parseSellLadder, planFor,
  topWord, validateLaunchRule, type LaunchOnPostRule, type LaunchRecord,
} from "../src/launch/onpost.js";
import { evaluateExit, MCAP_STEP } from "../src/rules/engine.js";
import { parseIntent } from "../src/rules/parse.js";
import type { Position, XPost } from "../src/types.js";

const rule = (o: Partial<LaunchOnPostRule> = {}) => defaultLaunchRule({ id: "lp1", enabled: true, trigger: { handles: ["famous"], requireImage: true }, ...o });
const post = (o: Partial<XPost> = {}): XPost => ({
  id: "1890000000000000001", handle: "famous", text: "my cat discovered the moon tonight https://t.co/x", urls: [], createdAt: new Date().toISOString(),
  media: [{ type: "photo", url: "https://pbs.twimg.com/media/abc.jpg" }], ...o,
});
const NOW = 1_800_000_000_000;

test("trigger matching: account, image, replies/reposts, keywords, metrics", () => {
  assert.equal(matchLaunchPost(rule(), post()).ok, true);
  assert.equal(matchLaunchPost(rule(), post({ handle: "someone" })).ok, false);
  assert.equal(matchLaunchPost(rule(), post({ media: undefined })).ok, false);
  assert.equal(matchLaunchPost(rule({ trigger: { handles: ["famous"], requireImage: false } }), post({ media: undefined })).ok, true);
  for (const k of ["isReply", "isRepost", "isQuote"] as const) assert.equal(matchLaunchPost(rule(), post({ [k]: true })).ok, false);
  assert.equal(matchLaunchPost(rule({ trigger: { handles: ["famous"], requireImage: true, keywords: ["moon"] } }), post()).ok, true);
  assert.equal(matchLaunchPost(rule({ trigger: { handles: ["famous"], requireImage: true, keywords: ["dog"] } }), post()).ok, false);
  const likes = rule({ trigger: { handles: ["famous"], requireImage: true, minLikes: 1000 } });
  assert.equal(matchLaunchPost(likes, post({ metrics: { likes: 10 } })).ok, false);
  const noMetrics = matchLaunchPost(likes, post());
  assert.ok(noMetrics.ok && noMetrics.notes[0].includes("not available"), "filter skipped and said so");
  assert.equal(matchLaunchPost({ ...rule(), enabled: false }, post()).ok, false);
});

test("dedupe: never two coins for the same post", () => {
  const h: LaunchRecord[] = [{ at: NOW - 10 * 3_600_000, ruleId: "other", handle: "famous", postId: post().id, status: "launched", sol: 0.3 }];
  const g = checkAutoLaunch(rule(), post(), { killSwitch: false, history: h, now: NOW });
  assert.equal(!g.ok && g.code, "launch-dedupe");
  const pending = checkAutoLaunch(rule(), post(), { killSwitch: false, history: [{ ...h[0], status: "pending" }], now: NOW });
  assert.equal(!pending.ok && pending.code, "launch-dedupe");
  assert.equal(checkAutoLaunch(rule(), post(), { killSwitch: false, history: [{ ...h[0], status: "skipped" }], now: NOW }).ok, true);
});

test("limits: kill switch, cooldown, per hour/day, SOL per launch/day", () => {
  const rec = (minsAgo: number, id: string, o: Partial<LaunchRecord> = {}): LaunchRecord => ({ at: NOW - minsAgo * 60_000, ruleId: "lp1", handle: "famous", postId: id, status: "launched", sol: 0.3, ...o });
  const k = checkAutoLaunch(rule(), post(), { killSwitch: true, history: [], now: NOW });
  assert.equal(!k.ok && k.code, "kill-switch");
  const cd = checkAutoLaunch(rule(), post(), { killSwitch: false, history: [rec(10, "a")], now: NOW });
  assert.equal(!cd.ok && cd.code, "launch-cooldown");
  const r2 = rule({ limits: { maxPerHour: 2, maxPerDay: 3, maxSolPerLaunch: 1, maxSolPerDay: 3, cooldownMin: 0 } });
  const hour = checkAutoLaunch(r2, post(), { killSwitch: false, history: [rec(10, "a"), rec(20, "b")], now: NOW });
  assert.equal(!hour.ok && hour.code, "launch-rate");
  const day = checkAutoLaunch(r2, post(), { killSwitch: false, history: [rec(100, "a"), rec(200, "b"), rec(300, "c")], now: NOW });
  assert.equal(!day.ok && day.code, "launch-rate");
  const r3 = rule({ plan: { ...rule().plan, devBuySol: 0.5 }, limits: { maxPerHour: 5, maxPerDay: 10, maxSolPerLaunch: 1, maxSolPerDay: 1.2, cooldownMin: 0 } });
  const budget = checkAutoLaunch(r3, post(), { killSwitch: false, history: [rec(100, "a", { sol: 0.5 }), rec(200, "b", { sol: 0.5 })], now: NOW });
  assert.equal(!budget.ok && budget.code, "launch-spend");
  assert.match(validateLaunchRule(rule({ plan: { ...rule().plan, devBuySol: 2 } })).map((e) => e.message).join(), /above your 1 SOL limit/);
});

test("honesty: disclaimer always last, no official claims, X link never the person", () => {
  const d = draftToken(rule({ coin: { ...rule().coin, links: { twitter: "https://x.com/famous" } } }), post(), { name: "Moon Cat", symbol: "MCAT", description: "A cat on the moon." });
  assert.deepEqual(d.errors, []);
  assert.ok(d.token.description.endsWith(disclaimer("famous")));
  assert.equal(d.token.twitter, undefined, "X link to the person is removed");
  assert.equal(d.token.website, "https://x.com/famous/status/1890000000000000001", "the post is the source link");
  const official = draftToken(rule(), post(), { name: "Official Famous Coin", symbol: "FAM", description: "x" });
  assert.equal(official.usedModel, false, "model suggestion with a claim falls back to the template");
  assert.equal(official.token.name, "Discovered");
  assert.ok(claimIn("famous's coin", ["famous"]));
  assert.ok(claimIn("Verified ✓ token", []));
  assert.equal(claimIn("Moon Cat", ["famous"]), null);
  const forced = enforceHonesty({ name: "Real Famous", symbol: "REAL", description: "", quote: "SOL", creatorFees: "creator" }, post());
  assert.ok(forced.errors.length > 0);
  const stripped = enforceHonesty({ name: "Cat", symbol: "CAT", description: `hi\n\n${disclaimer("famous")}`, twitter: "https://x.com/famous/status/1890000000000000001", quote: "SOL", creatorFees: "creator" }, post());
  assert.equal(stripped.token.description.match(/Inspired by/g)?.length, 1, "disclaimer not duplicated");
  assert.equal(stripped.token.twitter, undefined);
  assert.match(validateLaunchRule(rule({ coin: { ...rule().coin, links: { twitter: "https://x.com/famous" } } })).map((e) => e.message).join(), /can't be a watched account/);
  assert.match(validateLaunchRule(rule({ coin: { ...rule().coin, nameTemplate: "Official {Word}" } })).map((e) => e.message).join(), /Refused/);
});

test("templates and plan", () => {
  assert.equal(topWord("gm frens, the lighthouse is open https://t.co/a @someone"), "Lighthouse");
  const d = draftToken(rule({ coin: { ...rule().coin, naming: "template" } }), post(), null);
  assert.equal(d.token.symbol, "DISCOVERED".slice(0, 10));
  const p = planFor(rule({ plan: { ...rule().plan, teamWallets: 2 } }), d.token, ["A1", "A2", "A3"]);
  assert.deepEqual(p.team, { wallets: ["A1", "A2"], solEach: 0.1, disclosed: true });
  assert.equal(planFor(rule({ plan: { ...rule().plan, mode: "manual", devBuySol: 0 } }), d.token, []).devBuySol, 0);
});

test("market-cap ladder, stop and timeout", () => {
  const pos: Position = { mint: "M", symbol: "CAT", wallet: "W", tokens: 1000, costSol: 0.3, avgEntryPriceSol: 0.0003, highestPriceSol: 0.0003, tpDone: [], realizedSol: 0, openedAt: NOW - 60_000 };
  const x = { mcapTargets: [{ atMcapUsd: 100_000, sellPct: 50 }, { atMcapUsd: 250_000, sellPct: 100 }], stopBelowMcapUsd: 5_000, timeoutMin: 720 };
  assert.equal(evaluateExit(pos, x, 0.0003, NOW, 60_000).action, null);
  const a1 = evaluateExit(pos, x, 0.0003, NOW, 120_000).action!;
  assert.deepEqual([a1.kind, a1.sellPct, a1.step], ["mcap", 50, MCAP_STEP]);
  const a2 = evaluateExit({ ...pos, tpDone: [MCAP_STEP] }, x, 0.0003, NOW, 300_000).action!;
  assert.deepEqual([a2.kind, a2.sellPct, a2.step], ["mcap", 100, MCAP_STEP + 1]);
  assert.equal(evaluateExit(pos, x, 0.0003, NOW, 4_000).action?.kind, "mcap-stop");
  assert.equal(evaluateExit({ ...pos, avgEntryPriceSol: 0 }, x, 0.0003, NOW + 721 * 60_000, 60_000).action?.kind, "timeout");
  assert.deepEqual(parseSellLadder("50%@100k,100%@250k"), x.mcapTargets);
  assert.deepEqual(parseSellLadder("half@1m"), [{ atMcapUsd: 1_000_000, sellPct: 50 }]);
  assert.equal(parseSellLadder("50 at lots"), null);
  assert.match(validateLaunchRule(rule({ exit: { mcapTargets: [{ atMcapUsd: 200_000, sellPct: 50 }, { atMcapUsd: 100_000, sellPct: 100 }] } })).map((e) => e.message).join(), /must go up/);
});

test("chat: plain English becomes a launch-on-post rule draft", () => {
  const r = parseIntent("launch a coin whenever @famous posts a picture, 0.3 SOL dev buy, sell half at 100k, rest at 250k");
  assert.equal(r.kind, "launch-rule");
  if (r.kind !== "launch-rule") return;
  assert.deepEqual(r.draft.trigger.handles, ["famous"]);
  assert.equal(r.draft.trigger.requireImage, true);
  assert.equal(r.draft.plan.devBuySol, 0.3);
  assert.deepEqual(r.draft.exit.mcapTargets, [{ atMcapUsd: 100_000, sellPct: 50 }, { atMcapUsd: 250_000, sellPct: 100 }]);
  assert.equal(r.draft.mode, "confirm", "Confirm unless the user asks for auto");
  assert.deepEqual(r.errors, []);
  const auto = parseLaunchRuleRequest("automatically launch a token every time @a posts, dev buy 0.2, stop below 5k");
  assert.equal(auto?.draft.mode, "auto");
  assert.equal(auto?.draft.exit.stopBelowMcapUsd, 5000);
  assert.equal(parseIntent("launch a coin called Night Owl ($OWL) with a 0.5 SOL dev buy").kind, "launch");
});
