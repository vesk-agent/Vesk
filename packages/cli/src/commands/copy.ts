/**
 * vesk copy: copy trading.
 *
 *   vesk copy [list] [--group g]                        tracked wallets with today's copies, PnL and last activity
 *   vesk copy add <address> [--label x] [settings…]     track a wallet (settings override your defaults)
 *   vesk copy edit <address|label> [settings…]          change one wallet's overrides
 *   vesk copy show <address|label>                      the effective settings for one wallet
 *   vesk copy on|off <address|label|all>                switch copying on or off
 *   vesk copy rm <address|label>
 *   vesk copy defaults [settings…]                      the default profile every wallet starts from
 *   vesk copy templates | template <name> <address|label|all>
 *   vesk copy import <file> | export [--format csv|json] [--out file]   (also reads address-book exports)
 *   vesk copy feed [--wallet x] [--limit 30]            their trades with copied / skipped and the reason, latency
 *   vesk copy decide <id> copy|skip | manual <feed id> [--sol 0.1]      (a running agent acts within 2 s)
 *   vesk copy watch [--for sec] [--paper]               run detection + copying in the foreground
 *   vesk copy sources [pumpportal,rpc,helius] [--commitment processed|confirmed]
 *
 * Settings: --sol 0.2 | --pct 25 | --mult 0.5, --min-sol, --max-sol, --mode alert|confirm|auto, --sells mirror|all|off,
 *   --max-mcap 300k, --min-mcap, --min-liq, --min-age, --max-age, --min-buy, --max-dev, --max-top10, --max-bundled,
 *   --socials, --venues pumpfun,pumpswap, --include a,b, --exclude c, --first-only | --every-buy,
 *   --tp 2x:50,5x:100, --sl 30, --trail 20, --sell-after 30:100, --max-trade, --max-sol-day, --max-sol-total, --max-open,
 *   --cooldown 300, --preset p1|p2|p3, --mev off|reduced|secure, --delay 0, --group, --tag, --note.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  bulkEdit, COPY_TAGS, COPY_VENUES, describeProfile, effectiveProfile, exportCopyWallets, feedLine, importCopyWallets, isPresetId, latencyOf, mergeOverrides, normalizeCopyConfig,
  parseTpLadder, parseUsdAmount, RuleStore, shortAddr, State, TEMPLATES, templateOverrides, upsertCopyWallet, validateProfile, VENUE_LABEL, copyStats,
  type CopyConfig, type CopyOverrides, type CopyTag, type CopyVenue, type CopyWallet, type TemplateId,
} from "@vesk-agent/core";
import { agent, config } from "../context.js";
import { bold, dim, down, fail, ice, json, kv, line, table, up } from "../ui.js";
import { BRAND } from "@vesk-agent/core";

type F = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : undefined);
const n = (v: unknown, what: string) => { if (v === undefined || v === true) return undefined; const x = Number(String(v).replace(/%$/, "")); if (!Number.isFinite(x)) fail(`${what} must be a number.`); return x; };
const list = (v: unknown) => (typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : undefined);
const ago = (t?: number) => { if (!t) return dim("never"); const d = Date.now() - t; return d < 1000 ? `${d} ms ago` : d < 60_000 ? `${Math.round(d / 1000)} s ago` : d < 3_600_000 ? `${Math.round(d / 60_000)} min ago` : `${Math.round(d / 3_600_000)} h ago`; };
const sol = (x: number) => `${+x.toFixed(4)} SOL`;
const signed = (x: number) => (x > 0 ? up(`+${x.toFixed(3)}`) : x < 0 ? down(x.toFixed(3)) : dim("0.000"));

/** Flags → overrides. Only what was passed. */
export function overridesFrom(f: F): CopyOverrides {
  const o: CopyOverrides = {};
  const amount: NonNullable<CopyOverrides["amount"]> = {};
  if (f.sol !== undefined) Object.assign(amount, { mode: "fixed", value: n(f.sol, "--sol") });
  if (f.pct !== undefined) Object.assign(amount, { mode: "pct", value: n(f.pct, "--pct") });
  if (f.mult !== undefined) Object.assign(amount, { mode: "multiple", value: n(String(f.mult).replace(/x$/i, ""), "--mult") });
  if (f["min-sol"] !== undefined) amount.minSol = n(f["min-sol"], "--min-sol");
  if (f["max-sol"] !== undefined) amount.maxSol = n(f["max-sol"], "--max-sol");
  if (amount.mode === "fixed" && amount.value !== undefined && f["max-sol"] === undefined) { amount.maxSol = Math.max(amount.value, 0.0001); amount.minSol ??= Math.min(amount.value, 0.01); }
  if (Object.keys(amount).length) o.amount = amount;
  const mode = s(f.mode);
  if (mode) { if (!["alert", "confirm", "auto"].includes(mode)) fail("--mode is alert, confirm or auto."); o.mode = mode as CopyOverrides["mode"]; }
  const sells = s(f.sells);
  if (sells) { if (!["off", "mirror", "all"].includes(sells)) fail("--sells is mirror, all or off."); o.sells = sells as CopyOverrides["sells"]; }
  if (f["no-buys"]) o.buys = false;
  const fl: NonNullable<CopyOverrides["filters"]> = {};
  // "off" / "none" / "any" switches a default filter off for this wallet.
  const OFF = /^(off|none|any|no)$/i;
  const usd = (k: string) => { if (OFF.test(String(f[k]))) return null; const v = parseUsdAmount(s(f[k])); if (v !== undefined && Number.isNaN(v)) fail(`--${k} is a dollar amount like 300k or 1.2m.`); return v; };
  const nn = (k: string) => (OFF.test(String(f[k])) ? null : n(f[k], `--${k}`));
  if (f["max-mcap"] !== undefined) fl.maxMcapUsd = usd("max-mcap");
  if (f["min-mcap"] !== undefined) fl.minMcapUsd = usd("min-mcap");
  if (f["min-liq"] !== undefined) fl.minLiquiditySol = nn("min-liq");
  if (f["min-age"] !== undefined) fl.minAgeSec = nn("min-age");
  if (f["max-age"] !== undefined) fl.maxAgeSec = nn("max-age");
  if (f["min-buy"] !== undefined) fl.minTargetBuySol = nn("min-buy");
  if (f["max-dev"] !== undefined) fl.maxDevPct = nn("max-dev");
  if (f["max-top10"] !== undefined) fl.maxTop10Pct = nn("max-top10");
  if (f["max-bundled"] !== undefined) fl.maxBundledPct = nn("max-bundled");
  if (f.socials) fl.requireSocials = ["x"];
  if (f.venues !== undefined) { const v = list(f.venues) ?? []; const bad = v.filter((x) => !COPY_VENUES.includes(x as CopyVenue)); if (bad.length) fail(`--venues takes ${COPY_VENUES.join(", ")}.`); fl.venues = v as CopyVenue[]; }
  if (f.include !== undefined) fl.include = list(f.include);
  if (f.exclude !== undefined) fl.exclude = list(f.exclude);
  if (f["first-only"]) fl.firstBuyOnly = true;
  if (f["every-buy"]) fl.firstBuyOnly = false;
  if (f["allow-missing"]) fl.missingData = "allow";
  if (Object.keys(fl).length) o.filters = fl;
  const exit: NonNullable<CopyOverrides["exit"]> = {};
  try { if (s(f.tp)) exit.takeProfit = parseTpLadder(s(f.tp)!); } catch (e) { fail((e as Error).message); }
  if (f.sl !== undefined) exit.stopLossPct = n(f.sl, "--sl");
  if (f.trail !== undefined) exit.trailingStopPct = n(f.trail, "--trail");
  if (s(f["sell-after"])) exit.timeSells = s(f["sell-after"])!.split(",").map((x) => { const [a, b] = x.split(":").map(Number); if (!(a > 0 && b > 0)) fail("--sell-after is <seconds>:<percent>, e.g. 30:100"); return { afterSec: a, sellPct: b }; });
  if (f.timeout !== undefined) exit.timeoutMin = n(f.timeout, "--timeout");
  if (Object.keys(exit).length) o.exit = exit;
  const lim: NonNullable<CopyOverrides["limits"]> = {};
  if (f["max-trade"] !== undefined) lim.maxSolPerTrade = n(f["max-trade"], "--max-trade");
  if (f["max-sol-day"] !== undefined) lim.maxSolPerWalletDay = n(f["max-sol-day"], "--max-sol-day");
  if (f["max-sol-total"] !== undefined) lim.maxSolTotalDay = n(f["max-sol-total"], "--max-sol-total");
  if (f["max-open"] !== undefined) lim.maxOpenCopies = n(f["max-open"], "--max-open");
  if (f.cooldown !== undefined) lim.tokenCooldownSec = n(f.cooldown, "--cooldown");
  if (Object.keys(lim).length) o.limits = lim;
  if (f.preset !== undefined) { if (!isPresetId(f.preset)) fail("--preset is p1, p2 or p3."); o.preset = f.preset; }
  if (f.mev !== undefined) { if (!["off", "reduced", "secure"].includes(String(f.mev))) fail("--mev is off, reduced or secure."); o.mev = f.mev as CopyOverrides["mev"]; }
  if (f.delay !== undefined) o.delayMs = n(f.delay, "--delay");
  return o;
}

