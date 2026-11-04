import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultNotifySettings, groupSummary, inboxLink, inboxSections, INBOX_MAX, isSticky, markAllRead, normalizeInbox, normalizeNotifySettings,
  rateAllow, routeNotification, unreadCount, upsertInbox, type InboxItem,
} from "../src/ui/notify.js";
import { defaultPanelSettings, normalizePanelSettings } from "../src/ui/panelSettings.js";

const MINT = "Borqy3dEjw9az7Uj9nW69A9ZDansFGHWEggUx7tkpump";

test("notify settings: defaults, and bad input falls back per field", () => {
  const d = defaultNotifySettings();
  assert.equal(d.dnd, false);
  assert.deepEqual(d.kinds.error, { toast: true, sound: "off", desktop: false });
  const n = normalizeNotifySettings({ dnd: true, kinds: { trade: { toast: false, sound: "airhorn", desktop: "yes" }, nope: { toast: false } } });
  assert.equal(n.dnd, true);
  assert.deepEqual(n.kinds.trade, { toast: false, sound: "soft", desktop: false });
  assert.equal((n.kinds as Record<string, unknown>).nope, undefined);
  assert.deepEqual(defaultPanelSettings().notify, d);
  assert.equal(normalizePanelSettings({ notify: { dnd: true } }).notify.dnd, true);
});

test("routing: per-kind settings, errors always pop up, Do Not Disturb silences the rest", () => {
  const s = defaultNotifySettings();
  s.kinds.tracker = { toast: false, sound: "tick", desktop: true };
  assert.deepEqual(routeNotification(s, "tracker", false), { toast: false, sound: "tick", desktop: true });
  assert.equal(routeNotification(s, "tracker", true).toast, true, "a failure still pops up with its toast off");
  s.dnd = true;
  assert.deepEqual(routeNotification(s, "launch", false), { toast: false, sound: "off", desktop: false });
  assert.deepEqual(routeNotification(s, "trade", true), { toast: true, sound: "off", desktop: false });
  assert.equal(isSticky("error", false), true);
  assert.equal(isSticky("trade", true), true);
  assert.equal(isSticky("tracker", false), false);
});

test("inbox: normalised, deduped by id, capped, newest first; links stay in the panel", () => {
  const raw = [
    { id: "a", at: 1, kind: "trade", title: "Bought", mint: MINT, read: false },
    { id: "a", at: 2, kind: "trade", title: "dup" },
    { id: "b", at: 3, kind: "weird", title: "Hello", href: "https://evil.example", wallet: "not-a-wallet" },
    { id: "c", at: 4, kind: "order", title: "Filled", href: "/app/positions", read: true, n: 3 },
    { at: 5, title: "no id" },
  ];
  const l = normalizeInbox(raw);
  assert.deepEqual(l.map((x) => x.id), ["c", "b", "a"]);
  assert.equal(l[1].kind, "info");
  assert.equal(l[1].href, undefined);
  assert.equal(l[1].wallet, undefined);
  assert.equal(l[0].n, 3);
  const big = normalizeInbox(Array.from({ length: 300 }, (_, i) => ({ id: `x${i}`, at: i, title: "t" })));
  assert.equal(big.length, INBOX_MAX);
  assert.equal(big[0].id, "x299");
});

test("inbox: upsert, unread, mark all read, sections and links", () => {
  let l: InboxItem[] = [];
  l = upsertInbox(l, { id: "1", at: 10, kind: "trade", title: "Buying…", read: false, mint: MINT });
  l = upsertInbox(l, { id: "1", at: 10, kind: "trade", title: "Bought", read: false, mint: MINT });
  l = upsertInbox(l, { id: "2", at: 5, kind: "copy", title: "Copied", read: false });
  assert.equal(l.length, 2);
  assert.equal(l[0].title, "Bought");
  assert.equal(unreadCount(l), 2);
  assert.equal(unreadCount(markAllRead(l)), 0);
  const s = inboxSections(l, 8);
  assert.deepEqual([s.today.map((x) => x.id), s.earlier.map((x) => x.id)], [["1"], ["2"]]);
  assert.equal(inboxLink(l[0]), `/app/coin/${MINT}`);
  assert.equal(inboxLink(l[1]), "/app/copy");
  assert.equal(inboxLink({ id: "x", at: 1, kind: "info", title: "Saved", read: false }), null);
});

test("rate limit: six toasts per four seconds, then the rest go to the centre", () => {
  let times: number[] = [];
  const allowed: boolean[] = [];
  for (let i = 0; i < 9; i++) { const r = rateAllow(times, 1000 + i * 100); times = r.times; allowed.push(r.allow); }
  assert.deepEqual(allowed, [true, true, true, true, true, true, false, false, false]);
  assert.equal(rateAllow(times, 1000 + 5000).allow, true, "the window moves on");
});

test("burst summaries read as sentences", () => {
  assert.equal(groupSummary("tracker", 3, "Night desk", "buy"), "3 buys from Night desk");
  assert.equal(groupSummary("tracker", 2, "Early bird", "mixed"), "2 trades from Early bird");
  assert.equal(groupSummary("copy", 4), "4 copies");
  assert.equal(groupSummary("exit", 2), "2 exits");
});

