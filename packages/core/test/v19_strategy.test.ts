import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPreset, defaultStrategy, exitSpecOf, exportStrategy, importStrategy, normalizeStrategy, STRATEGY_PRESETS, validateStrategy, type StrategySettings,
} from "../src/strategy/settings.js";
import { describeStrategy, fieldOf, getPath, GROUPS, searchFields, setField, STRATEGY_FIELDS } from "../src/strategy/fields.js";
import { earlyVolume, entryBounds, noVolumeDue, scaleInDue, sizeFor, volumeSince, type TradeTick } from "../src/strategy/entry.js";
import { isDevRug, rugCheck, type RugFacts } from "../src/strategy/rug.js";
import { honeypotVerdict, isPumpMint, mintRisks } from "../src/strategy/honeypot.js";
import { checkCanSell, simError } from "../src/strategy/canSell.js";
import { newRogueSession, rogueActive, rogueBought, rogueCanBuy, rogueExits, rogueGuard, rogueLine, rogueMatch, rogueSold } from "../src/strategy/rogue.js";
import { StrategyRunner } from "../src/strategy/runner.js";
import { bundledWallets, insiderWallets, linkableFunding, pulseAudits } from "../src/watch/audits.js";
import { earlyBuyerLabels, type EarlyBuyer } from "../src/coin/traders.js";
import { nonFunderLabel, NON_FUNDERS } from "../src/data/clusterExclude.js";
import { EXCHANGE_WALLETS } from "../src/data/exchanges.js";
import { applyPulse, emptyPulse, type PulseMessage } from "../src/watch/pulse.js";
import { PulseFeed } from "../src/watch/pulseFeed.js";
import { checkTrade, type GuardContext } from "../src/guardrails.js";
import { DEFAULT_LIMITS, type Limits } from "../src/types.js";
import { State } from "../src/state.js";
import { Executor } from "../src/trade/executor.js";
import { adapterFor, launchVia, LaunchpadNotReady } from "../src/launch/adapter.js";
import { makeStonkFunAdapter, stonkFunCreateRequest, STONKFUN_NEEDS } from "../src/launch/stonkfun.js";
import { launchpad } from "../src/launch/launchpads.js";
import { Keypair } from "@solana/web3.js";
import { b58decode } from "../src/base58.js";

// keep market lookups off the network in these tests
process.env.VESK_DEXSCREENER_URL = "http://127.0.0.1:9";
process.env.VESK_JUP_PRICE_URL = "http://127.0.0.1:9";

const ME = "7Gk2PqWm4zXc8Vb1nRt5Hy3JdLs6Ef9Ua2Ko8Ni9fQa";
const OTHER = "9Hq3PqWm4zXc8Vb1nRt5Hy3JdLs6Ef9Ua2Ko8Ni9fQb";
const T = 1_800_000_000_000;

// ---------------------------------------------------------------- settings
test("strategy: defaults are Balanced; presets differ; normalize clamps and fills", () => {
  const d = defaultStrategy();
  assert.equal(d.preset, "balanced");
  assert.equal(d.rug.allowBundled, false, "bundled coins are refused by default");
  assert.equal(d.honeypot.enabled, true, "the can-sell check is on by default");
  assert.equal(d.rogue.honeypot, true, "and on in Rogue mode by default");
  assert.equal(d.mode, "normal");
  for (const id of ["safe", "balanced", "degen", "rogue"] as const) assert.equal(STRATEGY_PRESETS[id].make().preset, id);
  assert.ok(STRATEGY_PRESETS.safe.make().rug.maxDevPct.max < STRATEGY_PRESETS.degen.make().rug.maxDevPct.max);
  const n = normalizeStrategy({ entry: { earlyVolume: { windowSec: 99999, minVolSol: -3 }, size: { mode: "nope", sol: 0 } }, rug: { maxDevPct: { on: true, max: 400 } }, rogue: { ticker: "$moon", keepTop: 7, expectedX: "@Real" }, junk: 1 });
  assert.equal(n.entry.earlyVolume.windowSec, 600);
  assert.equal(n.entry.earlyVolume.minVolSol, 0);
  assert.equal(n.entry.size.mode, "balanced" === "balanced" ? "fixed" : "pct");
  assert.equal(n.entry.size.sol, 0.001);
  assert.equal(n.rug.maxDevPct.max, 100);
  assert.equal(n.rogue.ticker, "MOON");
  assert.equal(n.rogue.keepTop, 2);
  assert.equal(n.rogue.expectedX, "real");
  assert.equal((n as unknown as Record<string, unknown>).junk, undefined);
});

test("strategy: validation refuses what clamping can't fix", () => {
  const s = defaultStrategy();
  s.entry.earlyVolume = { ...s.entry.earlyVolume, minVolSol: 0, minBuys: 0, minBuyers: 0 };
  s.entry.minMcapUsd = 90_000; s.entry.maxMcapUsd = 50_000;
  s.entry.size.sol = 2;
  s.rogue.perCoinSol = 1; s.rogue.budgetSol = 0.5;
  s.mode = "rogue";
  s.rogue.expectedCreator = "not-an-address";
  const e = validateStrategy(s, { perTradeMaxSol: 0.5 }).map((x) => x.field);
  for (const f of ["entry.earlyVolume", "entry.minMcapUsd", "entry.size.sol", "rogue.perCoinSol", "rogue.ticker", "rogue.expectedCreator"]) assert.ok(e.includes(f), f);
  assert.deepEqual(validateStrategy(defaultStrategy(), DEFAULT_LIMITS), []);
});

test("strategy: export / import round trip; an import never starts Rogue mode; presets keep your Rogue target", () => {
  const s = defaultStrategy();
  s.rug.maxTop10Pct.max = 27; s.rogue.ticker = "GLASS";
  const text = exportStrategy({ ...s, mode: "rogue", rogueStartedAt: T });
  assert.ok(!text.includes("rogueStartedAt") && JSON.parse(text).mode === undefined);
  const back = importStrategy(text);
  assert.equal(back.rug.maxTop10Pct.max, 27);
  assert.equal(back.mode, "normal");
  assert.equal(importStrategy('{"rug":{"maxDevPct":{"on":false}}}', s).rug.maxDevPct.on, false);
  assert.throws(() => importStrategy("nope"), /valid JSON/);
  const p = applyPreset({ ...s, mode: "rogue", rogueStartedAt: T }, "safe");
  assert.equal(p.rogue.ticker, "GLASS");
  assert.equal(p.mode, "rogue");
  assert.equal(p.preset, "safe");
  assert.deepEqual(exitSpecOf(defaultStrategy().exits), { takeProfit: [{ atMultiple: 2, sellPct: 50 }, { atMultiple: 4, sellPct: 50 }], stopLossPct: 30, trailingStopPct: 25, timeoutMin: 60 });
});

