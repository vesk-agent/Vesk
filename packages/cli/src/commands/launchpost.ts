/**
 * v26: launch-on-post from the terminal, beyond `vesk rules add --launch-on-post`.
 *
 *   vesk rules backtest <id> [--days 7] [--json]   replay the last days of posts through the rule; nothing is spent
 *   vesk rules stats [<id>] [--json]                launches, first-place rate, median post → landed, PnL, creator fees
 *   vesk rules templates                            the template tiles (founder, breaking, memes, product, cashtag)
 *   vesk races [<mint|$TICKER>] [--json]            race reports: "1st of 14 · 1.7 s after the post"
 *   vesk pairs [--search q] [--category stock] [--seen] [--json]   pump.fun custom pairs by category and status
 *   vesk pairs --check <SYMBOL|mint>               read a pair's mint on chain now (exists, token program, decimals, freeze authority)
 */
import { CATEGORY_LABEL, CATEGORY_ORDER, fmtGap, mintLine, seenRecently, LAUNCH_TEMPLATES, pairCounts, pairSelectable, pairStatus, PUMPFUN_PAIRS, raceLabel, REPORTED_TOTAL, searchPairs, STATUS_LABEL, type Agent, type PairCategory } from "@vesk-agent/core";
import { agent } from "../context.js";
import { bold, dim, fail, ice, json, table, up, warn } from "../ui.js";

type Flags = Record<string, string | boolean | undefined>;

export async function ruleBacktest(id: string | undefined, f: Flags, existing?: Agent) {
  const a = existing ?? (await agent({ config: f.config as string | undefined, paper: true }));
  const r = id ? a.launchRules().find((x) => x.id === id) : a.launchRules()[0];
  if (!r) fail(id ? `No launch-on-post rule ${id}. \`vesk rules\` lists them.` : "No launch-on-post rules yet.");
  const res = await a.backtestLaunchRule(r, Number(f.days ?? 7));
  if (json(res)) return;
  console.log(bold(`\n  Backtest · ${r.name}`) + dim(`  last ${Math.round((res.to - res.from) / 86_400_000)} days · ${res.source === "x-api" ? "your X API history" : res.source === "tracker" ? "the tracker's stored posts" : res.source}`));
  console.log(`  ${ice(String(res.launches))} launch${res.launches === 1 ? "" : "es"} from ${res.posts} post${res.posts === 1 ? "" : "s"} · would spend ${res.spendSol} SOL ${dim("(nothing was spent)")}`);
  const launched = res.rows.filter((x) => x.outcome === "launch");
  if (launched.length) table(launched.slice(-20).map((x) => ({ when: new Date(x.at).toISOString().slice(5, 16).replace("T", " "), account: "@" + x.handle, coin: `${x.name} $${x.symbol}`, note: x.approx ? "velocity approx." : "" })));
  if (res.reasons.length) { console.log(dim("\n  Skipped, most often:")); for (const x of res.reasons.slice(0, 5)) console.log(`  ${dim("·")} ${x.reason} ${dim(`× ${x.n}`)}`); }
  for (const n of res.notes) console.log(dim(`  ${n}`));
}

export async function ruleStatsCmd(id: string | undefined, f: Flags) {
  const a = await agent({ config: f.config as string | undefined, paper: true });
  const st = a.launchRuleStats(id);
  if (json(st)) return;
  if (!st.length) return console.log(dim("  No launch-on-post rules yet."));
  const name = (rid: string) => a.launchRules().find((r) => r.id === rid)?.name ?? rid;
  table(st.map((x) => ({
    rule: name(x.ruleId), launches: x.launches, "first place": x.firstRate === null ? "–" : `${Math.round(x.firstRate * 100)}% (${x.firsts}/${x.raced})`,
    "post → landed": x.medianMs === null ? "–" : fmtGap(x.medianMs), pnl: `${x.pnlSol >= 0 ? "+" : ""}${x.pnlSol.toFixed(3)} SOL`, "creator fees": x.fees.map((y) => `${+y.amount.toFixed(4)} ${y.asset}`).join(", ") || "–",
  })));
}

export function ruleTemplates() {
  if (json(LAUNCH_TEMPLATES.map(({ id, name, blurb }) => ({ id, name, blurb })))) return;
  for (const t of LAUNCH_TEMPLATES) console.log(`  ${ice(t.id.padEnd(9))} ${bold(t.name)} ${dim(t.blurb)}`);
  console.log(dim("\n  vesk rules add --launch-on-post @handle --template breaking …"));
}

