/**
 * vesk strategy [show | set <key> <value> | preset safe|balanced|degen|rogue | explain <words> | export [--out f] | import <f>] [--json]
 * vesk rogue [status | start --ticker X [--keywords a,b] … [--yes] | stop] [--json]
 *
 * Strategy & safety: entry filters (the early-volume trigger), the rug check, the can-sell check, exits, hard limits
 * and Rogue mode. Every value is described in core/strategy/fields.ts (`vesk strategy explain <words>` prints it).
 * Saved to rules.json: a running agent picks it up within 2 s; a paired panel shows the same settings.
 */
import { readFile, writeFile } from "node:fs/promises";
import {
  applyPreset, describeStrategy, DEFAULT_LIMITS, exportStrategy, fieldText, getPath, importStrategy, isLimitKey, isStrategyPreset, normalizeStrategy, rogueActive, rogueLine,
  RuleStore, searchFields, setField, State, STRATEGY_PRESETS, validateLimits, validateStrategy, type Limits, type StrategySettings,
} from "@vesk-agent/core";
import { config } from "../context.js";
import { bold, confirm, dim, fail, ice, json, warn } from "../ui.js";

async function load(f: Record<string, unknown>) {
  const c = await config(f.config as string | undefined);
  const store = await new RuleStore(c.dataDir).load();
  const s = normalizeStrategy(store.data.strategy ?? c.strategy ?? {});
  const limits: Limits = { ...DEFAULT_LIMITS, ...c.limits, ...(store.data.limits ?? {}) };
  return { c, store, s, limits };
}

async function save(store: RuleStore, s: StrategySettings, limits: Limits, extra?: Partial<Limits>) {
  const errs = validateStrategy(s, limits);
  if (errs.length) fail(errs.map((e) => `${e.field}: ${e.message}`).join("\n"));
  store.data.strategy = s;
  if (extra) {
    const next = { ...limits, ...extra };
    const le = validateLimits(next);
    if (le.length) fail(le.map((e) => e.message).join("\n"));
    store.data.limits = { ...(store.data.limits ?? {}), ...extra };
  }
  await store.save();
}

export async function strategy(args: string[], f: Record<string, unknown>) {
  const { store, s, limits } = await load(f);
  const [sub, ...rest] = args;
  if (sub === "set") {
    const [key, ...v] = rest;
    if (!key || !v.length) fail("Usage: vesk strategy set <key> <value>   (`vesk strategy` lists the keys)");
    const r = setField(s, key, v.join(" "), limits);
    if (!r.ok) return fail(r.error);
    await save(store, r.strategy, limits, r.limits);
    if (key === "rug.allowBundled" && r.strategy.rug.allowBundled) console.log(warn("  Bundled coins allowed: bundled supply can be sold into you at any moment."));
    return console.log(`  ${r.text}. ${dim("A running agent picks it up within 2 s.")}`);
  }
  if (sub === "preset") {
    const id = rest[0];
    if (!isStrategyPreset(id)) fail(`Usage: vesk strategy preset ${Object.keys(STRATEGY_PRESETS).join("|")}`);
    await save(store, applyPreset(s, id), limits);
    return console.log(`  ${STRATEGY_PRESETS[id].label}: ${STRATEGY_PRESETS[id].line}${id === "rogue" ? dim(" Start a session with `vesk rogue start`.") : ""}`);
  }
  if (sub === "export") {
    const text = exportStrategy(s);
    if (typeof f.out === "string") { await writeFile(f.out, text); return console.log(`  Wrote ${f.out}`); }
    return console.log(text);
  }
  if (sub === "import") {
    if (!rest[0]) fail("Usage: vesk strategy import <file.json>");
    let next: StrategySettings;
    try { next = importStrategy(await readFile(rest[0], "utf8"), s); } catch (e) { return fail(`Couldn't read ${rest[0]}: ${(e as Error).message}`); }
    await save(store, next, limits);
    return console.log("  Strategy imported. A running agent picks it up within 2 s.");
  }
  if (sub === "explain") {
    const hits = searchFields(rest.join(" "));
    if (json(hits)) return;
    if (!hits.length) return console.log(dim("  Nothing matches. `vesk strategy` lists every setting."));
    for (const h of hits.slice(0, 8)) {
      const v = isLimitKey(h.key) ? (limits as unknown as Record<string, unknown>)[h.key.slice(7)] : getPath(s, h.key);
      console.log(`  ${bold(h.label)} ${dim(h.key)}  ${ice(fieldText(h, v))}\n  ${h.help}${h.typical ? `\n  ${dim(`Typical: ${h.typical}`)}` : ""}${h.tradeoff ? `\n  ${dim(`Trade-off: ${h.tradeoff}`)}` : ""}\n`);
    }
    return;
  }
  if (sub && sub !== "show") fail(`Unknown: vesk strategy ${sub}. Try show, set, preset, explain, export or import.`);
  const groups = describeStrategy(s, limits);
  if (json({ strategy: s, limits, groups })) return;
  console.log(`  ${bold("Strategy & safety")} ${dim(`preset ${s.preset}${s.mode === "rogue" ? " · Rogue mode on" : ""}`)}`);
  for (const g of groups) {
    console.log(`\n  ${bold(g.group)}`);
    for (const r of g.rows) console.log(`  ${(r.off ? dim : (x: string) => x)(r.label.padEnd(30))} ${r.off ? dim(r.value) : ice(r.value)}  ${dim(r.key)}`);
  }
  console.log(dim("\n  vesk strategy set <key> <value> · vesk strategy explain <words> · hard limits apply in every mode"));
}

