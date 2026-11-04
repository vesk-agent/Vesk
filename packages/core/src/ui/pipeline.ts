/**
 * The agent's pipeline, as structured events (v19): every candidate the agent considers goes
 *   watch → check → size → execute → exit → log
 * and each step it reaches is one PipelineEvent with its outcome, reason and timing. The agent emits them as it works
 * (State.stage); the panel's Live page, `vesk live` and the hosted report path all read the same events through
 * `liveView`. Activity rows from before v19 (or from the hosted engine) map onto the same shape (`eventsFromActivity`),
 * so Live works with either source.
 * Pure: no I/O, no clock reads except where a `now` is passed in.
 */
import type { Activity } from "../types.js";
import type { LaneKind } from "../work/queue.js";

export type Stage = "watch" | "check" | "size" | "execute" | "exit" | "log";
export const STAGES: Stage[] = ["watch", "check", "size", "execute", "exit", "log"];
/** What each stage does, in one line (the Live page and `vesk live` show these). */
export const STAGE_INFO: Record<Stage, { label: string; role: string }> = {
  watch: { label: "Watch", role: "X posts, new pairs and tracked wallets" },
  check: { label: "Check", role: "Refuses anything outside your limits" },
  size: { label: "Size", role: "Your preset and limits set the amount" },
  execute: { label: "Execute", role: "Signs here, sends through Jito or your RPC" },
  exit: { label: "Exit", role: "Take-profit, stop-loss and timers" },
  log: { label: "Log", role: "Every decision, with its reason" },
};

/** start: the stage is working on it · pass: it went on · fail: it stopped here (filtered or failed) · done: finished. */
export type Outcome = "start" | "pass" | "fail" | "done";
export type Source = "x" | "pulse" | "wallet" | "migration" | "order" | "panel" | "launch";
export type DecisionAction = "enter" | "exit" | "filtered" | "skipped" | "copied" | "launched";

export interface PipelineEvent {
  at: number;
  /** One candidate's id, the same on every stage it reaches. */
  id: string;
  stage: Stage;
  outcome: Outcome;
  source?: Source;
  mint?: string;
  symbol?: string;
  /** Why: the rule that matched, the guardrail or audit that refused, the exit that fired. */
  reason?: string;
  /** How long the stage took (execute: click-to-confirmed landing). */
  ms?: number;
  amountSol?: number;
  preset?: string;
  signature?: string;
  /** Paper mode: decided, never signed. */
  paper?: boolean;
  /** For the decision log: what this terminal event means. */
  action?: DecisionAction;
  /** The result column: "+0.42 SOL", "not traded", "0.25 SOL". */
  result?: string;
  /** v20: the lane it ran in (trade, copy, rogue, launch); worked out from the source when missing. */
  lane?: LaneKind;
}

const KEEP = 300;
/** Append and keep the newest KEEP events (the agent's ring buffer). */
export function pushEvent(list: PipelineEvent[], e: PipelineEvent): PipelineEvent[] {
  list.push(e);
  if (list.length > KEEP) list.splice(0, list.length - KEEP);
  return list;
}

/** Clean an event that came over the wire (the report body, a stored row). Unknown stages / outcomes are dropped. */
export function normalizeEvent(x: unknown): PipelineEvent | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const stage = String(o.stage) as Stage, outcome = String(o.outcome) as Outcome;
  if (!STAGES.includes(stage) || !["start", "pass", "fail", "done"].includes(outcome)) return null;
  const s = (v: unknown, n: number) => (typeof v === "string" && v ? v.slice(0, n) : undefined);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const at = num(o.at); const id = s(o.id, 48);
  if (at === undefined || !id) return null;
  const actions: DecisionAction[] = ["enter", "exit", "filtered", "skipped", "copied", "launched"];
  const sources: Source[] = ["x", "pulse", "wallet", "migration", "order", "panel", "launch"];
  return {
    at, id, stage, outcome,
    source: sources.includes(o.source as Source) ? (o.source as Source) : undefined,
    mint: s(o.mint, 48), symbol: s(o.symbol, 16), reason: s(o.reason, 240), ms: num(o.ms), amountSol: num(o.amountSol),
    preset: s(o.preset, 8), signature: s(o.signature, 100), paper: o.paper === true ? true : undefined,
    action: actions.includes(o.action as DecisionAction) ? (o.action as DecisionAction) : undefined, result: s(o.result, 40),
    lane: ["trade", "copy", "rogue", "launch"].includes(o.lane as string) ? (o.lane as LaneKind) : undefined,
  };
}