export async function races(target: string | undefined, f: Flags) {
  const a = await agent({ config: f.config as string | undefined, paper: true });
  const all = a.raceReports();
  const list = target ? all.filter((x) => x.mint === target || `$${x.symbol}`.toUpperCase() === target.toUpperCase() || x.symbol?.toUpperCase() === target.toUpperCase()) : all;
  if (json(list)) return;
  if (!list.length) return console.log(dim("  No race reports yet. One is made a minute after each launch-on-post coin lands."));
  for (const x of list.slice(0, 20)) {
    const r = x.race!;
    console.log(`  ${r.rank === 1 ? up(raceLabel(r)) : raceLabel(r)}  ${ice("$" + x.symbol)} ${dim(`from @${x.handle}'s post${r.complete ? "" : " · partial (the create stream had a gap)"}`)}`);
    if (target) for (const e of r.entries) console.log(`    ${e.mine ? ice("you ") : dim("    ")} ${fmtGap(e.at - r.postAt).padStart(8)}  ${e.name} $${e.symbol} ${dim(e.match.join(" + "))}`);
  }
}

export async function pairs(f: Flags) {
  if (f.check) return pairCheck(String(f.check), f);
  let list = PUMPFUN_PAIRS;
  let checks: Record<string, { mint: string; ok: boolean }> = {};
  if (f.seen) { const a = await agent({ config: f.config as string | undefined, paper: true }); list = a.pairs(); checks = a.pairChecks(); }
  const cat = f.category ? String(f.category).toLowerCase().replace("-", "") : undefined;
  const groups = searchPairs(String(f.search ?? ""), list).filter((g) => !cat || g.category === cat || CATEGORY_LABEL[g.category].toLowerCase().startsWith(cat));
  if (json(groups)) return;
  const c = pairCounts(list);
  console.log(bold("\n  pump.fun custom pairs") + dim(`  ${c.total} of about ${REPORTED_TOTAL} · ${c.selectable} usable${c.unavailable ? ` · ${c.unavailable} not available yet` : ""}${c.discovered ? ` · ${c.discovered} discovered` : ""}`));
  for (const g of groups) {
    console.log(`\n  ${bold(g.label)}`);
    for (const p of g.items) console.log(`  ${pairSelectable(p) ? ice(p.id.padEnd(10)) : dim(p.id.padEnd(10))} ${p.name.padEnd(28)} ${p.status === "unavailable" ? warn(STATUS_LABEL[p.status]) : dim(STATUS_LABEL[pairStatus(p, checks[p.mint ?? ""])] + (p.seenCount ? ` · ${p.seenCount} creates` : ""))}${p.mint && p.mint !== "native" ? dim(`  ${p.mint.slice(0, 6)}…${p.mint.slice(-4)}`) : ""}`);
  }
  const seen = seenRecently(list);
  if (seen.length && !f.search && !cat) console.log(dim(`\n  Seen recently: ${seen.slice(0, 6).map((p) => `${p.id} (${p.seenCount ?? 1})`).join(", ")}`));
  console.log(dim("\n  Listed mints come from a third-party list; Discovered ones from pump.fun creates seen live. Every custom-pair mint is read on chain through your RPC before a create (account, token program, mint, decimals); a failed check refuses it. Creator fee 0.05-1%, paid in the pair asset. Verify on first live launch. `vesk pairs --check NVDAx` runs the check now."));
  void (CATEGORY_ORDER as PairCategory[]);
}

/** v26: run the on-chain mint check for one pair now, through your RPC (remembered: a pass shows "Verified on-chain"). Exit code 2 when it fails. */
async function pairCheck(id: string, f: Flags) {
  const a = await agent({ config: f.config as string | undefined, paper: true });
  const r = await a.checkPair(id);
  if ("error" in r) { if (json({ id, ok: false, reason: r.error })) { process.exitCode = 2; return; } console.log(warn(`  ${r.error}`)); process.exitCode = /native/.test(r.error) ? 0 : 2; return; }
  const { pair: p, check: c } = r;
  if (json({ id: p.id, mint: p.mint, ...c })) { if (!c.ok) process.exitCode = 2; return; }
  console.log(c.ok ? `  ${up("Verified on-chain")}  ${mintLine(p.id, c)}` : `  ${warn("Refused")}  ${mintLine(p.id, c)}`);
  console.log(dim(`  ${p.mint}  ·  ${p.status === "discovered" ? "discovered live" : `listed (${p.source ?? "registry"})`}`));
  if (!c.ok) process.exitCode = 2;
}