// ---------------------------------------------------------------- fields
test("fields: every parameter resolves, has help and a group; search finds by words and tags", () => {
  const s = defaultStrategy();
  for (const f of STRATEGY_FIELDS) {
    assert.ok(f.help.length > 20, `${f.key} has help`);
    assert.ok(GROUPS.some((g) => g.id === f.group), `${f.key} group`);
    if (f.key.startsWith("limits.")) assert.ok(f.key.slice(7) in DEFAULT_LIMITS, f.key);
    else assert.notEqual(getPath(s, f.key), undefined, `${f.key} exists in the settings`);
    if (f.on) assert.ok(fieldOf(f.on), `${f.key}'s toggle ${f.on} is a field`);
  }
  assert.equal(new Set(STRATEGY_FIELDS.map((f) => f.key)).size, STRATEGY_FIELDS.length, "keys are unique");
  assert.ok(searchFields("bundle").some((f) => f.key === "rug.allowBundled"));
  assert.ok(searchFields("tp").some((f) => f.key === "exits.takeProfit"));
  assert.ok(searchFields("early volume buyers").some((f) => f.key === "entry.earlyVolume.minBuyers"));
  assert.equal(searchFields("").length, STRATEGY_FIELDS.length);
  const d = describeStrategy(s, DEFAULT_LIMITS);
  assert.equal(d.length, GROUPS.length);
  assert.ok(d.flatMap((g) => g.rows).every((r) => r.value !== "–" && !/undefined|NaN/.test(r.value)));
});

test("fields: setField parses text the CLI and chat send, checks ranges, routes hard limits", () => {
  const s = defaultStrategy();
  const a = setField(s, "entry.earlyVolume.minVolSol", "7.5 sol");
  assert.ok(a.ok && a.strategy.entry.earlyVolume.minVolSol === 7.5 && a.strategy.preset === "custom");
  const b = setField(s, "rug.maxDevPct", "off");
  assert.ok(b.ok && b.strategy.rug.maxDevPct.on === false);
  const c = setField(s, "rug.minHolders", "40");
  assert.ok(c.ok && c.strategy.rug.minHolders.on && c.strategy.rug.minHolders.min === 40);
  const l = setField(s, "exits.takeProfit", "1.5x50, 3x sell 100%");
  assert.ok(l.ok && JSON.stringify(l.strategy.exits.takeProfit) === JSON.stringify([{ atMultiple: 1.5, sellPct: 50 }, { atMultiple: 3, sellPct: 100 }]));
  const m = setField(s, "entry.maxMcapUsd", "$80k");
  assert.ok(m.ok && m.strategy.entry.maxMcapUsd === 80_000);
  const o = setField(s, "exits.stopLossPct", "off");
  assert.ok(o.ok && o.strategy.exits.stopLossPct === null);
  const k = setField(s, "rogue.keepTop", "1");
  assert.ok(k.ok && k.strategy.rogue.keepTop === 1);
  const r = setField(s, "rug.allowBundled", "yes");
  assert.ok(r.ok && r.strategy.rug.allowBundled);
  const bad = setField(s, "entry.earlyVolume.windowSec", "9000");
  assert.ok(!bad.ok && /at most 600/.test(bad.error));
  const nope = setField(s, "rug.maxDevPercent", "5");
  assert.ok(!nope.ok && /No setting/.test(nope.error));
  const lim = setField(s, "limits.maxBuysPerMinute", "4", DEFAULT_LIMITS);
  assert.ok(lim.ok && lim.strategy === s, "the strategy is untouched");
  assert.deepEqual(lim.ok && lim.limits, { maxBuysPerMinute: 4 }, "only the hard limit that changed comes back (the rest stay where they're set)");
});

// ---------------------------------------------------------------- entry
const tick = (dt: number, side: "buy" | "sell", sol: number, wallet: string): TradeTick => ({ at: T + dt * 1000, side, sol, wallet });
test("early-volume trigger: fires the moment all numbers are reached; 'any' fires on one; missed says what it reached", () => {
  const c = { enabled: true, windowSec: 30, minVolSol: 5, minBuys: 4, minBuyers: 3, need: "all" as const };
  const tr = [tick(1, "buy", 1, "a"), tick(2, "buy", 1, "b"), tick(4, "sell", 0.5, "a"), tick(6, "buy", 2, "c"), tick(9, "buy", 1, "a"), tick(40, "buy", 50, "z")];
  const f = earlyVolume(c, T, tr, T + 10_000);
  assert.equal(f.status, "fired");
  assert.equal(f.sec, 9);
  assert.equal(f.reason, "early volume: 5.5 SOL, 4 buys, 3 buyers in 9 s");
  const w = earlyVolume(c, T, tr.slice(0, 2), T + 5_000);
  assert.equal(w.status, "waiting");
  const miss = earlyVolume(c, T, tr.slice(0, 2), T + 31_000);
  assert.equal(miss.status, "missed");
  assert.equal(miss.reason, "early volume: 2 SOL, 2 buys, 2 buyers in 30 s (needs 5 SOL and 4 buys and 3 buyers)");
  assert.equal(earlyVolume({ ...c, need: "any" }, T, tr.slice(0, 2), T + 31_000).status, "missed");
  assert.equal(earlyVolume({ ...c, need: "any", minBuys: 2 }, T, tr.slice(0, 2), T + 3_000).status, "fired");
  // trades after the window never count, even big ones
  assert.equal(earlyVolume({ ...c, minVolSol: 40 }, T, tr, T + 60_000).status, "missed");
});