// ---------------------------------------------------------------- from activity rows (hosted engine, older agents)
const sym = (m: string) => /\$([A-Z0-9]{2,12})\b/.exec(m)?.[1] ?? /^([A-Z0-9]{2,12})[: ]/.exec(m)?.[1];
/**
 * Activity rows as pipeline events: a signal is a candidate reaching Watch; a skip or a guardrail refusal stops it at
 * Check; a buy is a landed Execute; tp / sl / trail / timeout are Exits; a launch is Launched. Consecutive rows on the
 * same coin share a candidate id, so a signal followed by its skip reads as one candidate filtered.
 */
export function eventsFromActivity(rows: Activity[]): PipelineEvent[] {
  const out: PipelineEvent[] = [];
  const open = new Map<string, string>();
  const asc = [...rows].sort((a, b) => a.at - b.at);
  for (const a of asc) {
    const key = a.mint ?? a.message.slice(0, 24);
    const symbol = sym(a.message);
    const base = { at: a.at, mint: a.mint, symbol, ms: a.latencyMs, signature: a.signature };
    const reason = a.message.replace(/^\[paper\]\s*/, "");
    if (a.kind === "signal") {
      const id = `a${a.at}${key.slice(0, 6)}`;
      open.set(key, id);
      out.push({ ...base, id, stage: "watch", outcome: "pass", source: /posted|@/.test(a.message) ? "x" : /launch|pair/i.test(a.message) ? "pulse" : undefined, reason });
    } else if (a.kind === "skip" || a.kind === "guardrail") {
      const id = open.get(key) ?? `a${a.at}${key.slice(0, 6)}`;
      open.delete(key);
      out.push({ ...base, id, stage: "check", outcome: "fail", reason, action: a.kind === "skip" ? "skipped" : "filtered", result: "not traded" });
    } else if (a.kind === "buy") {
      const id = open.get(key) ?? `a${a.at}${key.slice(0, 6)}`;
      open.delete(key);
      const copied = /^copied/i.test(reason);
      out.push({ ...base, id, stage: "check", outcome: "pass", at: a.at - 1 });
      out.push({ ...base, id, stage: "execute", outcome: "done", reason, amountSol: a.solDelta ? Math.abs(a.solDelta) : undefined, paper: /^\[paper\]/.test(a.message) || undefined, action: copied ? "copied" : "enter", result: a.solDelta ? `${Math.abs(a.solDelta)} SOL` : undefined });
    } else if (a.kind === "sell" || a.kind === "tp" || a.kind === "sl" || a.kind === "trail" || a.kind === "timeout") {
      out.push({ ...base, id: `x${a.at}${key.slice(0, 6)}`, stage: "exit", outcome: "done", reason, action: "exit", result: a.solDelta ? `${a.solDelta >= 0 ? "+" : "−"}${Math.abs(a.solDelta).toFixed(3)} SOL` : undefined });
    } else if (a.kind === "launch") {
      out.push({ ...base, id: `l${a.at}${key.slice(0, 6)}`, stage: "execute", outcome: "done", source: "launch", reason, action: "launched" });
    }
  }
  return out;
}