export async function rogue(args: string[], f: Record<string, unknown>) {
  const { c, store, s, limits } = await load(f);
  const [sub] = args;
  if (sub === "stop") {
    await save(store, { ...s, mode: "normal", rogueStartedAt: undefined }, limits);
    return console.log("  Rogue mode off. Open coins keep their exits.");
  }
  if (sub === "start") {
    const n = (k: string) => (f[k] !== undefined ? Number(String(f[k]).replace(/sol|s|%|min/gi, "")) : undefined);
    const keepTop = f.keep !== undefined ? Number(f.keep) : undefined;
    const r = normalizeStrategy({
      ...s, preset: s.preset, mode: "rogue", rogueStartedAt: Date.now(),
      rogue: {
        ...s.rogue,
        ...(typeof f.ticker === "string" ? { ticker: f.ticker } : {}), ...(typeof f.keywords === "string" ? { keywords: f.keywords.split(",") } : {}),
        ...(typeof f.creator === "string" ? { expectedCreator: f.creator } : {}), ...(typeof f.x === "string" ? { expectedX: f.x } : {}),
        ...(n("window") !== undefined ? { windowMin: n("window") } : {}), ...(n("coins") !== undefined ? { maxCoins: n("coins") } : {}),
        ...(n("sol") !== undefined ? { perCoinSol: n("sol") } : {}), ...(n("budget") !== undefined ? { budgetSol: n("budget") } : {}),
        ...(n("stall") !== undefined ? { stallSec: n("stall") } : {}), ...(n("stall-vol") !== undefined ? { stallMinVolSol: n("stall-vol") } : {}),
        ...(n("sl") !== undefined ? { stopLossPct: n("sl") } : {}), ...(f.leaders === "off" ? { leaderAfterSec: 0 } : n("leaders") !== undefined ? { leaderAfterSec: n("leaders") } : {}),
        ...(keepTop !== undefined ? { keepTop } : {}), ...(f["no-honeypot"] ? { honeypot: false } : {}),
      },
    });
    const errs = validateStrategy(r, limits);
    if (errs.length) fail(errs.map((e) => e.message).join("\n"));
    const R = r.rogue;
    console.log(`\n  ${bold("Rogue mode")} ${dim("for a hyped launch with many copies")}`);
    console.log(`  Buys every new coin matching ${ice(R.ticker ? `$${R.ticker}` : "")}${R.ticker && R.keywords.length ? " or " : ""}${R.keywords.length ? ice(`"${R.keywords.join('", "')}"`) : ""} for ${R.windowMin} min:`);
    console.log(`  ${R.perCoinSol} SOL each, at most ${R.maxCoins} coins and ${R.budgetSol} SOL in total.`);
    console.log(`  It skips the early-volume trigger and the holder and dev checks. Losers are sold fast: stalled ${R.stallSec} s, stop-loss -${R.stopLossPct}%${R.keepTop && R.leaderAfterSec ? `, not in the top ${R.keepTop} after ${R.leaderAfterSec} s` : ""}.`);
    console.log(dim(`  Still enforced: your per-trade max (${limits.perTradeMaxSol} SOL), daily cap (${limits.dailySpendCapSol} SOL), buys per minute (${limits.maxBuysPerMinute ?? 10}), the kill switch, one wallet per coin, the never-list.`));
    if (!R.honeypot) {
      console.log(warn("\n  The can-sell check is OFF: fakes of a hyped launch are where honeypots live. A coin you can't sell is a total loss."));
      if (!f["i-understand"] && !f.yes) { if (!(await confirm("  Turn the can-sell check off for this session?"))) return console.log("  Not started."); }
      else if (!f["i-understand"]) fail("Switching the can-sell check off needs --i-understand as well as --yes.");
    }
    if (!f.yes && !(await confirm("\n  Start Rogue mode?"))) return console.log("  Not started.");
    await save(store, r, limits);
    if ((limits.maxBuysPerMinute ?? 10) < R.maxCoins) console.log(dim(`  Your limit of ${limits.maxBuysPerMinute ?? 10} buys per minute paces this session.`));
    return console.log(`  ${ice("Rogue mode on")} · ${rogueLine(R, null, Date.now()).text.replace(/^Rogue mode · /, "")} · ${R.windowMin}:00 left. ${dim("A running agent starts within 2 s.")}`);
  }
  if (sub && sub !== "status") fail("Usage: vesk rogue [status | start --ticker X [--keywords a,b] [--sol 0.05] [--coins 10] [--budget 0.5] [--window 10] [--yes] | stop]");
  const st = await new State(c.dataDir).load();
  const ses = st.data.rogue ?? null;
  const on = rogueActive(s, Date.now());
  if (json({ mode: s.mode, active: on, rogue: s.rogue, session: ses })) return;
  if (!on && !ses) return console.log(dim("  Rogue mode is off. `vesk rogue start --ticker X` starts a session."));
  const l = rogueLine(s.rogue, ses, Date.now());
  console.log(`  ${on ? ice(l.text) : dim(l.text)}${on ? ` · ${l.left} left` : dim(" · window over")}`);
  for (const x of ses?.coins ?? []) console.log(`  ${x.sold ? dim(`$${x.symbol}`) : ice(`$${x.symbol}`)} ${dim(x.mint.slice(0, 4) + "…" + x.mint.slice(-4))} ${x.sol} SOL${x.expected ? dim(" · expected") : ""}${x.sold ? dim(` · sold: ${x.sold.reason}`) : ""}`);
}