function find(c: CopyConfig, ref: string): CopyWallet {
  const w = c.wallets.find((x) => x.address === ref) ?? c.wallets.filter((x) => x.label.toLowerCase() === ref.replace(/^@/, "").toLowerCase()).at(0);
  if (!w) fail(`No tracked wallet "${ref}". \`vesk copy list\` shows them.`);
  return w!;
}

const tagOf = (f: F): CopyTag | undefined => {
  const t = s(f.tag);
  if (t && !(COPY_TAGS as readonly string[]).includes(t)) fail(`--tag is one of ${COPY_TAGS.join(", ")}.`);
  return t as CopyTag | undefined;
};

export async function copy(args: string[], f: F) {
  const [sub, a1, a2] = args;
  if (sub === "watch") return watch(f);
  const c0 = await config(f.config as string | undefined);
  const store = await new RuleStore(c0.dataDir).load();
  let c = normalizeCopyConfig(store.data.copy);
  const save = async (next: CopyConfig) => { store.data.copy = next; await store.save(); c = next; };
  const state = await new State(c0.dataDir).load();

  if (sub === "add") {
    if (!a1) fail("Usage: vesk copy add <address> [--label name] [--sol 0.2] [--max-mcap 300k] [--tp 2x:50] [--sl 30] [--mode auto]");
    const ov = overridesFrom(f);
    const tpl = s(f.template) as TemplateId | undefined;
    if (tpl && !(tpl in TEMPLATES)) fail(`--template is ${Object.keys(TEMPLATES).join(", ")}.`);
    const overrides = tpl ? mergeOverrides(templateOverrides(tpl), ov) : Object.keys(ov).length ? ov : undefined;
    try {
      await save(upsertCopyWallet(c, { address: a1, label: s(f.label), group: s(f.group), notes: s(f.note), tag: tagOf(f), enabled: !f.off, template: tpl ?? (overrides ? "custom" : undefined), overrides }));
    } catch (e) { return fail((e as Error).message); }
    const w = c.wallets.find((x) => x.address === a1)!;
    if (json(w)) return;
    console.log(`  Tracking ${ice(w.label)} (${shortAddr(w.address)}). A running agent subscribes within 2 s.`);
    for (const l of describeProfile(effectiveProfile(c.defaults, w))) console.log(`  ${ice("·")} ${l}`);
    return;
  }
  if (sub === "edit") {
    if (!a1) fail("Usage: vesk copy edit <address|label> [settings…]");
    const w = find(c, a1);
    const ov = overridesFrom(f);
    try {
      await save(upsertCopyWallet(c, { ...w, label: s(f.label) ?? w.label, group: s(f.group) ?? w.group, notes: s(f.note) ?? w.notes, tag: tagOf(f) ?? w.tag, template: Object.keys(ov).length ? "custom" : w.template, overrides: mergeOverrides(w.overrides, ov) }));
    } catch (e) { return fail((e as Error).message); }
    const nw = c.wallets.find((x) => x.address === w.address)!;
    if (json(nw)) return;
    console.log(`  Updated ${ice(nw.label)}.`);
    for (const l of describeProfile(effectiveProfile(c.defaults, nw))) console.log(`  ${ice("·")} ${l}`);
    return;
  }
  if (sub === "show") {
    const w = find(c, a1 ?? "");
    const p = effectiveProfile(c.defaults, w);
    if (json({ wallet: w, effective: p })) return;
    console.log(`\n  ${bold(w.label)}  ${dim(w.address)}${w.group ? `  ${dim("· " + w.group)}` : ""}${w.enabled ? "" : `  ${dim("(off)")}`}`);
    for (const l of describeProfile(p)) console.log(`  ${ice("·")} ${l}`);
    if (w.notes) console.log(`  ${dim("Notes: " + w.notes)}`);
    return;
  }
  if (sub === "on" || sub === "off") {
    if (!a1) fail(`Usage: vesk copy ${sub} <address|label|all>`);
    if (a1 === "all") { await save({ ...c, enabled: sub === "on" }); return console.log(`  Copy trading ${sub === "on" ? "on" : "off (wallets keep their settings)"}.`); }
    const w = find(c, a1);
    await save(bulkEdit(c, [w.address], { enabled: sub === "on" }));
    return console.log(`  ${w.label}: copying ${sub}.`);
  }
  if (sub === "rm") {
    const w = find(c, a1 ?? "");
    await save({ ...c, wallets: c.wallets.filter((x) => x.address !== w.address) });
    return console.log(`  Stopped tracking ${w.label}. Open copied positions keep their exits.`);
  }
  if (sub === "defaults") {
    const ov = overridesFrom(f);
    if (Object.keys(ov).length) {
      const next = effectiveProfile(c.defaults, { overrides: ov });
      const bad = validateProfile(next);
      if (bad.length) fail(`${bad[0].field}: ${bad[0].message}`);
      await save({ ...c, defaults: next });
    }
    if (json(c.defaults)) return;
    console.log(bold("\n  Default copy profile") + dim("  (every wallet starts here; per-wallet settings override it)"));
    for (const l of describeProfile(c.defaults)) console.log(`  ${ice("·")} ${l}`);
    return;
  }
  if (sub === "sources") {
    if (a1) {
      const want = a1.split(",").map((x) => x.trim().toLowerCase());
      const bad = want.filter((x) => !["pumpportal", "rpc", "helius", "yellowstone"].includes(x));
      if (bad.length) fail("Sources: pumpportal, rpc, helius (yellowstone isn't built in).");
      if (want.includes("yellowstone")) fail(`Yellowstone gRPC isn't built into ${BRAND.name}. See docs/27-copy-trading.md for the adapter interface.`);
      await save({ ...c, sources: { ...c.sources, pumpportal: want.includes("pumpportal"), rpc: want.includes("rpc"), adapter: want.includes("helius") ? "helius" : "none", rpcCommitment: f.commitment === "processed" ? "processed" : c.sources.rpcCommitment } });
    }
    if (json(c.sources)) return;
    return kv([["PumpPortal", c.sources.pumpportal ? "on (pump.fun, PumpSwap, Bonk)" : "off"], ["RPC websocket", c.sources.rpc ? `on (${c.sources.rpcCommitment}, every venue)` : "off"], ["adapter", c.sources.adapter === "none" ? "none" : `${c.sources.adapter} (URL from keystore ${c.sources.adapterUrlKey ?? "HELIUS_WS_URL"})`]]);
  }
  if (sub === "templates") {
    if (json(TEMPLATES)) return;
    for (const [id, t] of Object.entries(TEMPLATES)) { console.log(`\n  ${bold(t.label)} ${dim(`(${id})`)}  ${dim(t.blurb)}`); for (const l of describeProfile(t.profile)) console.log(`  ${ice("·")} ${l}`); }
    return console.log(dim("\n  Apply one: vesk copy template balanced <address|label|all>. Starting points, not advice."));
  }
  if (sub === "template") {
    if (!a1 || !(a1 in TEMPLATES) || !a2) fail(`Usage: vesk copy template <${Object.keys(TEMPLATES).join("|")}> <address|label|all>`);
    const targets = a2 === "all" ? c.wallets.map((w) => w.address) : [find(c, a2).address];
    await save(bulkEdit(c, targets, { template: a1 as TemplateId }));
    return console.log(`  Applied ${TEMPLATES[a1 as keyof typeof TEMPLATES].label} to ${targets.length} wallet${targets.length === 1 ? "" : "s"}.`);
  }
  if (sub === "import") {
    if (!a1) fail("Usage: vesk copy import <file.csv|file.json|addresses.txt> [--group g] [--template balanced]");
    const r = importCopyWallets(await readFile(a1, "utf8"), c.defaults);
    let next = c;
    const tpl = s(f.template) as TemplateId | undefined;
    for (const w of r.wallets) {
      const cur = next.wallets.find((x) => x.address === w.address);
      try { next = upsertCopyWallet(next, { ...cur, ...w, group: s(f.group) ?? w.group ?? cur?.group, ...(tpl ? { template: tpl, overrides: templateOverrides(tpl) } : {}) }); } catch (e) { r.errors.push(`${shortAddr(w.address)}: ${(e as Error).message}`); }
    }
    await save(next);
    if (json(r)) return;
    console.log(`  Imported ${r.wallets.length} wallet${r.wallets.length === 1 ? "" : "s"}${r.errors.length ? `, ${r.errors.length} skipped:` : "."}`);
    for (const e of r.errors.slice(0, 20)) console.log(`  ${down("·")} ${e}`);
    return;
  }
  if (sub === "export") {
    const fmt = f.format === "json" ? "json" : "csv";
    const text = exportCopyWallets(c, fmt);
    if (s(f.out)) { await writeFile(s(f.out)!, text); return console.log(`  Wrote ${c.wallets.length} wallets to ${s(f.out)}.`); }
    return console.log(text);
  }
  if (sub === "feed") {
    const lim = n(f.limit, "--limit") ?? 30;
    const who = s(f.wallet) ? find(c, s(f.wallet)!).address : undefined;
    const items = state.data.copyFeed.filter((i) => !who || i.wallet === who).slice(-lim);
    if (json(items)) return;
    if (!items.length) return console.log(dim("  No trades seen yet. Track a wallet (vesk copy add) and run the agent (vesk summon)."));
    for (const i of items) {
      const l = latencyOf(i.latency);
      const coin = i.symbol ? `$${i.symbol}` : shortAddr(i.mint);
      const tag = i.status === "copied" ? (i.side === "buy" ? "copied" : "sold") : i.status;
      const col = i.status === "copied" ? ice : i.status === "failed" ? down : dim;
      const extra = [l.detectToLandMs !== undefined ? `${l.detectToLandMs} ms` : "", l.slotsBehind !== undefined ? `${l.slotsBehind} slot${l.slotsBehind === 1 ? "" : "s"} after` : "", i.source].filter(Boolean).join(" · ");
      line(tag, `${i.label} ${i.side === "buy" ? "bought" : `sold ${i.sellPct !== undefined ? Math.round(i.sellPct) + "% · " : ""}`}${i.side === "buy" ? sol(i.theirSol) + " of " : ""}${coin} on ${VENUE_LABEL[i.venue]} → ${feedLine(i)}${extra ? dim(`  (${extra})`) : ""}  ${dim(i.id)}`, col, i.at);
    }
    return;
  }
  if (sub === "decide" || sub === "manual") {
    const f2 = join(c0.dataDir, "control.json");
    const ctl = existsSync(f2) ? JSON.parse(await readFile(f2, "utf8").catch(() => "{}")) : {};
    if (sub === "decide") {
      if (!a1 || !["copy", "skip"].includes(a2 ?? "")) fail("Usage: vesk copy decide <id> copy|skip");
      ctl.copyDecisions = [...(ctl.copyDecisions ?? []), { id: a1, copy: a2 === "copy" }];
    } else {
      if (!a1) fail("Usage: vesk copy manual <feed id> [--sol 0.1]");
      ctl.copyManual = [...(ctl.copyManual ?? []), { feedId: a1, amountSol: n(f.sol, "--sol") }];
    }
    await writeFile(f2, JSON.stringify(ctl));
    return console.log("  Sent to the running agent (it acts within 2 s; guardrails still decide).");
  }
  if (sub && sub !== "list") fail(`Unknown: vesk copy ${sub}. Try vesk copy help.`);
  // list
  const st = copyStats(state.data.copyFeed, state.data.positions, state.data.closed);
  const rows = c.wallets.filter((w) => !s(f.group) || w.group === s(f.group));
  if (json({ enabled: c.enabled, wallets: rows.map((w) => ({ ...w, effective: effectiveProfile(c.defaults, w), stats: st[w.address] ?? null })) })) return;
  if (!rows.length) return console.log(dim("  No tracked wallets. Add one: vesk copy add <address> --label name --sol 0.1 --max-mcap 300k"));
  if (!c.enabled) console.log(dim("  Copy trading is off (vesk copy on all). Wallets keep their settings."));
  table(rows.map((w) => {
    const p = effectiveProfile(c.defaults, w);
    const x = st[w.address];
    return {
      label: w.label, address: shortAddr(w.address), on: w.enabled ? up("on") : dim("off"), mode: p.mode, size: p.amount.mode === "fixed" ? sol(p.amount.value) : p.amount.mode === "pct" ? `${p.amount.value}%` : `${p.amount.value}x`,
      "max mcap": p.filters.maxMcapUsd !== undefined ? `$${p.filters.maxMcapUsd >= 1e6 ? +(p.filters.maxMcapUsd / 1e6).toFixed(2) + "M" : Math.round(p.filters.maxMcapUsd / 1e3) + "k"}` : dim("any"),
      sells: p.sells, today: x?.copiesToday ?? 0, pnl: x ? signed(x.pnlSol) : dim("0.000"), win: x?.winRate !== null && x?.winRate !== undefined ? `${Math.round(x.winRate * 100)}%` : dim("n/a"), last: ago(x?.lastActivityAt), group: w.group ?? "",
    };
  }));
  console.log(dim("  PnL counts closed copies, plus open ones when the agent reports a price. Win rate: closed copies only."));
}