// ---------------------------------------------------------------- the view
export type NodeState = "idle" | "working" | "pass" | "fail" | "blocked";
export interface StageNode {
  stage: Stage;
  state: NodeState;
  /** The last thing this stage did, in a few words ("passed $GLINT", "landed in 212 ms"). */
  last?: string;
  at?: number;
  /** Set when setup is missing: "needs RPC". */
  blocked?: string;
}
export interface LiveDecision {
  at: number;
  id: string;
  action: DecisionAction;
  mint?: string;
  symbol?: string;
  /** Where the candidate came from (for rows without a coin yet: an X post with no contract address). */
  source?: Source;
  reason: string;
  result?: string;
  ms?: number;
  paper?: boolean;
}
export interface Candidate {
  id: string;
  mint?: string;
  symbol?: string;
  source?: Source;
  /** The furthest stage it reached and how it ended there. */
  stage: Stage;
  outcome: Outcome;
  reason?: string;
  at: number;
  ms?: number;
  /** Its decision is written to the log: nothing more will happen to it. */
  done?: boolean;
  /** v20: its lane, and when its first step happened. */
  lane: LaneKind;
  startAt: number;
}
export interface LiveCounters {
  watched: number;
  checked: number;
  filtered: number;
  /** The most common reason something was filtered, and how often. */
  topReason?: { reason: string; n: number };
  sized?: { preset?: string; amountSol?: number; reason?: string };
  executed: number;
  avgLandingMs?: number;
  exits: number;
  logLines: number;
}
export interface LiveView {
  nodes: StageNode[];
  counters: LiveCounters;
  /** The candidate moving through the pipe right now (or the last one), newest first in `recent`. */
  current?: Candidate;
  recent: Candidate[];
  /** Incoming: the newest candidates at Watch, newest first. */
  incoming: Candidate[];
  /** Filtered lane: the newest candidates stopped at Check, with their reasons. */
  filtered: Candidate[];
  decisions: LiveDecision[];
  /**
   * v20: the candidates being worked on right now across lanes (and ones that finished in the last `lingerMs`, so a
   * landing or a filter is seen), oldest start first. The page gives each its own lane row.
   */
  active: Candidate[];
}

/** v20: a candidate's lane from its events: the lane the executor reported, else from where it came from. */
export function laneOfEvents(l: PipelineEvent[]): LaneKind {
  const e = l.find((x) => x.lane);
  if (e?.lane) return e.lane;
  const src = l.find((x) => x.source)?.source;
  if (src === "wallet") return "copy";
  if (src === "launch" || l.some((x) => x.action === "launched")) return "launch";
  if (l.some((x) => /^Rogue[:·]/.test(x.reason ?? ""))) return "rogue";
  return "trade";
}

/** A short reason class for counting ("mcap $81K is above $50K" and "mcap $95K is above $50K" are one reason). */
export function reasonClass(r: string): string {
  return r.replace(/\$[\d.,]+[KMB]?/g, "$…").replace(/\d+(\.\d+)?/g, "#").replace(/\s+/g, " ").trim();
}

/**
 * The Live page's model from events (oldest first or any order). `now` decides whether a stage is still "working"
 * (a start in the last `workMs`). `blocked` greys stages that can't run ("needs RPC").
 */
