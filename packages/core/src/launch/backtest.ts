/**
 * v26: backtest (paper replay) a launch-on-post rule. Replays posts from the chosen accounts (the last N days from your
 * X API when it returns history; otherwise the posts the tracker stored, and the result says so; sample posts in the
 * offline preview) through the real matcher, priority order, topic dedupe, limits and coin draft, in time order, as if
 * the rule had been on. Nothing is drafted with your model, nothing is signed or spent. Pure.
 *
 * What can't be replayed honestly is said: velocity needs like counts over time, so a backtest uses the post's like
 * count as it is now (an upper bound) and marks those launches; the clash check needs the creates stream of that day,
 * which history doesn't have, so it isn't applied.
 */
import { checkAutoLaunch, draftToken, matchLaunchPost, normalizeLaunchRule, priorityHold, priorityOf, similarity, spendOf, topicClash, type LaunchOnPostRule, type LaunchRecord } from "./onpost.js";
import type { XPost } from "../types.js";

export interface BacktestRow { postId: string; handle: string; at: number; text: string; outcome: "launch" | "skip"; reason?: string; name?: string; symbol?: string; approx?: string }
export interface BacktestResult {
  from: number;
  to: number;
  posts: number;
  launches: number;
  spendSol: number;
  rows: BacktestRow[];
  /** skip reasons and how often */
  reasons: Array<{ reason: string; n: number }>;
  notes: string[];
  /** where the posts came from: your X API's history, the tracker's stored posts (relay or agent), sample posts, or none */
  source: "relay" | "x-api" | "tracker" | "sample" | "none";
}

const bucket = (r: string) => r.replace(/\d+(\.\d+)?/g, "N").replace(/@\w+/g, "@x").replace(/"[^"]*"/g, '"…"');

export function backtestRule(rule0: LaunchOnPostRule, posts: XPost[], o: { now?: number; days?: number; source?: BacktestResult["source"] } = {}): BacktestResult {
  const now = o.now ?? Date.now();
  const days = o.days ?? 7;
  const from = now - days * 86_400_000;
  const rule = { ...normalizeLaunchRule(rule0), enabled: true };
  const list = posts.filter((p) => +new Date(p.createdAt) >= from && +new Date(p.createdAt) <= now).sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
  const hist: LaunchRecord[] = [];
  const rows: BacktestRow[] = [];
  const reasons = new Map<string, number>();
  const notes: string[] = [];
  let velocityApprox = false;
  for (const p of list) {
    const at = +new Date(p.createdAt);
    const base = { postId: p.id, handle: p.handle, at, text: p.text.slice(0, 140) };
    const m = matchLaunchPost(rule, p, at);
    const skip = (reason: string) => { rows.push({ ...base, outcome: "skip", reason }); const k = bucket(reason); reasons.set(k, (reasons.get(k) ?? 0) + 1); };
    if (!m.ok) { if (m.reason !== "not a watched account") skip(m.reason); continue; }
    let approx: string | undefined;
    if (m.wait) {
      const likes = p.metrics?.likes;
      if (likes === undefined) { skip("likes not in the history, so velocity can't be replayed"); continue; }
      if (likes < m.wait.likes) { skip(`${likes} likes in total, below ${m.wait.likes}`); continue; }
      approx = `velocity from today's count (${likes} likes), not the first ${m.wait.withinSec} s`;
      velocityApprox = true;
    }
    const topic = topicClash(rule, p, hist, at);
    if (topic) { skip(topic); continue; }
    // priority: a post from an account lower in the list waits; a same-topic post from one higher up inside the wait wins
    const hold = priorityHold(rule, p.handle);
    if (hold) {
      const mine = priorityOf(rule, p.handle);
      const d = rule.trigger.dedupe!;
      const higher = list.find((q) => q !== p && +new Date(q.createdAt) >= at && +new Date(q.createdAt) <= at + hold * 1000 && priorityOf(rule, q.handle) > 0 && priorityOf(rule, q.handle) < mine && similarity(q.text, p.text) >= d.similarity && matchLaunchPost(rule, q, +new Date(q.createdAt)).ok);
      if (higher) { skip(`@${higher.handle} posted the same topic ${Math.max(1, Math.round((+new Date(higher.createdAt) - at) / 1000))} s later and is higher in your list`); continue; }
    }
    const g = checkAutoLaunch(rule, p, { killSwitch: false, history: hist, now: at });
    if (!g.ok) { skip(g.reason); continue; }
    const d = draftToken({ ...rule, coin: { ...rule.coin, naming: rule.coin.naming === "model" ? "template" : rule.coin.naming } }, p, null);
    if (d.errors.length) { skip(d.errors[0]); continue; }
    hist.push({ at, ruleId: rule.id, handle: p.handle, postId: p.id, status: "paper", sol: spendOf(rule), symbol: d.token.symbol, postText: p.text });
    rows.push({ ...base, outcome: "launch", name: d.token.name, symbol: d.token.symbol, ...(approx ? { approx } : {}) });
  }
  if (rule.coin.naming === "model") notes.push("Names come from the templates here; your model isn't called in a backtest.");
  if (velocityApprox) notes.push("Velocity is replayed from today's like counts, which can only be higher than in the first seconds.");
  notes.push("The clash check isn't replayed (it needs that day's pump.fun create stream).");
  const own = list.filter((p) => rule.trigger.handles.map((h) => h.toLowerCase()).includes(p.handle.toLowerCase())).length;
  if (o.source === "tracker") notes.unshift(`Your X source doesn't return post history, so this replays the ${own} post${own === 1 ? "" : "s"} the tracker stored from these accounts.`);
  const launches = rows.filter((r) => r.outcome === "launch").length;
  return {
    from, to: now, posts: own, launches,
    spendSol: +(launches * spendOf(rule)).toFixed(4), rows, reasons: [...reasons].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n), notes, source: o.source ?? "none",
  };
}