test("entry: bounds read like the rest of the agent; sizing fixed and % with a cap; scale-in; no-volume exit", () => {
  const e = defaultStrategy().entry;
  assert.equal(entryBounds(e, { mcapUsd: 81_400 }), "mcap $81.4k is above $60k");
  assert.equal(entryBounds(e, { mcapUsd: 3_100 }), "mcap $3.1k is below $5k");
  assert.equal(entryBounds(e, { mcapUsd: 9_000, liquiditySol: 0.4 }), "liquidity 0.40 SOL < 1");
  assert.equal(entryBounds(e, { mcapUsd: 9_000, liquiditySol: 3, ageSec: 900 }), "age 15m is above 10m");
  assert.equal(entryBounds(e, { mcapUsd: 9_000, liquiditySol: 3, ageSec: 30 }), null);
  assert.deepEqual(sizeFor({ mode: "fixed", sol: 0.1, pct: 3, capSol: 0.2 }), { amountSol: 0.1, reason: "0.1 SOL fixed" });
  assert.equal(sizeFor({ mode: "pct", sol: 0.1, pct: 5, capSol: 0.25 }, 2).amountSol, 0.1);
  const capped = sizeFor({ mode: "pct", sol: 0.1, pct: 10, capSol: 0.25 }, 4);
  assert.equal(capped.amountSol, 0.25);
  assert.match(capped.reason, /capped at 0.25 SOL/);
  assert.equal(sizeFor({ mode: "pct", sol: 0.1, pct: 10, capSol: 0.25 }).amountSol, 0);
  const si = { enabled: true, steps: [{ atMultiple: 1.3, addPct: 50 }] };
  assert.equal(scaleInDue(si, { avgEntryPriceSol: 1, firstSol: 0.2, adds: 0 }, 1.2), null);
  assert.deepEqual(scaleInDue(si, { avgEntryPriceSol: 1, firstSol: 0.2, adds: 0 }, 1.35), { step: 0, addSol: 0.1, reason: "scale-in at 1.3x: add 50% (0.1 SOL)" });
  assert.equal(scaleInDue(si, { avgEntryPriceSol: 1, firstSol: 0.2, adds: 1 }, 2), null, "one add per step");
  const tr = [tick(0, "buy", 2, "a"), tick(100, "buy", 0.1, "b")];
  assert.equal(volumeSince(tr, T + 110_000, 30), 0.1);
  assert.equal(noVolumeDue({ enabled: true, windowSec: 60, minVolSol: 0.5 }, T, tr, T + 30_000), null, "not before the window has passed");
  assert.equal(noVolumeDue({ enabled: true, windowSec: 60, minVolSol: 0.5 }, T, tr, T + 120_000), "no volume: 0.1 SOL in 60 s (below 0.5)");
  assert.equal(noVolumeDue({ enabled: false, windowSec: 60, minVolSol: 0.5 }, T, tr, T + 120_000), null);
});

// ---------------------------------------------------------------- rug
test("rug check: each check refuses with its own reason; each can be switched off; bundled can be allowed", () => {
  const c = defaultStrategy().rug;
  const ok: RugFacts = { bundledPct: 5, bundledExact: true, devPct: 3, top10Pct: 20, snipersPct: 4, insidersPct: 2, holders: 40, devLaunches: 1, devRugs: 0, mintRevoked: true, freezeRevoked: true, onCurve: true };
  assert.equal(rugCheck(c, ok).ok, true);
  const cases: Array<[Partial<RugFacts>, string]> = [
    [{ bundledPct: 34 }, "bundled 34% (max 20%)"], [{ devPct: 12 }, "dev holds 12.0% (max 10%)"], [{ top10Pct: 45 }, "top 10 hold 45% (max 30%)"],
    [{ snipersPct: 22 }, "snipers hold 22% (max 15%)"], [{ insidersPct: 18 }, "insiders hold 18% (max 15%)"], [{ holders: 9 }, "9 holders (min 15)"],
    [{ devRugs: 2 }, "dev rugged 2 coins before (max 0)"], [{ devLaunches: 14 }, "dev launched 14 coins before (max 10)"],
    [{ mintRevoked: false }, "mint authority not revoked"], [{ freezeRevoked: false }, "freeze authority not revoked"],
    [{ onCurve: false, lpLocked: false }, "LP not burned or locked"],
  ];
  for (const [f, reason] of cases) assert.equal(rugCheck(c, { ...ok, ...f }).reason, reason);
  assert.equal(rugCheck({ ...c, maxDevPct: { ...c.maxDevPct, on: false } }, { ...ok, devPct: 60 }).ok, true);
  assert.equal(rugCheck({ ...c, allowBundled: true }, { ...ok, bundledPct: 90 }).ok, true);
  assert.equal(rugCheck({ ...c, allowBundled: true }, { ...ok, bundledPct: 90 }).rows.find((r) => r.key === "bundled")?.value, "allowed");
  assert.match(rugCheck(c, { ...ok, bundledPct: 40, bundledExact: false }).reason!, /without funding data/);
  assert.equal(rugCheck({ ...c, enabled: false }, { ...ok, devPct: 90 }).ok, true);
  // unknown numbers: pass by default, refused when you say so
  assert.equal(rugCheck(c, { ...ok, insidersPct: null }).ok, true);
  assert.equal(rugCheck({ ...c, unknown: "refuse" }, { ...ok, insidersPct: null }).reason, "insiders unknown (no funding data yet) (you refuse unknowns)");
  assert.equal(isDevRug(T, 1000, [{ at: T + 60_000, tokens: 850 }]), true);
  assert.equal(isDevRug(T, 1000, [{ at: T + 11 * 60_000, tokens: 1000 }]), false, "after 10 minutes it isn't counted");
});

// ---------------------------------------------------------------- clustering
test("clustering: a pool that sends to many buyers never links them; a real shared funder still does", () => {
  const POOL = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"; // PumpSwap program (data/programs.ts)
  const CURVE = "CurvePda11111111111111111111111111111111111";
  const RAY_AUTH = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
  const VAULT = "Vau1tProgramOwned1111111111111111111111111";
  const BINANCE = Object.keys(EXCHANGE_WALLETS).find((a) => EXCHANGE_WALLETS[a] === "Binance")!;
  const DEV = "Dev1111111111111111111111111111111111111111", FRIEND = "Friend11111111111111111111111111111111111";
  const buyers = ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8"];
  // b1-b3 got their first SOL "from" the pool / curve / Raydium authority (a sell's payout), b4-b5 from Binance,
  // b6 from a program-owned vault, b7 and b8 from the same ordinary wallet (a real link)
  const funding: Record<string, string> = { b1: POOL, b2: CURVE, b3: RAY_AUTH, b4: BINANCE, b5: BINANCE, b6: VAULT, b7: FRIEND, b8: FRIEND, [DEV]: "DevFunder111111111111111111111111111111111" };
  const link = { exclude: [CURVE], programOwned: new Set([VAULT]) };
  const ins = insiderWallets([DEV, ...buyers], DEV, funding, link)!;
  assert.deepEqual([...ins].sort(), ["b7", "b8"], "only the wallets funded by the same person are insiders");
  const bun = bundledWallets([DEV, ...buyers], DEV, funding, link).wallets;
  assert.deepEqual([...bun].sort(), [DEV, "b7", "b8"].sort());
  // without the pool-aware rules the same data would have linked the exchange's customers
  const naive = insiderWallets([DEV, "b4", "b5"], DEV, { b4: BINANCE, b5: BINANCE })!;
  assert.equal(naive.size, 0, "exchange hot wallets are excluded even without a link context");
  const lf = linkableFunding(funding, link);
  assert.equal(Object.keys(lf.funding!).length, 3);
  assert.deepEqual(lf.dropped.map((d) => d.why).sort(), ["Binance hot wallet (labelled)", "Binance hot wallet (labelled)", "PumpSwap (Pump AMM) program", "Raydium AMM v4 authority", "a program-owned account (pool, vault or PDA)", "this coin's curve or pool"].sort());
  // a pool account that shows up as a holder doesn't link anyone either
  assert.equal(nonFunderLabel(POOL), "PumpSwap (Pump AMM) program");
  assert.ok(NON_FUNDERS.TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb);
  // the coin page's Early buyers labels use the same rule
  const early: EarlyBuyer[] = buyers.map((w, i) => ({ rank: i + 1, wallet: w, firstAt: T + 100 + i, boughtSol: 1, boughtTokens: 1, soldTokens: 0, status: "holding" }));
  const labels = earlyBuyerLabels(early, { createdAt: T, dev: DEV, funding, link });
  assert.deepEqual(buyers.filter((w) => labels.get(w)!.labels.includes("insider")), ["b7", "b8"]);
});