export function liveView(events: PipelineEvent[], opts: { now: number; workMs?: number; blocked?: Partial<Record<Stage, string>>; openExits?: number; lingerMs?: number; staleMs?: number } = { now: Date.now() }): LiveView {
  const ev = [...events].sort((a, b) => a.at - b.at);
  const work = opts.workMs ?? 1500;
  const byId = new Map<string, PipelineEvent[]>();
  for (const e of ev) { const l = byId.get(e.id) ?? []; l.push(e); byId.set(e.id, l); }

  // nodes: the last event per stage
  const nodes: StageNode[] = STAGES.map((stage) => {
    const blocked = opts.blocked?.[stage];
    const found = [...ev].reverse().find((e) => e.stage === stage);
    // the coin's ticker from any step of the same candidate, when this step didn't carry it
    const last = found && !found.symbol ? { ...found, symbol: byId.get(found.id)?.find((x) => x.symbol)?.symbol, mint: found.mint ?? byId.get(found.id)?.find((x) => x.mint)?.mint } : found;
    if (blocked) return { stage, state: "blocked", blocked, last: last ? lastLine(last) : undefined, at: last?.at };
    if (!last) return { stage, state: "idle" };
    const state: NodeState = last.outcome === "start" ? (opts.now - last.at < work ? "working" : "idle") : last.outcome === "fail" ? "fail" : "pass";
    return { stage, state, last: lastLine(last), at: last.at };
  });

  // candidates: furthest stage reached
  // (the log line written after a decision isn't a step the candidate reached; it only marks it done)
  const cands: Candidate[] = [...byId.entries()].flatMap(([id, all]) => {
    const l = all.filter((x) => x.stage !== "log");
    if (!l.length) return [];
    // a refusal ends it where it happened, even when a later stage already reported (the agent sizes a buy before
    // the guardrails make the final check)
    const far = l.find((x) => x.outcome === "fail") ?? l.reduce((a, b) => (STAGES.indexOf(b.stage) > STAGES.indexOf(a.stage) || (b.stage === a.stage && b.at >= a.at) ? b : a));
    const info = l.find((x) => x.symbol) ?? l[0];
    return [{ id, mint: info.mint, symbol: info.symbol, source: l.find((x) => x.source)?.source, stage: far.stage, outcome: far.outcome, reason: far.reason ?? l.find((x) => x.reason)?.reason, at: all[all.length - 1].at, ms: far.ms, done: all.some((x) => x.stage === "log") || undefined, lane: laneOfEvents(all), startAt: all[0].at }];
  }).sort((a, b) => b.at - a.at);

  const reasons = new Map<string, { reason: string; n: number }>();
  let watched = 0, checked = 0, filtered = 0, executed = 0, exits = 0, logLines = 0, msSum = 0, msN = 0;
  let sized: LiveCounters["sized"];
  for (const e of ev) {
    if (e.stage === "watch" && e.outcome !== "start") watched++;
    if (e.stage === "check" && (e.outcome === "pass" || e.outcome === "fail")) checked++;
    if (e.stage === "check" && e.outcome === "fail") {
      filtered++;
      if (e.reason) { const k = reasonClass(e.reason); const r = reasons.get(k) ?? { reason: e.reason, n: 0 }; r.n++; r.reason = e.reason; reasons.set(k, r); }
    }
    if (e.stage === "size" && e.outcome === "pass") sized = { preset: e.preset, amountSol: e.amountSol, ...(e.reason ? { reason: e.reason } : {}) };
    if (e.stage === "execute" && e.outcome === "done") { executed++; if (e.ms !== undefined) { msSum += e.ms; msN++; } }
    if (e.stage === "exit" && e.outcome === "done") exits++;
    if (e.stage === "log") logLines++;
  }
  const topReason = [...reasons.values()].sort((a, b) => b.n - a.n)[0];

  const decisions: LiveDecision[] = [];
  for (const e of ev) {
    const action = e.action ?? (e.stage === "check" && e.outcome === "fail" ? "filtered" : e.stage === "execute" && e.outcome === "done" ? "enter" : e.stage === "exit" && e.outcome === "done" ? "exit" : undefined);
    if (!action) continue;
    const c = byId.get(e.id) ?? [];
    decisions.push({ at: e.at, id: e.id, action, mint: e.mint ?? c.find((x) => x.mint)?.mint, symbol: e.symbol ?? c.find((x) => x.symbol)?.symbol, source: e.source ?? c.find((x) => x.source)?.source, reason: e.reason ?? c.find((x) => x.reason)?.reason ?? "", result: e.result ?? (e.ms !== undefined && action !== "filtered" ? `${e.ms} ms` : undefined), ms: e.ms, paper: e.paper });
  }
  decisions.reverse();

  return {
    nodes,
    counters: { watched, checked, filtered, topReason, sized, executed, avgLandingMs: msN ? Math.round(msSum / msN) : undefined, exits: opts.openExits ?? exits, logLines: logLines || decisions.length },
    current: cands[0],
    recent: cands.slice(0, 12),
    incoming: cands.filter((c) => c.stage === "watch").slice(0, 6),
    filtered: cands.filter((c) => c.stage === "check" && c.outcome === "fail").slice(0, 8),
    decisions: decisions.slice(0, 200),
    active: cands.filter((c) => (c.done ? opts.now - c.at < (opts.lingerMs ?? 2600) : opts.now - c.at < (opts.staleMs ?? 15_000))).sort((a, b) => a.startAt - b.startAt),
  };
}

function lastLine(e: PipelineEvent): string {
  const t = e.symbol ? `$${e.symbol}` : e.mint ? `${e.mint.slice(0, 4)}…` : "";
  if (e.stage === "execute" && e.outcome === "done") return `${e.paper ? "paper · " : ""}landed${e.ms !== undefined ? ` in ${e.ms} ms` : ""}${t ? ` · ${t}` : ""}`;
  if (e.stage === "execute" && e.outcome === "fail") return `failed${t ? ` · ${t}` : ""}`;
  if (e.stage === "check" && e.outcome === "fail") return `filtered ${t}`.trim();
  if (e.stage === "check" && e.outcome === "pass") return `passed ${t}`.trim();
  if (e.stage === "size" && e.outcome === "pass") return [e.preset?.toUpperCase(), e.amountSol !== undefined ? `${e.amountSol} SOL` : ""].filter(Boolean).join(" · ") || "sized";
  if (e.stage === "exit") return `${e.reason ?? "exit"}${t ? ` · ${t}` : ""}`;
  if (e.stage === "watch") return `${e.outcome === "start" ? "reading" : "matched"} ${t}`.trim();
  if (e.stage === "log") return e.reason ?? "written";
  return e.outcome;
}

