/** vesk summon | status | stop | pause | resume | kill */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eventsFromActivity, fmtK, liveView, normalizeStrategy, parseNameReply, pendingText, positionPnl, renderLive, rogueActive, rogueLine, RuleStore, State, type Activity, type ControlFile } from "@vesk-agent/core";
import { agent, config } from "../context.js";
import { AGENT_VERSION } from "@vesk-agent/core";
import { banner, dim, down, faint, fail, grey, ice, json, kv, line, short, sol, spinner, table, up, vw, warn } from "../ui.js";

const TAG: Partial<Record<Activity["kind"], (s: string) => string>> = { buy: up, sell: ice, launch: ice, claim: ice, buyback: ice, tp: up, sl: down, trail: warn, signal: ice, skip: grey, guardrail: warn, error: down };

export async function summon(flags: { config?: string; paper?: boolean; live?: boolean; stream?: boolean }) {
  banner();
  if (flags.paper && flags.live) fail("Pick one: --paper or --live.");
  const c = await config(flags.config);
  // Paper is the default after `vesk init` (paper: true in the config); --live signs for real.
  const paper = !!flags.paper || (c.paper === true && !flags.live);
  const a = await agent({ ...flags, paper });
  // Lines from start-up wait until the header is printed, so the header always comes first.
  const early: Activity[] = [];
  let ready = false;
  const show = (e: Activity) => line(e.kind, e.message + (e.signature ? faint(`  ${e.signature.slice(0, 10)}…`) : ""), TAG[e.kind], e.at);
  a.state.onActivity((e) => (ready ? show(e) : void early.push(e)));
  const sp = spinner("Starting the agent");
  await a.start();
  sp.stop();
  const s = await a.summary();
  if (!json({ event: "online", ...s })) header(s);
  ready = true;
  early.splice(0).forEach(show);
  // A quiet status line every minute, so a long-running terminal always shows where things stand.
  const tick = setInterval(async () => {
    const x = await a.summary().catch(() => null);
    if (!x) return;
    line("status", `${x.balanceSol === null ? "–" : x.balanceSol.toFixed(3)} SOL · ${x.openPositions} open · today ${pnl(x.todayPnlSol)} · rpc ${x.rpc.p50Ms ?? "–"} ms`, faint);
  }, 60_000);
  const bye = async () => {
    clearInterval(tick);
    await a.stop("stopped");
    process.exit(0);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}

type Summary = Awaited<ReturnType<Awaited<ReturnType<typeof agent>>["summary"]>>;
const pnl = (n: number) => (n === 0 ? "0.000 SOL" : n > 0 ? up(`+${n.toFixed(3)} SOL`) : down(`${n.toFixed(3)} SOL`));

/** The compact header `vesk summon` prints once it's online. */
function header(s: Summary) {
  const L = (k: string, v: string) => `${dim(k.padEnd(7))}${v}`;
  const left = [
    L("wallet", `${ice(short(s.wallet))}  ${s.balanceSol === null ? dim("balance –") : `${s.balanceSol.toFixed(3)} SOL`}`),
    L("model", s.model === "none" ? dim("none (common phrasings only)") : s.model),
    L("x", s.x.source === "off" ? dim("off") : `${s.x.source} · ${s.x.accounts} account${s.x.accounts === 1 ? "" : "s"}`),
  ];
  const right = [
    L("rpc", `${s.rpc.kind}${s.rpc.p50Ms !== undefined ? ` ${s.rpc.p50Ms} ms` : ""}${s.rpc.ws ? dim(" · ws") : ""}`),
    L("rules", `${s.rules.snipe} snipe · ${s.rules.launch} launch`),
    L("today", `${pnl(s.todayPnlSol)} ${dim(`· ${s.openPositions} open`)}`),
  ];
  const w = Math.max(...left.map(vw)) + 4;
  console.log(`  ${ice("vesk")} ${dim(AGENT_VERSION)}  ${s.paper ? warn("paper") + dim(" · decides, never signs · --live to sign") : up("live") + dim(" · signs inside your limits")}`);
  console.log(`  ${dim("─".repeat(Math.max(48, w + Math.max(...right.map(vw)))))}`);
  left.forEach((l, i) => console.log(`  ${l}${" ".repeat(w - vw(l))}${right[i]}`));
  console.log(`  ${dim("ctrl-c stops · vesk pause / vesk kill on from another terminal")}\n`);
}

async function control(flags: { config?: string }, patch: ControlFile) {
  const c = await config(flags.config);
  const f = join(c.dataDir, "control.json");
  const cur = existsSync(f) ? (JSON.parse(await readFile(f, "utf8")) as ControlFile) : {};
  await writeFile(f, JSON.stringify({ ...cur, ...patch, at: Date.now() }));
}

/** vesk pending [list | launch <id> | skip <id>]: launch-on-post drafts waiting for a decision. */
export async function pending(args: string[], f: { config?: string }) {
  const [sub, id, ...rest] = args;
  if (sub === "launch" || sub === "skip") {
    if (!id) fail(`Usage: vesk pending ${sub} <id> [Name $TICKER]`);
    // v26: `vesk pending launch <id> Night Ferry $FERRY` names the coin (naming "ask", or to change the drafted name)
    const name = sub === "launch" && rest.length ? parseNameReply(rest.join(" ")) : null;
    if (sub === "launch" && rest.length && !name) fail('Name it like: vesk pending launch <id> "Night Ferry" \$FERRY');
    const c = await config(f.config);
    const file = join(c.dataDir, "control.json");
    const cur = existsSync(file) ? (JSON.parse(await readFile(file, "utf8")) as ControlFile) : {};
    await writeFile(file, JSON.stringify({ ...cur, decisions: [...(cur.decisions ?? []), { id, launch: sub === "launch", ...(name ? { name } : {}) }], at: Date.now() }));
    return console.log(sub === "launch" ? "Sent. The running agent launches it within 2 seconds (limits and guardrails apply)." : "Skipped.");
  }
  const c = await config(f.config);
  const s = await new State(c.dataDir).load();
  const list = s.data.pendingLaunches.filter((p) => p.expiresAt > Date.now());
  if (json(list)) return;
  if (!list.length) return console.log(dim("  No drafts waiting."));
  for (const p of list) console.log(`\n${pendingText(p).split("\n").map((l) => "  " + l).join("\n")}`);
}

export const stop = (f: { config?: string }) => control(f, { stop: true }).then(() => console.log("Stop signal sent. The agent exits within 2 seconds."));
export const pause = (f: { config?: string }) => control(f, { paused: true }).then(() => console.log("Paused. Rules won't fire; exits keep running."));
export const resume = (f: { config?: string }) => control(f, { paused: false }).then(() => console.log("Resumed."));
export async function kill(args: string[], f: { config?: string }) {
  const on = args[0] !== "off";
  await control(f, { killSwitch: on });
  console.log(on ? warn("Kill switch ON. No new buys. Sells and withdrawals still work.") : "Kill switch off.");
}

export async function status(flags: { config?: string }) {
  const c = await config(flags.config);
  const s = await new State(c.dataDir).load();
  const d = s.data;
  const rows = d.positions.map((p) => {
    const x = positionPnl(p, p.highestPriceSol);
    return { mint: p.mint, symbol: p.symbol, tokens: p.tokens, costSol: p.costSol, tpDone: p.tpDone.length, bestPnlPct: +x.pnlPct.toFixed(1), openedAt: p.openedAt };
  });
  if (json({ status: d.status, paper: c.paper === true, spentTodaySol: s.spentToday(), dailyCapSol: c.limits.dailySpendCapSol, buysToday: s.buysToday(), realizedTodaySol: s.realizedToday(), positions: rows, recent: d.activity.slice(-20) })) return;
  kv([
    ["status", d.status === "online" ? up("online") : d.status === "paused" ? warn("paused") : grey("stopped")],
    ["mode", c.paper === true ? warn("paper") : "live"],
    ["today", `spent ${sol(s.spentToday())} of ${c.limits.dailySpendCapSol} · ${s.buysToday()} buys · realised ${pnlCell(s.realizedToday())}`],
    ["open", `${d.positions.length} position${d.positions.length === 1 ? "" : "s"}`],
  ]);
  if (rows.length) {
    console.log();
    positionsTable(d.positions);
  }
  console.log(`\n  ${dim("RECENT")}`);
  for (const a of d.activity.slice(-8)) console.log(`  ${dim(new Date(a.at).toLocaleTimeString([], { hour12: false }))}  ${(TAG[a.kind] ?? grey)(a.kind.padEnd(9))} ${a.message}`);
}

const pnlCell = (n: number) => (Math.abs(n) < 5e-5 ? dim("0.0000") : n > 0 ? up(`+${n.toFixed(4)}`) : down(n.toFixed(4)));

function positionsTable(ps: Array<import("@vesk-agent/core").Position>) {
  table(ps.map((p) => {
    const x = positionPnl(p, p.highestPriceSol);
    return { coin: ice(p.symbol), mint: short(p.mint), cost: p.costSol.toFixed(4), tokens: fmtK(p.tokens), "tp done": p.tpDone.length, "best pnl": `${x.pnlPct >= 0 ? up(`+${x.pnlPct.toFixed(0)}%`) : down(`${x.pnlPct.toFixed(0)}%`)}`, held: held(p.openedAt), source: p.copiedFrom ? dim(`copied from ${p.copiedFrom.label}`) : p.launched ? dim("your launch") : "" };
  }), undefined, ["cost", "tokens", "tp done", "best pnl", "held"]);
}
const held = (t: number) => { const m = Math.floor((Date.now() - t) / 60000); return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h${m % 60}m` : `${Math.floor(m / 1440)}d`; };

/** vesk positions [--json]: open positions from the agent's state (live prices: see the panel or `vesk status`). */
export async function positions(flags: { config?: string }) {
  const c = await config(flags.config);
  const s = await new State(c.dataDir).load();
  if (json(s.data.positions)) return;
  if (!s.data.positions.length) console.log(dim("  No open positions."));
  else positionsTable(s.data.positions);
  const closed = s.data.closed.slice(-5).reverse();
  if (closed.length) {
    console.log(`\n  ${dim("RECENTLY CLOSED")}`);
    table(closed.map((p) => ({ coin: p.symbol, cost: p.costSol.toFixed(4), out: p.realizedSol.toFixed(4), pnl: pnlCell(p.realizedSol - p.costSol) })), undefined, ["cost", "out", "pnl"]);
  }
}

/**
 * vesk live [--once] [--json]: watch the agent work, the same view as the panel's Live page. Reads the running
 * agent's state file (it writes every pipeline step there) and redraws every second; --once prints one frame.
 * Older state files without pipeline events are read from the activity log instead.
 */
export async function live(flags: { config?: string; once?: boolean }) {
  const c = await config(flags.config);
  const frame = async () => {
    const s = await new State(c.dataDir).load();
    const d = s.data;
    const events = d.pipeline?.length ? d.pipeline : eventsFromActivity(d.activity.slice(-300));
    const v = liveView(events, { now: Date.now(), openExits: d.positions.length });
    const buyReason = (mint: string) => [...d.activity].reverse().find((a) => a.kind === "buy" && a.mint === mint)?.message.replace(/^\[paper\]\s*/, "");
    const positions = d.positions.map((p) => ({ symbol: p.symbol && p.symbol !== "?" ? p.symbol : `${p.mint.slice(0, 4)}…`, costSol: p.costSol, pnlPct: positionPnl(p, p.highestPriceSol).pnlPct, reason: buyReason(p.mint), exits: p.exit ? describeExit(p.exit) : undefined }));
    // v19: the Rogue session, when one runs (rules.json says the mode, state.json has the session)
    const st = normalizeStrategy((await new RuleStore(c.dataDir).load()).data.strategy ?? c.strategy ?? {});
    const rogue = d.rogue && rogueActive(st, Date.now()) ? rogueLine(st.rogue, d.rogue, Date.now()) : null;
    return { v, header: { status: d.status, mode: c.paper === true ? "paper" : "live", pnlTodaySol: s.realizedToday(), positions, width: process.stdout.columns ?? (Number(process.env.COLUMNS) || undefined), rogue, sources: { snipe: st.sources.snipe, copy: st.sources.copy, pulse: st.entry.autoNewCoins, launchOnPost: st.sources.launchOnPost }, work: d.work && Date.now() - d.work.at < 5000 ? d.work : null } };
  };
  const f0 = await frame();
  if (json({ status: f0.header.status, mode: f0.header.mode, rogue: f0.header.rogue?.text ?? null, work: f0.header.work, active: f0.v.active, counters: f0.v.counters, nodes: f0.v.nodes, decisions: f0.v.decisions.slice(0, 50), positions: f0.header.positions })) return;
  const paint = { dim, up, down, ice, warn, bold: (x: string) => `\x1b[1m${x}\x1b[22m` };
  const draw = (f: Awaited<ReturnType<typeof frame>>) => renderLive(f.v, f.header, paint).join("\n");
  if (flags.once || !process.stdout.isTTY) return void console.log(draw(f0));
  process.stdout.write("\x1b[?25l");
  const stop = () => { process.stdout.write("\x1b[?25h\n"); process.exit(0); };
  process.on("SIGINT", stop);
  for (;;) {
    const f = await frame().catch(() => f0);
    process.stdout.write("\x1b[H\x1b[2J" + draw(f) + `\n\n  ${dim("ctrl-c to leave · the agent keeps running")}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const describeExit = (x: import("@vesk-agent/core").ExitSpec) => [x.takeProfit?.length ? `TP ${x.takeProfit.map((t) => `${t.atMultiple}x`).join("/")}` : "", x.stopLossPct ? `SL ${x.stopLossPct}%` : "", x.trailingStopPct ? `trail ${x.trailingStopPct}%` : "", x.timeoutMin ? `${x.timeoutMin} min` : ""].filter(Boolean).join(" · ");