test("clustering: Pulse audits drop pool links from enrichment (insiders and bundled)", () => {
  const s = emptyPulse();
  const mint = "Mint1111111111111111111111111111111111pump", dev = "Dev1111111111111111111111111111111111111111";
  applyPulse(s, { txType: "create", mint, name: "Glass", symbol: "GLASS", traderPublicKey: dev, initialBuy: 10_000_000, vSolInBondingCurve: 31, marketCapSol: 30 }, T);
  const buyers = ["w1", "w2", "w3", "w4"];
  for (const w of buyers) applyPulse(s, { txType: "buy", mint, traderPublicKey: w, tokenAmount: 50_000_000, solAmount: 1.5, vSolInBondingCurve: 33, marketCapSol: 32 }, T + 100);
  const POOL = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
  const largest = buyers.map((w) => ({ owner: w, amount: 50_000_000 }));
  const linked = pulseAudits(s, s.tokens[mint], { largest, funding: Object.fromEntries(buyers.map((w) => [w, POOL])) });
  assert.equal(linked.insidersPct, 0, "four buyers paid out by the same pool are not insiders");
  assert.equal(linked.bundledPct, 1, "only the dev's own creation-block buy counts as bundled");
  const real = pulseAudits(s, s.tokens[mint], { largest, funding: Object.fromEntries(buyers.map((w) => [w, "Person11111111111111111111111111111111111"])) });
  assert.equal(real.insidersPct, 20, "the same four funded by one person are insiders (4 × 5%)");
});

// ---------------------------------------------------------------- honeypot
const mintAcc = (ext: Array<Record<string, unknown>> = [], o: { freeze?: string | null; program?: string } = {}) => ({
  value: { owner: o.program === "spl-token" ? "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" : "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", data: { program: o.program ?? "spl-token-2022", parsed: { type: "mint", info: { decimals: 6, supply: "1000000000000000", mintAuthority: null, freezeAuthority: o.freeze ?? null, extensions: ext } } } },
});
test("honeypot: the mint account's extensions and authorities decide, each with a plain reason", () => {
  const c = defaultStrategy().honeypot;
  const HOOK = "HookProgram1111111111111111111111111111111";
  const cases: Array<[unknown, string]> = [
    [mintAcc([{ extension: "nonTransferable" }]), "can't sell: the token is non-transferable"],
    [mintAcc([{ extension: "pausableConfig", state: { authority: "x", paused: true } }]), "can't sell: transfers are paused by the issuer"],
    [mintAcc([{ extension: "defaultAccountState", state: { accountState: "frozen" } }]), "can't sell: new token accounts start frozen"],
    [mintAcc([{ extension: "transferHook", state: { authority: "x", programId: HOOK } }]), "transfer hook (program Hook…1111) can block sells"],
    [mintAcc([{ extension: "permanentDelegate", state: { delegate: "Delegate1111111111111111111111111111111111" } }]), "permanent delegate Dele…1111 can take tokens from any wallet"],
    [mintAcc([], { freeze: "Freezer111111111111111111111111111111111111", program: "spl-token" }), "freeze authority set: the issuer can freeze your tokens"],
    [mintAcc([{ extension: "transferFeeConfig", state: { newerTransferFee: { transferFeeBasisPoints: 1200 }, olderTransferFee: { transferFeeBasisPoints: 1200 } } }]), "transfer tax 12% (max 5%)"],
  ];
  for (const [acc, reason] of cases) assert.equal(honeypotVerdict(c, mintRisks(acc)!).reason, reason);
  const fine = honeypotVerdict(c, mintRisks(mintAcc([{ extension: "transferFeeConfig", state: { newerTransferFee: { transferFeeBasisPoints: 100 } } }]))!);
  assert.ok(fine.ok && fine.notes.includes("transfer tax 1%"));
  assert.equal(honeypotVerdict({ ...c, refuseTransferHook: false }, mintRisks(mintAcc([{ extension: "transferHook", state: { programId: HOOK } }]))!).ok, true);
  assert.equal(mintRisks({ value: null }), null);
  const r = mintRisks(mintAcc([], { program: "spl-token" }))!;
  assert.equal(honeypotVerdict(c, r, { route: false, simulated: false }).reason, "can't sell: no sell route (Jupiter has no quote back to SOL)");
  assert.equal(honeypotVerdict(c, r, { route: true, simulated: true, ok: false, error: "account is frozen" }).reason, "can't sell: a holder's sell failed in simulation (account is frozen)");
  assert.ok(honeypotVerdict(c, r, { route: true, simulated: false }).notes.some((n) => /not simulated/.test(n)));
  assert.equal(isPumpMint("Abcpump"), true);
  assert.equal(isPumpMint("Abcpump", "letsbonk"), false, "the feed's protocol beats the vanity suffix");
  assert.equal(simError({ InstructionError: [2, { Custom: 6001 }] }, ["Program log: Instruction: Swap", "Program log: Error: transfer not allowed by hook"]), "Error: transfer not allowed by hook");
});