// ---------------------------------------------------------------- readiness
export type ReadyState = "ok" | "setup" | "error" | "optional";
export interface ReadyRow {
  key: "wallet" | "rpc" | "model" | "x" | "agent" | "telegram" | "access";
  label: string;
  state: ReadyState;
  detail: string;
  /** Where to fix it (a panel path). */
  href: string;
}
export interface ReadyInput {
  wallet: { address: string | null; balanceSol?: number | null };
  rpc: { url: string | null; kind?: string; p50?: number; error?: string };
  model: { provider?: string; keySet: boolean; local?: boolean };
  x: { source: "relay" | "official-api" | "provider" | "stream" | "poll" | "off"; keySaved?: boolean; hostedWatcher?: boolean };
  agent: { mode: "self" | "hosted" | null; state: "online" | "paused" | "stopped" | "never" };
  telegram: { linked: boolean; username?: string };
  access: { enabled: boolean; ok: boolean; held?: number; min?: number };
}

/** The "Ready to run" checklist. Telegram is optional and never blocks. */
export function readiness(i: ReadyInput): ReadyRow[] {
  const rows: ReadyRow[] = [];
  rows.push(i.wallet.address
    ? { key: "wallet", label: "Wallet", state: i.wallet.balanceSol === 0 ? "error" : "ok", detail: i.wallet.balanceSol === 0 ? "0 SOL: fund it to trade" : `${i.wallet.address.slice(0, 4)}…${i.wallet.address.slice(-4)}${i.wallet.balanceSol != null ? ` · ${i.wallet.balanceSol.toFixed(3)} SOL` : ""}`, href: "/app/wallets" }
    : { key: "wallet", label: "Wallet", state: "setup", detail: "No trading wallet yet", href: "/app/wallets" });
  rows.push(i.rpc.error
    ? { key: "rpc", label: "RPC", state: "error", detail: i.rpc.error, href: "/app/connections#rpc" }
    : i.rpc.url || i.rpc.kind
      ? { key: "rpc", label: "RPC", state: "ok", detail: `${i.rpc.kind ?? "custom"}${i.rpc.p50 !== undefined ? ` · ${i.rpc.p50} ms` : ""}`, href: "/app/connections#rpc" }
      : { key: "rpc", label: "RPC", state: "setup", detail: "Add your RPC URL", href: "/app/connections#rpc" });
  rows.push(i.model.keySet || i.model.local
    ? { key: "model", label: "AI model", state: "ok", detail: `${i.model.provider ?? "model"} · ${i.model.local ? "local" : "key saved"}`, href: "/app/connections#model" }
    : { key: "model", label: "AI model", state: "setup", detail: `${i.model.provider ? `${i.model.provider}: ` : ""}no key saved`, href: "/app/connections#model" });
  rows.push(i.x.source === "off"
    ? { key: "x", label: "X source", state: "setup", detail: "Off: posts aren't watched", href: "/app/connections#x" }
    : i.x.source === "official-api" && !i.x.keySaved
      ? { key: "x", label: "X source", state: "setup", detail: "Own API: no key saved", href: "/app/connections#x" }
      : { key: "x", label: "X source", state: "ok", detail: i.x.source === "relay" ? "relay (holders)" : i.x.source === "official-api" ? "own API" : i.x.source, href: "/app/connections#x" });
  rows.push(i.agent.mode === null || i.agent.state === "never"
    ? { key: "agent", label: "Agent", state: "setup", detail: "Pair your agent or use hosted", href: "/app/connections#agent" }
    : i.agent.state === "stopped"
      ? { key: "agent", label: "Agent", state: "error", detail: i.agent.mode === "self" ? "Offline: not reporting" : "Hosted agent stopped", href: "/app/connections#agent" }
      : { key: "agent", label: "Agent", state: "ok", detail: `${i.agent.mode === "self" ? "self-hosted, paired" : "hosted"}${i.agent.state === "paused" ? " · paused" : ""}`, href: "/app/connections#agent" });
  rows.push(i.telegram.linked
    ? { key: "telegram", label: "Telegram", state: "ok", detail: i.telegram.username ? `@${i.telegram.username}` : "linked", href: "/app/connections#telegram" }
    : { key: "telegram", label: "Telegram", state: "optional", detail: "Optional: alerts on your phone", href: "/app/connections#telegram" });
  rows.push(!i.access.enabled
    ? { key: "access", label: "Holder access", state: "ok", detail: "Not required yet", href: "/app/access" }
    : i.access.ok
      ? { key: "access", label: "Holder access", state: "ok", detail: "Verified", href: "/app/access" }
      : { key: "access", label: "Holder access", state: "setup", detail: i.access.min ? `Hold ${i.access.min.toLocaleString("en-US")} to use hosted features` : "Not verified", href: "/app/access" });
  return rows;
}