import { closedCsv, csvCell, holdingsCsv, portfolioCard, type ClosedPosition } from "../src/portfolio/stats.js";
const DAYMS = 86_400_000;
const cp = (symbol: string, inv: number, pnl: number, ago: number): ClosedPosition => ({ mint: MINT, symbol, investedSol: inv, returnedSol: inv + pnl, pnlSol: pnl, pnlPct: (pnl / inv) * 100, openedAt: 0, closedAt: 100 * DAYMS - ago * DAYMS, origin: { kind: "manual", label: "Manual" } });

test("share card: realized over a period, win rate, best trade", () => {
  const now = 100 * DAYMS;
  const xs = [cp("A", 1, 0.5, 1), cp("B", 1, -0.25, 3), cp("C", 2, 3, 20)];
  const w = portfolioCard(xs, now, "7d");
  assert.deepEqual([w.trades, w.pnlSol, w.investedSol, w.pct, w.winRate, w.best?.symbol], [2, 0.25, 2, 12.5, 50, "A"]);
  const a = portfolioCard(xs, now, "all");
  assert.equal(a.trades, 3); assert.equal(a.best?.symbol, "C");
  assert.equal(portfolioCard([], now, "30d").pct, null);
});

test("CSV: quoted when needed, formulas defused, numbers stay numbers", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvCell("-1 dog"), "'-1 dog");
  assert.equal(csvCell(-0.5), "-0.5");
  assert.equal(csvCell(NaN), "");
  const h = holdingsCsv([{ mint: MINT, symbol: "GL,INT", tokens: 1000, costSol: 0.1, valueSol: 0.15, pnlSol: 0.05, pnlPct: 50, openedAt: 86_400_000 }]).split("\r\n");
  assert.equal(h[0], "symbol,name,mint,tokens,cost_sol,value_sol,pnl_sol,pnl_pct,mcap_usd,opened_at");
  assert.ok(h[1].startsWith(`"GL,INT",,${MINT},1000,0.1,0.15,0.05,50,,1970-01-02T00:00:00.000Z`));
  const c = closedCsv([cp("X", 1, 0.5, 1)]).split("\r\n");
  assert.equal(c.length, 3);
  assert.ok(c[1].endsWith(",manual"));
});

import { launchFromPulse, paperRun } from "../src/rules/paper.js";
import { defaultRule } from "../src/rules/validate.js";
const CA2 = "6anbDQNCcVh2f6okexjaX1VGj6tEnizJ1kV5UTBSpump";
test("paper test: replays posts through the real matcher, counts toward the daily cap, never checks a made-up market cap", () => {
  const rule = defaultRule({ name: "t", enabled: false, trigger: { kind: "x-post", handles: ["junopark"], mode: "ca-in-post" }, maxBuysPerDay: 1 });
  rule.buy.maxMcapUsd = 50_000;
  const post = (id: string, handle: string, text: string, at: number) => ({ at, label: `@${handle}`, post: { id, handle, text, urls: [], createdAt: new Date(at).toISOString() } });
  const r = paperRun(rule, [post("1", "junopark", `new one ${MINT}`, 1000), post("2", "someone", `look ${MINT}`, 2000), post("3", "junopark", `again ${CA2}`, 3000), post("4", "junopark", "gm", 4000)]);
  assert.equal(r.buys, 1);
  assert.equal(r.skips, 3);
  assert.equal(r.unchecked, 1, "the market cap couldn't be checked for the post");
  const byAt = Object.fromEntries(r.rows.map((x) => [x.at, x]));
  assert.equal(byAt[1000].would, "buy");
  assert.match(byAt[1000].reason, /market cap not checked/);
  assert.match(byAt[2000].reason, /not on this rule/);
  assert.match(byAt[3000].reason, /1 buys for today/);
  assert.match(byAt[4000].reason, /no contract address/);
  assert.equal(r.spentSol, rule.buy.amountSol);
  assert.equal(r.rows[0].at, 4000, "newest first");
});

test("paper test: Pulse coins become launch events for new-launch rules", () => {
  const rule = defaultRule({ name: "l", enabled: true, trigger: { kind: "new-launch", launchpad: "pumpfun", filters: { maxDevHoldingPct: 5, requireSocials: ["x"] } } });
  const t = { mint: MINT, name: "Glint", symbol: "GLINT", protocol: "pumpfun", creator: CA2, createdAt: 1000, liquiditySol: 8, mcapSol: 40, socials: { x: "https://x.com/glint" } };
  const ok = paperRun(rule, [{ at: 1000, label: "$GLINT", launch: launchFromPulse(t, 20_000_000, 150), market: { mint: MINT, priceSol: 0, priceUsd: 0, mcapUsd: 6000, liquiditySol: 8, onCurve: true, at: 1000 } }]);
  assert.equal(ok.buys, 1);
  const bad = paperRun(rule, [{ at: 1000, label: "$GLINT", launch: launchFromPulse({ ...t, socials: {} }, 90_000_000, 150), market: null }]);
  assert.equal(bad.buys, 0);
  assert.match(bad.rows[0].reason, /dev holds 9\.0%/);
});