test("honeypot: checkCanSell simulates a real holder's sell (not the pool's), refuses a failing one, notes a missing holder", async () => {
  const c = defaultStrategy().honeypot;
  const MINT = "Tok22Mint11111111111111111111111111111111x";
  const POOLOWNER = "PoolPda111111111111111111111111111111111111", HOLDER = "Holder1111111111111111111111111111111111111";
  const calls: string[] = [];
  let simErr: unknown = null;
  const rpc = {
    call: async (m: string, p: unknown[]) => {
      calls.push(m);
      if (m === "getAccountInfo") return mintAcc([], { program: "spl-token" });
      if (m === "getTokenLargestAccounts") return { value: [{ address: "acc1", amount: "900000000", uiAmount: 900 }, { address: "acc2", amount: "100000000", uiAmount: 100 }] };
      if (m === "getMultipleAccounts" && (p[1] as { encoding: string }).encoding === "jsonParsed") return { value: [{ data: { parsed: { info: { owner: POOLOWNER, tokenAmount: { amount: "900000000" } } } } }, { data: { parsed: { info: { owner: HOLDER, tokenAmount: { amount: "100000000" } } } } }] };
      if (m === "getMultipleAccounts") return { value: [{ owner: "PoolProgram1111111111111111111111111111111" }, { owner: "11111111111111111111111111111111" }] };
      if (m === "simulateTransaction") return { value: { err: simErr, logs: simErr ? ["Program log: Error: AccountFrozen"] : [] } };
      throw new Error(m);
    },
  } as unknown as Parameters<typeof checkCanSell>[0];
  const quoted: Array<{ amount: bigint }> = [];
  const quote = (async (q: { amount: bigint }) => { quoted.push(q); return { outAmount: "1234", inAmount: String(q.amount) }; }) as unknown as NonNullable<Parameters<typeof checkCanSell>[3]>["quote"];
  const swapFor: string[] = [];
  const swap = (async (s: { userPublicKey: string }) => { swapFor.push(s.userPublicKey); return "AAAA"; }) as unknown as NonNullable<Parameters<typeof checkCanSell>[3]>["swap"];
  const ok = await checkCanSell(rpc, MINT, c, { quote, swap });
  assert.equal(ok.ok, true, ok.reason ?? "");
  assert.deepEqual(swapFor, [HOLDER], "the sell is simulated for the System-owned holder, not the pool");
  assert.equal(quoted[0].amount, 10_000_000n, "10% of the holder's tokens");
  assert.ok(calls.includes("simulateTransaction"));
  simErr = { InstructionError: [3, { Custom: 17 }] };
  const bad = await checkCanSell(rpc, MINT, c, { quote, swap });
  assert.equal(bad.reason, "can't sell: a holder's sell failed in simulation (Error: AccountFrozen)");
  const noRoute = await checkCanSell(rpc, MINT, c, { quote: (async () => { throw new Error("no route"); }) as never, swap });
  assert.equal(noRoute.reason, "can't sell: no sell route (Jupiter has no quote back to SOL)");
  const off = await checkCanSell(rpc, MINT, { ...c, simulate: false }, { quote, swap });
  assert.ok(off.ok && !off.sell);
});

// ---------------------------------------------------------------- guardrails
const limits: Limits = { ...DEFAULT_LIMITS, perTradeMaxSol: 1, dailySpendCapSol: 5, maxOpenPositions: 10, maxBuysPerDay: 50, minSolReserve: 0, maxBuysPerMinute: 3 };
const ctx = (o: Partial<GuardContext> = {}): GuardContext => ({ limits, ownWallets: [ME, OTHER], spentTodaySol: 0, buysToday: 0, openPositions: 0, recentFills: [], now: T, ...o });
test("guardrails: buys per minute; Rogue buys are held to the session's size, coins and budget; the never-list still applies", () => {
  const buy = (o: Record<string, unknown> = {}) => ({ action: "buy" as const, wallet: ME, mint: "MintA", amountSol: 0.05, reason: "x", ...o });
  const fills = [0, 10, 20].map((s) => ({ at: T - s * 1000, mint: `M${s}`, side: "buy" as const, wallet: ME, amountSol: 0.1 }));
  assert.deepEqual(checkTrade(buy(), ctx({ recentFills: fills })), { ok: false, code: "buys-per-minute", reason: "Hit the 3 buys per minute limit." });
  assert.equal(checkTrade(buy(), ctx({ recentFills: fills.map((f) => ({ ...f, at: f.at - 61_000 })) })).ok, true);
  const rg = { perCoinSol: 0.05, budgetSol: 0.12, spentSol: 0, coins: 0, maxCoins: 3, mints: [] as string[] };
  assert.equal(checkTrade(buy({ rogue: true }), ctx()).ok, false, "a Rogue buy without a session is refused");
  assert.equal((checkTrade(buy({ rogue: true }), ctx()) as { code: string }).code, "rogue-off");
  assert.equal(checkTrade(buy({ rogue: true }), ctx({ rogue: rg })).ok, true);
  assert.match((checkTrade(buy({ rogue: true, amountSol: 0.2 }), ctx({ rogue: rg })) as { reason: string }).reason, /above the Rogue size/);
  assert.match((checkTrade(buy({ rogue: true }), ctx({ rogue: { ...rg, coins: 3, mints: ["a", "b", "c"] } })) as { reason: string }).reason, /3\/3 coins/);
  assert.match((checkTrade(buy({ rogue: true }), ctx({ rogue: { ...rg, spentSol: 0.1 } })) as { reason: string }).reason, /Rogue budget: 0.1 of 0.12 SOL/);
  // the kill switch and one wallet per coin hold in Rogue mode too
  assert.equal((checkTrade(buy({ rogue: true }), ctx({ rogue: rg, limits: { ...limits, killSwitch: true } })) as { code: string }).code, "kill-switch");
  const other = [{ at: T - 5000, mint: "MintA", side: "buy" as const, wallet: OTHER, amountSol: 0.05 }];
  assert.equal((checkTrade(buy({ rogue: true }), ctx({ rogue: rg, recentFills: other })) as { code: string }).code, "multi-wallet");
  assert.equal((checkTrade(buy({ rogue: true, reason: "rogue wash trade loop" }), ctx({ rogue: rg })) as { code: string }).code, "forbidden-action");
});