/** Rows that still need doing (Telegram, being optional, never counts). */
export const missing = (rows: ReadyRow[]) => rows.filter((r) => r.state === "setup" || r.state === "error");

/** Which stages can't run, and why, from the checklist. */
export function blockedStages(rows: ReadyRow[]): Partial<Record<Stage, string>> {
  const bad = (k: ReadyRow["key"]) => rows.some((r) => r.key === k && (r.state === "setup" || r.state === "error"));
  const b: Partial<Record<Stage, string>> = {};
  if (bad("agent")) { for (const s of STAGES) b[s] = rows.find((r) => r.key === "agent")!.state === "error" ? "agent offline" : "needs an agent"; return b; }
  if (bad("x")) b.watch = "needs an X source";
  if (bad("wallet")) b.size = b.execute = "needs a wallet";
  if (bad("rpc")) { b.check = b.execute = "needs RPC"; b.exit = "needs RPC"; }
  return b;
}

// ---------------------------------------------------------------- the terminal view (vesk live)
type Paint = { dim: (s: string) => string; up: (s: string) => string; down: (s: string) => string; ice: (s: string) => string; warn: (s: string) => string; bold: (s: string) => string };
const plain: Paint = { dim: (s) => s, up: (s) => s, down: (s) => s, ice: (s) => s, warn: (s) => s, bold: (s) => s };
const ACTION_WORD: Record<DecisionAction, string> = { enter: "ENTER", exit: "EXIT", filtered: "FILTERED", skipped: "SKIPPED", copied: "COPIED", launched: "LAUNCHED" };
const SOURCE_WORD: Record<Source, string> = { x: "X post", pulse: "new pair", wallet: "wallet", migration: "migration", order: "order", panel: "panel", launch: "launch" };
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 8);

