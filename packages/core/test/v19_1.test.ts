/**
 * v19.1: trading sources (Snipe rules, Copy trade, Pulse, Launch on post) switched on and off from Live → Strategy or
 * Strategy & safety. The guardrails refuse a buy from a source that's off; manual buys never are; presets keep them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPreset, defaultStrategy, exportStrategy, importStrategy, normalizeStrategy, sourcesOff } from "../src/strategy/settings.js";
import { describeStrategy, fieldOf, searchFields, setField } from "../src/strategy/fields.js";
import { checkTrade, sourceOffReason, type GuardContext } from "../src/guardrails.js";
import { DEFAULT_LIMITS, TRADE_ORIGIN_LABEL, type Limits } from "../src/types.js";

const ME = "7Gk2PqWm4zXc8Vb1nRt5Hy3JdLs6Ef9Ua2Ko8Ni9fQa";
const limits: Limits = { ...DEFAULT_LIMITS, perTradeMaxSol: 1, dailySpendCapSol: 5, maxBuysPerDay: 50 };
const ctx = (o: Partial<GuardContext> = {}): GuardContext => ({ limits, ownWallets: [ME], spentTodaySol: 0, buysToday: 0, openPositions: 0, recentFills: [], walletBalanceSol: 10, ...o });
const buy = (o: Record<string, unknown> = {}) => ({ action: "buy" as const, wallet: ME, mint: "MintA", amountSol: 0.1, reason: "x", ...o });

test("sources: on by default (Pulse follows 'buy new coins automatically'); normalize fills and keeps them", () => {
  const d = defaultStrategy();
  assert.deepEqual(d.sources, { snipe: true, copy: true, launchOnPost: true });
  assert.deepEqual(sourcesOff(d), ["pulse"], "Pulse is off until 'buy new coins automatically' is on");
  assert.deepEqual(normalizeStrategy({}).sources, d.sources);
  const n = normalizeStrategy({ sources: { copy: false, snipe: "nope" }, entry: { autoNewCoins: true } });
  assert.deepEqual(n.sources, { snipe: true, copy: false, launchOnPost: true });
  assert.deepEqual(sourcesOff(n), ["copy"]);
});

test("sources: a preset changes how, not where from; export / import carry them", () => {
  const s = normalizeStrategy({ sources: { snipe: false, copy: true, launchOnPost: false }, entry: { autoNewCoins: true } });
  for (const id of ["safe", "balanced", "degen", "rogue"] as const) {
    const p = applyPreset(s, id);
    assert.deepEqual(p.sources, s.sources, id);
    assert.equal(p.entry.autoNewCoins, true, id);
  }
  const back = importStrategy(exportStrategy(s));
  assert.deepEqual(back.sources, s.sources);
});

test("sources: the fields resolve, set from text, and show in the CLI summary", () => {
  for (const k of ["sources.snipe", "sources.copy", "sources.launchOnPost", "entry.autoNewCoins"]) assert.equal(fieldOf(k)?.section, "Trading from", k);
  const r = setField(defaultStrategy(), "sources.copy", "off", limits);
  assert.ok(r.ok && r.strategy.sources.copy === false && r.strategy.preset === "custom");
  assert.ok(searchFields("copy trade").some((f) => f.key === "sources.copy"));
  const g = describeStrategy(defaultStrategy(), limits).find((x) => x.group === "Entry")!;
  assert.ok(g.rows.some((x) => x.key === "sources.launchOnPost" && x.value === "on"));
});

test("guardrails: a buy from a source that's off is refused with its name; manual buys and other sources go through", () => {
  const off = sourcesOff(normalizeStrategy({ sources: { snipe: false, copy: false, launchOnPost: true }, entry: { autoNewCoins: false } }));
  assert.deepEqual(off, ["snipe", "copy", "pulse"]);
  for (const o of off) assert.deepEqual(checkTrade(buy({ origin: o }), ctx({ sourcesOff: off })), { ok: false, code: "source-off", reason: sourceOffReason(o) });
  assert.equal(sourceOffReason("copy"), "Copy trade is off: buys from it are paused.");
  assert.equal(checkTrade(buy(), ctx({ sourcesOff: off })).ok, true, "a manual buy (no origin) is never a source");
  assert.equal(checkTrade(buy({ origin: "launch-on-post" }), ctx({ sourcesOff: off })).ok, true);
  assert.equal(checkTrade(buy({ origin: "snipe" }), ctx()).ok, true, "no list: nothing is off");
  // selling is never blocked by a source
  assert.equal(checkTrade({ action: "sell", wallet: ME, mint: "MintA", sellPct: 50, reason: "x" }, ctx({ sourcesOff: off, holdsMint: true })).ok, true);
  assert.equal(Object.keys(TRADE_ORIGIN_LABEL).length, 4);
});

test("vesk live: the header line says what trades, each source on or off", async () => {
  const { liveView, renderLive } = await import("../src/ui/pipeline.js");
  const out = renderLive(liveView([], { now: 0 }), { status: "online", mode: "paper", pnlTodaySol: 0, positions: [], sources: { snipe: true, copy: false, pulse: true, launchOnPost: true } }).join("\n");
  assert.match(out, /trading from Snipe on · Copy off · Pulse on · Launch on post on/);
});