// ---------------------------------------------------------------- rogue
test("rogue: matches the ticker or a keyword, marks the expected coin, holds the budget, cuts the losers", () => {
  const r = { ...defaultStrategy().rogue, ticker: "MOON", keywords: ["moon cat"], expectedCreator: "Creator111111111111111111111111111111111111", perCoinSol: 0.05, budgetSol: 0.12, maxCoins: 3, stallSec: 20, stallMinVolSol: 0.3, stopLossPct: 35, leaderAfterSec: 60, keepTop: 1 as const };
  assert.deepEqual(rogueMatch(r, { symbol: "moon", name: "Moon" }), { match: true, why: "ticker $MOON matches", expected: false });
  assert.equal(rogueMatch(r, { symbol: "MCAT", name: "The Moon Cat" }).why, 'name has "moon cat"');
  assert.equal(rogueMatch(r, { symbol: "MOON", name: "x", creator: r.expectedCreator }).expected, true);
  assert.equal(rogueMatch(r, { symbol: "SUN", name: "Sun" }).match, false);
  let s = newRogueSession(r, T);
  assert.equal(s.endsAt, T + r.windowMin * 60_000);
  assert.deepEqual(rogueCanBuy(r, s, "A", T + 1000), { ok: true, amountSol: 0.05 });
  s = rogueBought(s, { mint: "A", symbol: "MOON", boughtAt: T, sol: 0.05 });
  s = rogueBought(s, { mint: "B", symbol: "MOON", boughtAt: T, sol: 0.05, expected: true });
  assert.deepEqual(rogueCanBuy(r, s, "A", T + 1000), { ok: false, reason: "already bought in this Rogue session" });
  assert.deepEqual(rogueCanBuy(r, s, "C", T + 1000), { ok: false, reason: "Rogue budget: 0.1 of 0.12 SOL spent" });
  assert.deepEqual(rogueCanBuy(r, s, "C", s.endsAt), { ok: false, reason: "Rogue window is over" });
  assert.deepEqual(rogueGuard(r, s), { perCoinSol: 0.05, budgetSol: 0.12, spentSol: 0.1, coins: 2, maxCoins: 3, mints: ["A", "B"] });
  s = rogueBought(s, { mint: "C", symbol: "MOON", boughtAt: T, sol: 0.02 });
  // A stalls, C falls through the stop-loss, B (expected) is kept even though it lags
  const x = rogueExits(r, s, { A: { mint: "A", mcapUsd: 40_000, priceMult: 1.1, volSol: 0.1 }, B: { mint: "B", mcapUsd: 9_000, priceMult: 1, volSol: 2 }, C: { mint: "C", mcapUsd: 12_000, priceMult: 0.6, volSol: 1 } }, T + 30_000);
  assert.deepEqual(x.map((e) => [e.mint, e.kind]), [["A", "stall"], ["C", "sl"]]);
  assert.equal(x[0].reason, "volume stalled: 0.1 SOL in 20 s");
  // after the leader time, every coin but the top one by market cap goes (not the expected one)
  s = { ...s, coins: [...s.coins, { mint: "D", symbol: "MOON", boughtAt: T, sol: 0.01 }] };
  const y = rogueExits(r, s, { A: { mint: "A", mcapUsd: 40_000, priceMult: 1.1, volSol: 1 }, B: { mint: "B", mcapUsd: 9_000, priceMult: 1, volSol: 2 }, C: { mint: "C", mcapUsd: 12_000, priceMult: 0.9, volSol: 1 }, D: { mint: "D", mcapUsd: 20_000, priceMult: 1.2, volSol: 1 } }, T + 61_000);
  assert.deepEqual(y.map((e) => [e.mint, e.kind]), [["C", "laggard"], ["D", "laggard"]]);
  assert.match(y[0].reason, /not in the top 1 by market cap after 60 s/);
  s = rogueSold(s, "A", "stalled", T + 31_000);
  assert.ok(s.coins.find((c) => c.mint === "A")!.sold);
  const line = rogueLine(r, s, T + 4 * 60_000 + 48_000);
  assert.equal(line.text, "Rogue mode · $MOON · 4/3 coins · budget 0.12/0.12 SOL");
  assert.equal(line.left, "5:12");
  const st = { ...defaultStrategy(), mode: "rogue" as const, rogueStartedAt: T };
  assert.equal(rogueActive(st, T + 1000), true);
  assert.equal(rogueActive(st, T + st.rogue.windowMin * 60_000), false);
});

// ---------------------------------------------------------------- the runner, end to end in memory
async function runnerRig(s: StrategySettings) {
  const state = await new State(await mkdtemp(join(tmpdir(), "vesk-v19s-"))).load();
  state.data.status = "online";
  let now = T;
  const lim: Limits = { ...DEFAULT_LIMITS, perTradeMaxSol: 1, dailySpendCapSol: 5, maxOpenPositions: 10, maxBuysPerDay: 50, minSolReserve: 0, maxBuysPerMinute: 20 };
  const rpc = { getBalanceSol: async () => 3, getTokenBalances: async () => [], call: async () => null } as unknown as ConstructorParameters<typeof Executor>[0]["rpc"];
  const wallet = { publicKey: { toBase58: () => ME } } as unknown as ConstructorParameters<typeof Executor>[0]["wallet"];
  let settings = s;
  const feed = new PulseFeed({});
  // eslint-disable-next-line prefer-const
  let runner: StrategyRunner;
  const ex = new Executor({ rpc, wallet, state, limits: () => lim, defaultPriorityFeeSol: 0.0001, paper: true, rogue: () => { const ses = state.data.rogue; return ses && rogueActive(settings, now) ? rogueGuard(settings.rogue, ses) : undefined; } });
  let ended = false;
  runner = new StrategyRunner({
    rpc, state, executor: () => ex, address: () => ME, settings: () => settings, paused: () => false, feed, now: () => now, solUsd: async () => 150,
    tradeParams: async () => ({ slippageBps: 1500, priorityFeeSol: 0.0001, jitoOnly: false, mev: "off" }),
    endRogue: async () => { ended = true; settings = { ...settings, mode: "normal", rogueStartedAt: undefined }; },
  });
  const push = (m: PulseMessage) => { const r = applyPulse(feed.state, m, now); runner.onMessage(m, !!r.isNew); };
  return { state, runner, push, feed, set: (x: StrategySettings) => { settings = x; }, at: (t: number) => { now = t; }, ended: () => ended, settle: () => new Promise((r) => setTimeout(r, 120)) };
}
const create = (mint: string, symbol: string, name = symbol, dev = "Dev1111111111111111111111111111111111111111"): PulseMessage => ({ txType: "create", mint, name, symbol, traderPublicKey: dev, initialBuy: 10_000_000, solAmount: 0.3, vSolInBondingCurve: 31, marketCapSol: 60, pool: "pump" });
const trade = (mint: string, side: "buy" | "sell", sol: number, who: string): PulseMessage => ({ txType: side, mint, traderPublicKey: who, solAmount: sol, tokenAmount: 1_000_000, vSolInBondingCurve: 40, marketCapSol: 60 });

test("runner: the early-volume trigger fires and the coin is bought with the strategy's exits; a quiet coin is filtered with its numbers", async () => {
  const s = defaultStrategy();
  s.entry.autoNewCoins = true;
  s.entry.earlyVolume = { enabled: true, windowSec: 10, minVolSol: 3, minBuys: 3, minBuyers: 3, need: "all" };
  s.entry.minMcapUsd = null; s.entry.maxMcapUsd = null; s.entry.minLiquiditySol = null;
  s.rug.enrich = false; s.rug.minHolders.on = false;
  const g = await runnerRig(s);
  try {
    g.runner.sync();
    const HOT = "HotMint111111111111111111111111111111111pump", COLD = "ColdMint11111111111111111111111111111111pump";
    g.push(create(HOT, "HOT")); g.push(create(COLD, "COLD"));
    await g.settle();
    g.at(T + 2000); g.push(trade(HOT, "buy", 1, "a")); g.push(trade(COLD, "buy", 0.2, "q"));
    g.at(T + 3000); g.push(trade(HOT, "buy", 1.2, "b"));
    g.at(T + 4000); g.push(trade(HOT, "buy", 1, "c"));
    await g.runner.tick(); await g.settle();
    const pos = g.state.data.positions.find((p) => p.mint === HOT);
    assert.ok(pos, "the hot coin was bought (paper)");
    assert.deepEqual(pos!.exit?.takeProfit, s.exits.takeProfit, "with the strategy's exits armed");
    const hot = g.state.data.pipeline.filter((e) => e.mint === HOT).map((e) => `${e.stage}:${e.outcome}`);
    for (const st of ["watch:start", "watch:pass", "check:start", "size:pass", "check:pass", "execute:done", "exit:pass"]) assert.ok(hot.includes(st), st);
    assert.match(g.state.data.pipeline.find((e) => e.mint === HOT && e.stage === "watch" && e.outcome === "pass")!.reason!, /^early volume: 3.2 SOL, 3 buys, 3 buyers in 4 s$/);
    g.at(T + 11_000); await g.runner.tick();
    const miss = g.state.data.pipeline.find((e) => e.mint === COLD && e.stage === "check");
    assert.equal(miss?.outcome, "fail");
    assert.equal(miss?.reason, "early volume: 0.2 SOL, 1 buy, 1 buyer in 10 s (needs 3 SOL and 3 buys and 3 buyers)");
    assert.ok(!g.state.data.positions.some((p) => p.mint === COLD));
    // the no-volume exit: nothing traded on HOT for the window → sold
    g.at(T + 4000 + s.exits.noVolume.windowSec * 1000 + 1000); await g.runner.tick(); await g.settle();
    assert.ok(!g.state.data.positions.some((p) => p.mint === HOT), "sold on no volume");
    assert.ok(g.state.data.activity.some((a) => /HOT: no volume: 0 SOL in 120 s/.test(a.message)));
  } finally { g.runner.stop(); }
});