/** `vesk live`: the same view as the panel's Live page, as lines of text. */
export function renderLive(v: LiveView, h: { status: string; mode: string; pnlTodaySol: number; positions: Array<{ symbol: string; costSol: number; pnlPct: number; reason?: string; exits?: string }>; width?: number; rogue?: { text: string; left: string } | null; sources?: { snipe: boolean; copy: boolean; pulse: boolean; launchOnPost: boolean }; work?: { lanes: number; launches: number; busy: number; queued: number; inFlight: Record<LaneKind, number> } | null }, p: Paint = plain): string[] {
  const W = Math.max(60, Math.min(h.width ?? 100, 120));
  const out: string[] = [];
  const pnl = h.pnlTodaySol;
  out.push(`  ${p.bold("vesk live")}  ${h.status === "online" ? p.ice("● running") : h.status === "paused" ? p.warn("‖ paused") : p.dim("○ " + h.status)}  ${p.dim(h.mode)}   today ${pnl >= 0 ? p.up(`+${pnl.toFixed(3)} SOL`) : p.down(`${pnl.toFixed(3)} SOL`)}   ${v.counters.executed} trades`);
  // v19: a running Rogue session sits right under the header, with its countdown
  // v19.1: the sources it trades from, each on or off
  if (h.sources) out.push("  " + p.dim("trading from ") + ([["snipe", "Snipe"], ["copy", "Copy"], ["pulse", "Pulse"], ["launchOnPost", "Launch on post"]] as const).map(([k, l]) => (h.sources![k] ? `${l} ${p.ice("on")}` : p.dim(`${l} off`))).join(p.dim(" · ")));
  if (h.rogue) out.push(`  ${p.ice("◇")} ${h.rogue.text}  ${p.dim(`${h.rogue.left} left`)}`);
  out.push("");
  // the pipeline: one cell per stage
  const cw = Math.floor((W - 4) / STAGES.length);
  // colour means money only: stages are ice (passed / working) or grey (filtered, idle); a blocked one is a warning
  const mark = (n: StageNode) => (n.state === "working" ? p.ice("◆") : n.state === "pass" ? p.ice("●") : n.state === "fail" ? p.dim("●") : n.state === "blocked" ? p.warn("○") : p.dim("○"));
  out.push("  " + v.nodes.map((n) => `${mark(n)} ${pad(STAGE_INFO[n.stage].label, cw - 4)}`).join(p.dim("→ ")));
  out.push("  " + v.nodes.map((n) => p.dim(pad(n.blocked ?? n.last ?? "idle", cw - 2)) + "  ").join(""));
  const c = v.counters;
  const line = v.nodes.find((n) => n.stage === "log")?.last?.match(/#(\d+)/)?.[1];
  const sized = c.sized ? `${c.sized.preset ? c.sized.preset.toUpperCase() + " " : ""}${c.sized.amountSol ?? ""} SOL`.trim() : undefined;
  out.push("  " + p.dim([`watched ${c.watched}`, `checked ${c.checked}`, `filtered ${c.filtered}`, sized ? `sized ${sized}` : "", `executed ${c.executed}${c.avgLandingMs !== undefined ? ` (avg ${c.avgLandingMs} ms)` : ""}`, `exits armed ${c.exits}`, line ? `log line #${line}` : `${c.logLines} logged`].filter(Boolean).join(" · ")));
  if (c.topReason) out.push(`  ${p.dim("top filter reason:")} ${c.topReason.reason} ${p.dim(`(${c.topReason.n}×)`)}`);
  // v20: parallel lanes: how busy they are and what each is working on
  if (h.work) {
    const w = h.work;
    out.push("  " + p.dim(`lanes ${w.inFlight.trade + w.inFlight.copy + w.inFlight.rogue}/${w.lanes} busy · launches ${w.inFlight.launch}/${w.launches} · ${w.queued} queued`));
    for (const a of v.active.filter((x) => !x.done).slice(0, 5)) out.push(`  ${p.dim(pad(a.lane, 7))} ${pad(a.symbol ? "$" + a.symbol : a.mint ? a.mint.slice(0, 6) + "…" : "…", 10)} ${p.ice(STAGE_INFO[a.stage].label.toLowerCase())}${a.outcome === "start" ? "…" : ""}`);
  }
  out.push("");
  out.push(`  ${p.dim("NOW TRADING")}`);
  if (!h.positions.length) out.push(`  ${p.dim("nothing open")}`);
  for (const x of h.positions.slice(0, 4)) out.push(`  ${p.ice(pad(x.symbol.endsWith("…") ? x.symbol : "$" + x.symbol, 10))} ${pad(x.costSol.toFixed(3) + " SOL", 11)} ${x.pnlPct >= 0 ? p.up(pad(`+${x.pnlPct.toFixed(1)}%`, 8)) : p.down(pad(`${x.pnlPct.toFixed(1)}%`, 8))} ${p.dim(x.reason ?? "")}${x.exits ? p.dim(` · exits ${x.exits}`) : ""}`);
  out.push("");
  out.push(`  ${p.dim("DECISIONS")}`);
  for (const d of v.decisions.slice(0, 10)) {
    const word = ACTION_WORD[d.action];
    const tone = d.action === "filtered" || d.action === "skipped" ? p.dim : d.action === "exit" ? p.warn : p.up;
    out.push(`  ${p.dim(hhmm(d.at))}  ${tone(pad(word, 9))} ${pad(d.symbol ? "$" + d.symbol : d.mint ? d.mint.slice(0, 6) + "…" : d.source ? SOURCE_WORD[d.source] : "", 10)} ${pad(d.reason, Math.max(20, W - 46))} ${p.dim(d.result ?? "")}`.trimEnd());
  }
  if (!v.decisions.length) out.push(`  ${p.dim("no decisions yet")}`);
  return out;
}