async function watch(f: F) {
  const a = await agent({ config: f.config as string | undefined, paper: !!f.paper });
  const c = a.copy.config();
  const on = c.enabled ? c.wallets.filter((w) => w.enabled) : [];
  if (!on.length) fail("No wallets to copy. Add one with `vesk copy add <address>` (and `vesk copy on all` if copying is off).");
  if (a.state.data.status !== "paused") a.state.data.status = "online";
  console.log(dim(`  Copy trading ${on.length} wallet${on.length === 1 ? "" : "s"}${f.paper ? " (paper: nothing is signed)" : ""} · ctrl-c stops`));
  kv([["sources", [c.sources.pumpportal && "PumpPortal account trades", c.sources.rpc && "RPC logsSubscribe", c.sources.adapter !== "none" && c.sources.adapter].filter(Boolean).join(" + ")]]);
  const shown = new Map<string, string>();
  a.copy.subscribe((i) => {
    const key = `${i.status}:${i.ourSig ?? ""}:${i.latency.ourSlot ?? ""}`;
    if (shown.get(i.id) === key) return;
    shown.set(i.id, key);
    if (i.status === "pending" && /^(sending|selling)$/.test(i.reason)) return;
    const coin = i.symbol ? `$${i.symbol}` : shortAddr(i.mint);
    const what = `${i.label} ${i.side === "buy" ? `bought ${sol(i.theirSol)} of` : `sold ${i.sellPct !== undefined ? Math.round(i.sellPct) + "% of" : ""}`} ${coin}`;
    const tag = i.status === "copied" ? (i.side === "buy" ? "copy" : "sell") : i.status === "skipped" ? "skip" : i.status;
    line(tag, `${what} → ${feedLine(i)}${i.latency.ourSlot !== undefined && i.latency.targetSlot !== undefined ? dim(` (${i.latency.ourSlot - i.latency.targetSlot} slots after theirs)`) : ""}`, i.status === "copied" ? up : i.status === "failed" ? down : undefined);
  });
  const timer = setInterval(() => { a.copy.expirePending(); void a.store.load().then(() => a.copy.sync()); }, 2000);
  a.copy.sync();
  const stop = () => { clearInterval(timer); a.copy.stop(); void a.state.save().then(() => process.exit(0)); };
  process.on("SIGINT", stop);
  if (f.for) setTimeout(stop, Number(f.for) * 1000);
}