test("runner: a rug-check refusal shows its reason and nothing is bought", async () => {
  const s = defaultStrategy();
  s.entry.autoNewCoins = true; s.entry.earlyVolume.enabled = false;
  s.entry.minMcapUsd = null; s.entry.maxMcapUsd = null; s.entry.minLiquiditySol = null;
  s.rug.enrich = false; s.rug.minHolders.on = false; s.rug.maxBundledPct.on = false;
  const g = await runnerRig(s);
  try {
    g.runner.sync();
    const BIG = "BigDev11111111111111111111111111111111111pump";
    g.push({ ...create(BIG, "BIG"), initialBuy: 300_000_000 });
    await g.settle(); await g.settle();
    const f = g.state.data.pipeline.find((e) => e.mint === BIG && e.stage === "check" && e.outcome === "fail");
    assert.equal(f?.reason, "dev holds 30.0% (max 10%)");
    assert.equal(g.state.data.positions.length, 0);
  } finally { g.runner.stop(); }
});

test("runner: a Rogue session buys every match up to the budget, skips the soft filters, sells the stalled ones, then ends", async () => {
  const s = defaultStrategy();
  s.mode = "rogue"; s.rogueStartedAt = T;
  s.rogue = { ...s.rogue, ticker: "MOON", windowMin: 1, maxCoins: 5, perCoinSol: 0.05, budgetSol: 0.1, stallSec: 5, stallMinVolSol: 0.5, leaderAfterSec: 0, keepTop: 0 };
  s.entry.autoNewCoins = false;
  const g = await runnerRig(s);
  try {
    g.runner.sync();
    assert.ok(g.state.data.rogue, "the session started");
    const coins = ["M1111111111111111111111111111111111111pump", "M2222222222222222222222222222222222222pump", "M3333333333333333333333333333333333333pump"];
    // a heavy dev bag would fail the rug check; Rogue mode skips it
    for (const m of coins) { g.push({ ...create(m, "MOON"), initialBuy: 400_000_000 }); await g.settle(); await g.settle(); }
    g.push(create("SunMint1111111111111111111111111111111pump", "SUN")); await g.settle();
    const bought = g.state.data.positions.map((p) => p.mint).sort();
    assert.deepEqual(bought, coins.slice(0, 2).sort(), "two matches bought: 0.1 SOL budget at 0.05 each");
    assert.equal(g.state.data.rogue!.spentSol, 0.1);
    const third = g.state.data.pipeline.find((e) => e.mint === coins[2] && e.stage === "check");
    assert.equal(third?.reason, "Rogue budget: 0.1 of 0.1 SOL spent");
    assert.ok(!g.state.data.pipeline.some((e) => e.symbol === "SUN" && e.stage === "size"), "the non-match isn't touched");
    // coin 1 keeps trading, coin 2 goes quiet
    g.at(T + 3000); g.push(trade(coins[0], "buy", 0.4, "x")); g.at(T + 5000); g.push(trade(coins[0], "buy", 0.4, "y"));
    g.at(T + 6000); await g.runner.tick(); await g.settle();
    const held = g.state.data.positions.map((p) => p.mint);
    assert.ok(held.includes(coins[0]), "the active coin is kept");
    assert.ok(!held.includes(coins[1]), "the stalled coin is sold");
    assert.equal(g.state.data.rogue!.coins.find((c) => c.mint === coins[1])!.sold!.reason, "volume stalled: 0 SOL in 5 s");
    // the window ends: the mode goes back to normal; the open coin's exits keep running
    g.at(T + 58_000); g.push(trade(coins[0], "buy", 0.6, "z"));
    g.at(T + 61_000); await g.runner.tick();
    assert.equal(g.ended(), true);
    assert.ok(g.state.data.activity.some((a) => /Rogue window over: bought 2 coins for 0.1 SOL, 1 still open/.test(a.message)));
  } finally { g.runner.stop(); }
});

// ---------------------------------------------------------------- launchpads
test("launchpads: StonkFun is a scaffold: 'soon', refuses to run, says what's needed; pump.fun is behind the same interface", async () => {
  assert.equal(launchpad("stonkfun").status, "soon");
  assert.equal(adapterFor("pumpfun")?.status, "ready");
  const sf = adapterFor("stonkfun")!;
  assert.equal(sf.status, "soon");
  assert.deepEqual(sf.needs, STONKFUN_NEEDS);
  const plan = { launchpad: "stonkfun" as const, mode: "standard" as const, token: { name: "Glass", symbol: "glass", description: "d", quote: "SOL" as const, creatorFees: "creator" as const }, devBuySol: 0.1, jitoTipSol: 0.001, priorityFeeSol: 0.0005, slippagePct: 10 };
  await assert.rejects(() => launchVia({ rpc: {} as never, plan, creator: Keypair.generate(), signerOf: () => Keypair.generate(), image: { bytes: new Uint8Array([1]), mime: "image/png", filename: "a.png" }, jitoEngine: "" }), (e: Error) => e instanceof LaunchpadNotReady && /program ID/.test(e.message));
  assert.deepEqual(stonkFunCreateRequest(plan, { creator: "C", mint: "M", metadataUri: "u" }), { creator: "C", mint: "M", name: "Glass", symbol: "GLASS", metadataUri: "u", devBuySol: 0.1, slippagePct: 10, priorityFeeSol: 0.0005 });
});

/** A legacy transaction (unsigned) whose signers are `signers` and whose one instruction calls `program`. */
function legacyTx(signers: string[], program: string): string {
  const keys = [...signers, program].map((k) => b58decode(k)!);
  const sv = (n: number) => { const o: number[] = []; for (;;) { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; o.push(b); if (!n) return o; } };
  const msg = [signers.length, 0, 1, ...sv(keys.length), ...keys.flatMap((k) => [...k]), ...new Array(32).fill(7), ...sv(1), keys.length - 1, ...sv(1), 0, ...sv(1), 9];
  return Buffer.from([...sv(signers.length), ...new Array(64 * signers.length).fill(0), ...msg]).toString("base64");
}
test("launchpads: the StonkFun flow against mocks: checks the program before signing, signs with the creator and the mint", async () => {
  const PROGRAM = Keypair.generate().publicKey.toBase58(); // a mock program, not StonkFun's (unknown)
  const creator = Keypair.generate();
  const sent: string[] = [];
  let callProgram = PROGRAM;
  const fetchMock = (async (url: string, init: { body: unknown }) => {
    if (url === "mock://meta") return { ok: true, status: 200, json: async () => ({ metadataUri: "ipfs://mock" }) };
    const req = JSON.parse(String(init.body)) as { creator: string; mint: string; symbol: string };
    assert.equal(req.symbol, "GLASS");
    return { ok: true, status: 200, json: async () => ({ transaction: legacyTx([req.creator, req.mint], callProgram) }) };
  }) as unknown as typeof fetch;
  const ad = makeStonkFunAdapter({ programId: PROGRAM, metadataUrl: "mock://meta", createUrl: "mock://create" }, { fetch: fetchMock });
  assert.equal(ad.status, "ready", "only with confirmed values injected (tests)");
  const rpc = { sendRawTransaction: async (b64: string) => { sent.push(b64); return "sig_mock"; }, confirm: async () => ({ ok: true, ms: 5 }) } as never;
  const plan = { launchpad: "stonkfun" as const, mode: "standard" as const, token: { name: "Glass", symbol: "glass", description: "d", quote: "SOL" as const, creatorFees: "creator" as const }, devBuySol: 0.1, jitoTipSol: 0.001, priorityFeeSol: 0.0005, slippagePct: 10 };
  const args = { rpc, plan, creator, signerOf: () => creator, image: { bytes: new Uint8Array([1, 2]), mime: "image/png", filename: "a.png" }, jitoEngine: "" };
  const r = await ad.launch(args);
  assert.equal(r.signature, "sig_mock");
  assert.equal(r.metadataUri, "ipfs://mock");
  assert.equal(sent.length, 1);
  const raw = Buffer.from(sent[0], "base64");
  assert.equal(raw[0], 2, "two signatures");
  assert.ok(raw.subarray(1, 65).some((b) => b !== 0) && raw.subarray(65, 129).some((b) => b !== 0), "both signed");
  callProgram = Keypair.generate().publicKey.toBase58();
  await assert.rejects(() => ad.launch(args), /doesn't call the StonkFun program. Nothing was signed/);
  assert.equal(sent.length, 1, "nothing sent");
  await assert.rejects(() => ad.launch({ ...args, plan: { ...plan, team: { wallets: [ME], solEach: 0.1 } } as never }), /Team wallets aren't supported/);
});

// ---------------------------------------------------------------- chat, docs
import { applyStrategyChat, parseStrategyRequest } from "../src/strategy/chat.js";
import { parseIntent } from "../src/rules/parse.js";
import { readFileSync } from "node:fs";
test("chat: strategy requests become patches you confirm; rogue mode needs a target; other requests aren't taken", () => {
  const a = parseStrategyRequest("only buy if it does 5 sol and 20 buys in the first 30 seconds")!;
  assert.equal(a.kind, "strategy");
  assert.deepEqual(a.patches, [{ key: "entry.earlyVolume.enabled", value: "on" }, { key: "entry.earlyVolume.windowSec", value: "30" }, { key: "entry.earlyVolume.minVolSol", value: "5" }, { key: "entry.earlyVolume.minBuys", value: "20" }, { key: "entry.earlyVolume.need", value: "all" }]);
  const r = applyStrategyChat(defaultStrategy(), a, DEFAULT_LIMITS);
  assert.ok(r.ok && r.strategy.entry.earlyVolume.minBuys === 20 && r.strategy.entry.earlyVolume.windowSec === 30);
  assert.deepEqual(parseStrategyRequest("max dev 8%")!.kind === "strategy" && (parseStrategyRequest("max dev 8%") as { patches: unknown }).patches, [{ key: "rug.maxDevPct", value: "8" }]);
  assert.deepEqual((parseStrategyRequest("allow bundled coins") as { patches: unknown }).patches, [{ key: "rug.allowBundled", value: "on" }]);
  assert.deepEqual((parseStrategyRequest("honeypot check off") as { patches: unknown }).patches, [{ key: "honeypot.enabled", value: "off" }]);
  assert.deepEqual((parseStrategyRequest("sell if no volume for 2 minutes") as { patches: unknown }).patches, [{ key: "exits.noVolume.enabled", value: "on" }, { key: "exits.noVolume.windowSec", value: "120" }]);
  const lim = applyStrategyChat(defaultStrategy(), parseStrategyRequest("max 4 buys per minute")!, DEFAULT_LIMITS);
  assert.ok(lim.ok && lim.limits?.maxBuysPerMinute === 4);
  const p = parseStrategyRequest("use the safe preset")!;
  assert.ok(p.kind === "strategy" && p.preset === "safe");
  const rg = parseStrategyRequest("rogue mode $ORBIT 0.05 sol each, budget 1 sol, 10 coins")!;
  assert.ok(rg.kind === "rogue" && rg.start && !rg.errors.length);
  const started = applyStrategyChat(defaultStrategy(), rg, DEFAULT_LIMITS, T);
  assert.ok(started.ok && started.strategy.mode === "rogue" && started.strategy.rogueStartedAt === T && started.strategy.rogue.ticker === "ORBIT" && started.strategy.rogue.budgetSol === 1 && started.strategy.rogue.maxCoins === 10);
  assert.equal((parseStrategyRequest("rogue mode please") as { errors: string[] }).errors[0], "Rogue mode needs a target: a $TICKER or name keywords.");
  assert.equal((parseStrategyRequest("stop rogue mode") as { start: boolean }).start, false);
  // the existing parsers keep their phrasings
  assert.equal(parseIntent("snipe anything @junopark posts under 50k mcap with 0.5 SOL").kind, "rule");
  assert.equal(parseIntent("snipe new launches with max dev 5% and 0.1 sol").kind, "rule");
  assert.equal(parseIntent("max dev 8%").kind, "strategy");
  assert.equal(parseIntent("rogue mode wash trade loop").kind, "refuse", "the never-list is checked first");
});

test("docs: the Strategy & safety page lists every parameter key", () => {
  const doc = readFileSync(new URL("../../../docs/34-strategy.md", import.meta.url), "utf8");
  for (const f of STRATEGY_FIELDS) assert.ok(doc.includes(`\`${f.key}\``), `${f.key} is documented`);
});
