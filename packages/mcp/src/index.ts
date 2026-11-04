/**
 * Vesk MCP server (stdio). Lets OpenClaw, Hermes Agent, Claude Code, Claude Desktop and any other
 * MCP client use Vesk's tools. Protocol: JSON-RPC 2.0, one message per line on stdin/stdout.
 *
 * Read-only tools work without unlocking anything. Tools that move funds (buy, sell, launch, fund) are OFF
 * unless you start the server with VESK_MCP_ALLOW_TRADES=1, need `confirm: true` on every call, and
 * still pass every guardrail and limit. The keystore passphrase comes from VESK_PASSPHRASE.
 */
import { createInterface } from "node:readline";
import {
  activeHandles, treasuryReport, Agent, AGENT_VERSION, describeRule, detectMints, fmtK, Keystore, loadConfig, parseWithModel, positionPnl, Rpc, RuleStore, snapshot, State,
  validateRule, defaultPlan, parseIntent, validateLaunchRule, describeLaunchRule, type LaunchOnPostRule, finalDescription, LAUNCHPADS, summarizePlan, validatePlan, validateLaunch, type LaunchPlan, type Rule, type VeskConfig,
  type WatchEntry,
  normalizeCopyConfig, upsertCopyWallet, effectiveProfile, describeProfile, copyStats, feedLine, latencyOf, mergeOverrides, type CopyOverrides,
  rowsFromLaunches, claimGroups,
  applyTemplate, defaultLaunchRule, LAUNCH_TEMPLATES, normalizeLaunchRule, PUMPFUN_PAIRS, pairCounts, raceLabel, searchPairs, findPair, type LaunchTemplateId,
  mintLine, pairSelectable, pairStatus, parseNameReply, seenRecently, STATUS_LABEL,
} from "@vesk-agent/core";
import { readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { BRAND, BURN_CONFIRM_TEXT, parseSupplyAmount } from "@vesk-agent/core";

/** Builds a LaunchPlan from flat tool arguments. Team wallets are taken from the user's active imported wallets. */
function planFrom(a: Json, teamWallets: string[]): LaunchPlan {
  const d = defaultPlan();
  const mode = a.mode === "manual" ? "manual" : "standard";
  const n = Number(a.teamWallets ?? 0);
  return {
    ...d, mode, launchpad: "pumpfun",
    token: { ...d.token, name: String(a.name ?? ""), symbol: String(a.symbol ?? "").replace(/^\$/, "").toUpperCase(), description: String(a.description ?? ""), twitter: a.twitter as string | undefined, telegram: a.telegram as string | undefined, website: a.website as string | undefined,
      ...(a.quote ? { quote: (findPair(String(a.quote))?.id ?? String(a.quote)) as LaunchPlan["token"]["quote"] } : {}),
      ...(["holders", "cashback", "split"].includes(String(a.creatorFees)) ? { creatorFees: a.creatorFees as LaunchPlan["token"]["creatorFees"] } : {}),
      ...(a.creatorFeePct !== undefined ? { creatorFeePct: Number(a.creatorFeePct) } : {}),
      ...(Array.isArray(a.feeSplit) ? { feeSplit: a.feeSplit as Array<{ address: string; pct: number }> } : {}) },
    devBuySol: mode === "manual" ? 0 : Number(a.devBuySol ?? d.devBuySol),
    jitoTipSol: Number(a.jitoTipSol ?? d.jitoTipSol), priorityFeeSol: Number(a.priorityFeeSol ?? d.priorityFeeSol), slippagePct: Number(a.slippagePct ?? d.slippagePct),
    team: n > 0 ? { wallets: teamWallets.slice(0, n), solEach: Number(a.teamSolEach ?? 0.1), disclosed: true } : null,
  };
}

const LAUNCH_ARGS = {
  name: { type: "string" }, symbol: { type: "string", description: "Ticker, 2-10 letters/digits" }, description: { type: "string" },
  twitter: { type: "string" }, telegram: { type: "string" }, website: { type: "string" },
  mode: { type: "string", enum: ["standard", "manual"], description: "standard = create + dev buy in one transaction (team wallets: one Jito bundle); manual = deploy only" },
  devBuySol: { type: "number" }, jitoTipSol: { type: "number", description: "Optional, default 0: the dev buy is in the create transaction" }, priorityFeeSol: { type: "number", description: "Optional, default 0" }, slippagePct: { type: "number" },
  quote: { type: "string", description: "Quote pair: SOL, or a custom pair from vesk_pairs (USDC, NVDAx…). Custom pairs are checked on chain first and aren't yet verified on a live launch" },
  creatorFees: { type: "string", enum: ["creator", "holders", "cashback", "split"], description: "Where creator fees go. Only 'creator' is verified live; cashback and split are custom-pair settings" },
  creatorFeePct: { type: "number", description: "Custom pairs: 0.05-1 (percent), paid in the pair asset. Not on SOL" },
  feeSplit: { type: "array", items: { type: "object" }, description: "With creatorFees 'split': up to 10 { address, pct } summing to 100" },
  teamWallets: { type: "number", description: "0-4 of the user's active imported wallets buy in the bundle. ALWAYS disclosed publicly (coin description + treasury report)." },
  teamSolEach: { type: "number", description: "Same SOL amount for every team wallet" },
};

type Json = Record<string, unknown>;
interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  trades?: boolean;
  run(args: Json): Promise<unknown>;
}

const str = (d: string) => ({ type: "string", description: d });
const num = (d: string) => ({ type: "number", description: d });
const obj = (props: Json, required: string[] = []) => ({ type: "object", properties: props, required, additionalProperties: false });

export function buildTools(cfg: VeskConfig, getAgent: () => Promise<Agent>): Tool[] {
  const state = () => new State(cfg.dataDir).load();
  const store = () => new RuleStore(cfg.dataDir).load();
  const rpc = new Rpc(cfg.rpc.url, 10_000, cfg.rpc.wsUrl);
  return [
    {
      name: "vesk_status",
      description: "Agent status, today's spend against limits, open positions count and the last activity lines.",
      inputSchema: obj({}),
      async run() {
        const s = await state();
        return { status: s.data.status, spentTodaySol: s.spentToday(), dailyCapSol: cfg.limits.dailySpendCapSol, buysToday: s.buysToday(), openPositions: s.data.positions.length, recent: s.data.activity.slice(-10) };
      },
    },
    {
      name: "vesk_positions",
      description: "Open positions with live market cap and unrealised PnL.",
      inputSchema: obj({}),
      async run() {
        const s = await state();
        return Promise.all(s.data.positions.map(async (p) => {
          const m = await snapshot(rpc, p.mint).catch(() => null);
          const pnl = positionPnl(p, m?.priceSol ?? p.avgEntryPriceSol);
          return { mint: p.mint, symbol: p.symbol, costSol: p.costSol, valueSol: +pnl.valueSol.toFixed(4), pnlPct: +pnl.pnlPct.toFixed(1), mcapUsd: m ? fmtK(m.mcapUsd) : null };
        }));
      },
    },
    {
      name: "vesk_detect_ca",
      description: "Find Solana contract addresses (mints) in a post's text and links. Ignores truncated addresses, signatures, program IDs and look-alikes.",
      inputSchema: obj({ text: str("Post text"), urls: { type: "array", items: { type: "string" }, description: "Expanded links in the post" } }, ["text"]),
      async run(a) {
        return detectMints(String(a.text), (a.urls as string[]) ?? []);
      },
    },
    {
      name: "vesk_market",
      description: "Price, market cap and liquidity of a mint (pump.fun curve or DEX pools).",
      inputSchema: obj({ mint: str("Mint address") }, ["mint"]),
      async run(a) {
        return snapshot(rpc, String(a.mint));
      },
    },
    {
      name: "vesk_rule_draft",
      description: `Turn plain English into a ${BRAND.name} rule draft. No side effects. Show the summary to the user and ask before saving.`,
      inputSchema: obj({ text: str('e.g. "snipe anything @x posts under 50k mcap with 0.5 SOL, sell half at 3x"') }, ["text"]),
      async run(a) {
        return parseWithModel(String(a.text), null);
      },
    },
    {
      name: "vesk_rule_save",
      description: "Save a rule draft (from vesk_rule_draft) and turn it on. Only after the user explicitly confirmed the summary.",
      inputSchema: obj({ draft: { type: "object", description: "The draft object" }, confirm: { type: "boolean", description: "Must be true: the user confirmed" } }, ["draft", "confirm"]),
      async run(a) {
        if (a.confirm !== true) throw new Error("Ask the user to confirm the rule first, then call again with confirm: true.");
        const r = { ...(a.draft as Rule), enabled: true };
        const errors = validateRule(r, cfg.limits);
        if (errors.length) return { saved: false, errors };
        await (await store()).upsert(r, cfg.limits);
        return { saved: true, id: r.id, summary: describeRule(r) };
      },
    },
    {
      name: "vesk_rules_list",
      description: "List rules and watched X accounts.",
      inputSchema: obj({}),
      async run() {
        const s = await store();
        return { rules: s.data.rules.map((r) => ({ id: r.id, enabled: r.enabled, summary: describeRule(r) })), watchlist: s.data.watchlist };
      },
    },
    {
      name: "vesk_copy_list",
      description: "Copy trading: tracked wallets with their effective settings, today's copies, PnL from copies (closed copies), win rate and last activity.",
      inputSchema: obj({ group: str("Only this group") }),
      async run(a) {
        const [s, st] = await Promise.all([store(), state()]);
        const c = normalizeCopyConfig(s.data.copy);
        const stats = copyStats(st.data.copyFeed, st.data.positions, st.data.closed);
        return {
          enabled: c.enabled, sources: c.sources,
          wallets: c.wallets.filter((w) => !a.group || w.group === a.group).map((w) => ({ address: w.address, label: w.label, group: w.group, enabled: w.enabled, summary: describeProfile(effectiveProfile(c.defaults, w)), stats: stats[w.address] ?? null })),
          note: "Copies land after the copied wallet's transaction (same or next few slots). They can't front-run it.",
        };
      },
    },
    {
      name: "vesk_copy_add",
      description: "Track a wallet for copy trading. `overrides` follows CopyOverrides (mode alert|confirm|auto, amount {mode fixed|pct|multiple, value, minSol, maxSol}, sells off|mirror|all, filters {maxMcapUsd, minMcapUsd, minLiquiditySol, maxDevPct, firstBuyOnly…}, exit {takeProfit, stopLossPct…}, limits, preset, delayMs). Show the summary and get the user's confirmation first; auto mode spends SOL from their wallet.",
      inputSchema: obj({ address: str("Wallet address"), label: str("Label"), group: str("Group"), notes: str("Notes"), overrides: { type: "object" }, confirm: { type: "boolean" } }, ["address", "confirm"]),
      async run(a) {
        if (a.confirm !== true) throw new Error("Confirm with the user first (confirm: true).");
        const s = await store();
        const c = upsertCopyWallet(normalizeCopyConfig(s.data.copy), { address: String(a.address), label: a.label as string | undefined, group: a.group as string | undefined, notes: a.notes as string | undefined, overrides: a.overrides as CopyOverrides | undefined, template: a.overrides ? "custom" : undefined });
        s.data.copy = c;
        await s.save();
        const w = c.wallets.find((x) => x.address === a.address)!;
        return { tracking: w.address, label: w.label, summary: describeProfile(effectiveProfile(c.defaults, w)) };
      },
    },
    {
      name: "vesk_copy_update",
      description: "Change one tracked wallet (by address or label): enabled, label, group, or overrides (merged into its current ones). Confirm with the user first.",
      inputSchema: obj({ wallet: str("Address or label"), enabled: { type: "boolean" }, label: str("New label"), group: str("Group"), overrides: { type: "object" }, confirm: { type: "boolean" } }, ["wallet", "confirm"]),
      async run(a) {
        if (a.confirm !== true) throw new Error("Confirm with the user first (confirm: true).");
        const s = await store();
        const c0 = normalizeCopyConfig(s.data.copy);
        const ref = String(a.wallet).replace(/^@/, "").toLowerCase();
        const w = c0.wallets.find((x) => x.address === a.wallet || x.label.toLowerCase() === ref);
        if (!w) throw new Error(`No tracked wallet "${String(a.wallet)}".`);
        const c = upsertCopyWallet(c0, { ...w, ...(a.enabled !== undefined ? { enabled: a.enabled as boolean } : {}), ...(a.label ? { label: String(a.label) } : {}), ...(a.group ? { group: String(a.group) } : {}), ...(a.overrides ? { overrides: mergeOverrides(w.overrides, a.overrides as CopyOverrides), template: "custom" as const } : {}) });
        s.data.copy = c;
        await s.save();
        const nw = c.wallets.find((x) => x.address === w.address)!;
        return { updated: nw.address, enabled: nw.enabled, summary: describeProfile(effectiveProfile(c.defaults, nw)) };
      },
    },
    {
      name: "vesk_copy_feed",
      description: `Recent trades by tracked wallets and what ${BRAND.name} did: copied / skipped (with the reason, e.g. 'mcap $412k > max $250k') / pending / failed, with detected→landed latency in ms.`,
      inputSchema: obj({ limit: num("Default 30"), wallet: str("Address or label") }),
      async run(a) {
        const [s, st] = await Promise.all([store(), state()]);
        const c = normalizeCopyConfig(s.data.copy);
        const ref = String(a.wallet ?? "").replace(/^@/, "").toLowerCase();
        const who = a.wallet ? c.wallets.find((x) => x.address === a.wallet || x.label.toLowerCase() === ref)?.address : undefined;
        return st.data.copyFeed.filter((i) => !who || i.wallet === who).slice(-Number(a.limit ?? 30)).map((i) => ({ ...i, line: feedLine(i), latencyMs: latencyOf(i.latency) }));
      },
    },
    {
      name: "vesk_watch_add",
      description: "Watch an X account and buy when it posts a contract address, within the given limits.",
      inputSchema: obj({
        handle: str("X handle"), amountSol: num("SOL per buy"), maxMcapUsd: num("Skip above this market cap (USD)"),
        maxBuysPerDay: num("Max buys per day"), takeProfitX: num("Take profit multiple, e.g. 3"), takeProfitSellPct: num("% to sell at take profit"),
        stopLossPct: num("Stop loss %"), confirm: { type: "boolean" },
      }, ["handle", "amountSol", "confirm"]),
      async run(a) {
        if (a.confirm !== true) throw new Error("Confirm with the user first (confirm: true).");
        const w: WatchEntry = {
          handle: String(a.handle), enabled: true, mode: "ca-in-post", amountSol: Number(a.amountSol), maxMcapUsd: a.maxMcapUsd as number | undefined,
          slippageBps: 1500, maxBuysPerDay: Number(a.maxBuysPerDay ?? 3), stopLossPct: (a.stopLossPct as number | undefined) ?? 35,
          takeProfit: a.takeProfitX ? [{ atMultiple: Number(a.takeProfitX), sellPct: Number(a.takeProfitSellPct ?? 50) }] : [{ atMultiple: 2, sellPct: 50 }],
        };
        await (await store()).watch(w);
        return { watching: w.handle };
      },
    },
    {
      name: "vesk_kill_switch",
      description: "Turn the kill switch on (no new buys) or off.",
      inputSchema: obj({ on: { type: "boolean" } }, ["on"]),
      async run(a) {
        const s = await store();
        s.data.limits = { ...(s.data.limits ?? {}), killSwitch: a.on === true };
        await s.save();
        return { killSwitch: a.on === true };
      },
    },
    {
      name: "vesk_launchpads",
      description: `Launchpads and what ${BRAND.name} can do on each. Only status 'ready' can be used.`,
      inputSchema: obj({}),
      async run() {
        return LAUNCHPADS.map((l) => ({ id: l.id, name: l.name, status: l.status, note: l.note, quotes: l.quotes.supported, creatorFees: l.creatorFees?.supported ?? [] }));
      },
    },
    {
      name: "vesk_launch_plan",
      description: "Dry run of a launch: validates the plan and returns the summary, % of supply, cost estimate and the exact disclosure text for team wallets. No side effects. Show it to the user before vesk_launch.",
      inputSchema: obj(LAUNCH_ARGS, ["name", "symbol"]),
      async run(a) {
        const n = Number(a.teamWallets ?? 0);
        const placeholders = Array.from({ length: n }, (_, i) => `<team wallet ${i + 1}>`);
        const plan = planFrom(a, placeholders);
        const s = summarizePlan(plan);
        return { errors: validatePlan(plan).filter((e) => e.field !== "team" || !/listed once/.test(e.message)), mode: plan.mode, devPct: +s.devPct.toFixed(2), team: s.teamLine || null, estimatedTotalSol: +s.totalSol.toFixed(4), descriptionOnChain: finalDescription(plan) };
      },
    },
    {
      name: "vesk_wallets",
      description: "The user's wallets (main + imported): label, address, balance, active. Public data only.",
      inputSchema: obj({}),
      async run() {
        return (await getAgent()).wallets();
      },
    },
    {
      name: "vesk_launch",
      description: "Launch a coin on pump.fun from the user's wallet. Requires VESK_MCP_ALLOW_TRADES=1, confirm: true and a local image path. Team wallets are always disclosed. Guardrails and limits apply.",
      trades: true,
      inputSchema: obj({ ...LAUNCH_ARGS, imagePath: { type: "string", description: "Local PNG/JPG/GIF/WebP" }, confirm: { type: "boolean" } }, ["name", "symbol", "imagePath", "confirm"]),
      async run(a) {
        if (a.confirm !== true) throw new Error("Show the vesk_launch_plan summary to the user and confirm first (confirm: true).");
        const ag = await getAgent();
        const team = (await ag.wallets()).filter((w) => !w.main && w.active).map((w) => w.address);
        const path = String(a.imagePath);
        const ext = extname(path).slice(1).toLowerCase();
        const image = { bytes: new Uint8Array(await readFile(path)), mime: `image/${ext === "jpg" ? "jpeg" : ext}`, filename: basename(path) };
        const bad = validateLaunch({ name: "xx", symbol: "XX", image, devBuySol: 0 }).filter((e) => /image/i.test(e));
        if (bad.length) throw new Error(bad.join(" "));
        const steps: string[] = [];
        const r = await ag.launch(planFrom(a, team), image, (e) => steps.push(`${e.step}: ${e.detail}`));
        return { ...r, steps, coinPage: `https://pump.fun/coin/${r.mint}` };
      },
    },
    {
      name: "vesk_launch_rule_draft",
      description: "Turn plain English into a launch-on-post rule draft (e.g. \"launch a coin whenever @x posts a picture with 500 likes in 60s, on a USDC pair, 0.3 SOL dev buy, sell half at 100k\"). No side effects. Show the summary and ask before saving.",
      inputSchema: obj({ text: str("Plain English") }, ["text"]),
      async run(a) {
        const r = parseIntent(String(a.text));
        if (r.kind !== "launch-rule") return { understood: false, result: r };
        return { understood: true, draft: r.draft, summary: r.summary, errors: r.errors, note: "Images from posts may be owned by someone else. The user is responsible for what they launch." };
      },
    },
    {
      name: "vesk_launch_rule_save",
      description: "Save a launch-on-post rule draft and turn it on. Only after the user confirmed the summary, including Auto vs Confirm mode.",
      inputSchema: obj({ draft: { type: "object" }, confirm: { type: "boolean" } }, ["draft", "confirm"]),
      async run(a) {
        if (a.confirm !== true) throw new Error("Ask the user to confirm the rule first, then call again with confirm: true.");
        const r = { ...(a.draft as LaunchOnPostRule), enabled: true };
        const errors = validateLaunchRule(r);
        if (errors.length) return { saved: false, errors };
        await (await store()).upsertLaunchRule(r);
        return { saved: true, id: r.id, summary: describeLaunchRule(r) };
      },
    },
    {
      name: "vesk_launch_rule_templates",
      description: "Launch-on-post templates (Founder announcements, Breaking news, Image memes, Product launches, Custom). vesk_launch_rule_from_template turns one into a draft for given accounts.",
      inputSchema: obj({}),
      async run() { return LAUNCH_TEMPLATES.map(({ id, name, blurb, sets }) => ({ id, name, blurb, sets })); },
    },
    {
      name: "vesk_launch_rule_from_template",
      description: "A launch-on-post rule draft from a template for some accounts (Confirm mode, off). Accounts are in priority order (first = highest). No side effects: show the summary, then vesk_launch_rule_save.",
      inputSchema: obj({
        template: { type: "string", enum: LAUNCH_TEMPLATES.map((t) => t.id) }, handles: { type: "array", items: { type: "string" }, description: "X handles, highest priority first" },
        pair: str("Optional quote pair, e.g. USDC or NVDAx (see vesk_pairs)"),
        patterns: { type: "array", items: { type: "string" }, description: "Optional regular expressions a post must match (or a keyword); max 120 characters, no nested repeats" },
        excludePatterns: { type: "array", items: { type: "string" }, description: "Optional regular expressions that rule a post out" },
        priorityHoldSec: num("Optional: seconds a lower account waits for a same-topic post from one higher up (0 = instant)"),
        naming: { type: "string", enum: ["model", "template", "ask"], description: "ask = the Confirm card asks you for the name and ticker" },
        style: { type: "string", enum: ["short", "literal", "punny"] },
        clashImage: { type: "boolean", description: "Also skip / rename when a coin with the same image launched (default true)" },
      }, ["template", "handles"]),
      async run(a) {
        const handles = (a.handles as string[]).map((h) => h.replace(/^@/, "").toLowerCase());
        let r = applyTemplate(defaultLaunchRule({ name: `${LAUNCH_TEMPLATES.find((t) => t.id === a.template)?.name ?? "Launch"}: ${handles.map((h) => "@" + h).join(", ")}`, trigger: { handles, requireImage: true } }), String(a.template) as LaunchTemplateId);
        const p = a.pair ? findPair(String(a.pair)) : undefined;
        if (a.pair && !p) return { ok: false, error: `${a.pair} isn't in the pair list.` };
        if (p) r = { ...r, pair: { quote: p.id, fees: "creator", ...(p.id !== "SOL" ? { creatorFeePct: 0.05 } : {}) } };
        if (a.patterns || a.excludePatterns) r = { ...r, trigger: { ...r.trigger, patterns: { include: (a.patterns as string[] | undefined) ?? [], exclude: (a.excludePatterns as string[] | undefined) ?? [] } } };
        if (a.priorityHoldSec !== undefined) r = { ...r, trigger: { ...r.trigger, priorityHoldSec: Number(a.priorityHoldSec) } };
        if (a.naming) r = { ...r, coin: { ...r.coin, naming: a.naming as LaunchOnPostRule["coin"]["naming"] }, ...(a.naming === "ask" ? { mode: "confirm" as const } : {}) };
        if (a.style) r = { ...r, coin: { ...r.coin, style: a.style as LaunchOnPostRule["coin"]["style"] } };
        if (a.clashImage === false) r = { ...r, clash: { ...(r.clash ?? { action: "skip", windowSec: 120 }), image: false } };
        r = normalizeLaunchRule(r);
        return { draft: r, summary: describeLaunchRule(r), errors: validateLaunchRule(r) };
      },
    },
    {
      name: "vesk_launch_rule_backtest",
      description: "Paper replay: the last 7 days of posts from a launch-on-post rule's accounts through its real matcher, priority order, limits and coin draft (from the user's X API history; without one, the posts the tracker stored, and it says so). Shows what it would have launched. Nothing is drafted with a model and nothing is spent.",
      inputSchema: obj({ id: str("The rule id (vesk_rules_list)"), days: num("1-7, default 7") }, ["id"]),
      async run(a) {
        const res = await (await getAgent()).backtestLaunchRule(String(a.id), Number(a.days ?? 7));
        return { launches: res.launches, posts: res.posts, spendSol: res.spendSol, wouldLaunch: res.rows.filter((r) => r.outcome === "launch").slice(-30), skippedMostOften: res.reasons.slice(0, 6), notes: res.notes, source: res.source };
      },
    },
    {
      name: "vesk_launch_rule_stats",
      description: "Per launch-on-post rule: launches, first-place rate (race reports), median post → landed ms, PnL on the dev position, creator fees earned per asset.",
      inputSchema: obj({ id: str("Optional rule id") }),
      async run(a) { return (await getAgent()).launchRuleStats(a.id ? String(a.id) : undefined); },
    },
    {
      name: "vesk_race_reports",
      description: "Race reports for coins launched on posts: the other coins created for the same post or topic (same post link, ticker, name or image) within the window, ranked by create time, e.g. \"1st of 14 · 1.7 s after the post\". Based on what the agent's create stream saw (`complete: false` when it wasn't connected the whole window).",
      inputSchema: obj({ mint: str("Optional: one coin's mint") }),
      async run(a) { return (await getAgent()).raceReports(a.mint ? String(a.mint) : undefined).map((x) => ({ ...x, label: x.race ? raceLabel(x.race) : undefined })); },
    },
    {
      name: "vesk_pairs",
      description: "pump.fun custom pairs (quote assets) by category (Solana, Stablecoins, Crypto, Stocks, Pre-IPO, Metals, Discovered) with each one's status: Verified on-chain (its mint passed the check through the user's RPC), Listed (a mint from a third-party list), Discovered (seen in a live pump.fun create), Not available yet (no mint known: never guessed, not usable). Creator fee 0.05-1%, paid in the pair asset; verify on first live launch. Pass `check` to read one pair's mint on chain now (exists, Token or Token-2022, a mint, decimals).",
      inputSchema: obj({ search: str("Optional: symbol, name, issuer or category"), category: { type: "string", enum: ["native", "stable", "crypto", "stock", "preipo", "metal", "other"] }, check: str("Optional: a pair symbol or mint to check on chain now") }),
      async run(a) {
        if (a.check) {
          const r = await (await getAgent()).checkPair(String(a.check));
          if ("error" in r) return { ok: false, error: r.error };
          return { symbol: r.pair.id, mint: r.pair.mint, ...r.check, line: mintLine(r.pair.id, r.check) };
        }
        const ag = await getAgent().catch(() => null);
        const list = ag?.pairs() ?? PUMPFUN_PAIRS;
        const checks = ag?.pairChecks() ?? {};
        const groups = searchPairs(String(a.search ?? ""), list).filter((g) => !a.category || g.category === a.category);
        return { counts: pairCounts(list), reportedTotal: 93, discovered: seenRecently(list).map((p) => ({ symbol: p.id, mint: p.mint, creates: p.seenCount ?? 1 })), groups: groups.map((g) => ({ category: g.label, pairs: g.items.map((p) => ({ symbol: p.id, name: p.name, status: STATUS_LABEL[pairStatus(p, checks[p.mint ?? ""])], usable: pairSelectable(p), mint: p.mint, issuer: p.issuer, source: p.source, verifyOnFirstLaunch: !!p.verify })) })) };
      },
    },
    {
      name: "vesk_pending_launches",
      description: "Launch-on-post drafts waiting for Launch or Skip (Confirm mode).",
      inputSchema: obj({}),
      async run() {
        return (await state()).data.pendingLaunches.filter((p) => p.expiresAt > Date.now());
      },
    },
    {
      name: "vesk_treasury",
      description: "Treasury report for coins this agent launched: disclosed team buys, dev sells, fee claims, buybacks and burns, each with its transaction.",
      inputSchema: obj({ mint: str("Optional: one coin's mint") }),
      async run(a) {
        const s = await state();
        const symbols = Object.fromEntries([...s.data.positions, ...s.data.closed].map((p) => [p.mint, p.symbol]));
        return treasuryReport(s.data.treasury, symbols, a.mint ? String(a.mint) : undefined);
      },
    },
    {
      name: "vesk_creator_fees",
      description: "Coins this agent launched with their quote pair (SOL or a custom pair), where creator rewards go (creator or holders), what was claimed so far, and the claims `vesk_claim_fees` would send (one per asset and wallet). Unclaimed amounts aren't reported by the venue.",
      inputSchema: obj({}),
      async run() {
        const s = await state();
        const rows = rowsFromLaunches(s.data.launched ?? [], s.data.treasury.filter((e) => e.kind === "claim"));
        return { rows, claims: claimGroups(rows).map((g) => ({ asset: g.asset, coins: g.symbols, creator: g.creator })) };
      },
    },
    {
      name: "vesk_claim_fees",
      description: "Claim creator fees for coins this agent launched (\"claim my fees\"): one claim per asset and wallet. SOL-pair fees arrive as SOL; custom-pair fees arrive in the quote asset and stay in it (not yet verified on a live claim). Coins with rewards to holders are skipped. Requires VESK_MCP_ALLOW_TRADES=1 and confirm: true.",
      trades: true,
      inputSchema: obj({ mint: str("Optional: one coin's mint"), symbol: str("Optional: one coin's ticker"), confirm: { type: "boolean" } }, ["confirm"]),
      async run(a) {
        if (a.confirm !== true) throw new Error("Confirm with the user first (confirm: true).");
        const ag = await getAgent();
        const res = await ag.claimFees({ mint: a.mint ? String(a.mint) : undefined, symbol: a.symbol ? String(a.symbol) : undefined });
        return res.map((r) => ({ asset: r.asset, coins: r.group.symbols, ok: r.ok, amount: r.amount, sol: r.sol, signature: r.signature, error: r.error }));
      },
    },
    {
      name: "vesk_burn_plan",
      description: "Plan a burn of a coin this agent launched: what the wallet holds, what an amount or percentage burns and what's left. Nothing is signed. Show it to the user before vesk_burn_supply.",
      inputSchema: obj({ mint: str("The coin's mint"), symbol: str("Or its ticker"), amount: str("Tokens (1000000, 1.5M) or a percentage of the holding (25%), or all") }, ["amount"]),
      async run(a) {
        const sel = parseSupplyAmount(String(a.amount));
        if (!sel) throw new Error("amount: tokens (1000000, 1.5M), a percentage (25%) or all");
        const ag = await getAgent();
        const r = await ag.burnSupply({ mint: a.mint ? String(a.mint) : undefined, symbol: a.symbol ? String(a.symbol) : undefined, ...sel, confirm: false, planOnly: true });
        if (!r.ok || !r.plan) throw new Error(r.error ?? "can't plan this burn");
        return { coin: r.coin, burn: r.plan.tokens, pctOfHolding: r.plan.pctOfHolding, left: r.plan.remaining, warning: BURN_CONFIRM_TEXT };
      },
    },
    {
      name: "vesk_burn_supply",
      description: `Burn supply of a coin this agent launched (one SPL BurnChecked from the agent's wallet, through the guardrails). ${BURN_CONFIRM_TEXT}: get vesk_burn_plan first and confirm the exact amount with the user. Disclosed in the treasury report and, when the agent runs the coin, its next update. Requires VESK_MCP_ALLOW_TRADES=1 and confirm: true.`,
      trades: true,
      inputSchema: obj({ mint: str("The coin's mint"), symbol: str("Or its ticker"), amount: str("Tokens (1000000, 1.5M), a percentage (25%) or all"), confirm: { type: "boolean" } }, ["amount", "confirm"]),
      async run(a) {
        if (a.confirm !== true) throw new Error(`Confirm with the user first (confirm: true). ${BURN_CONFIRM_TEXT}.`);
        const sel = parseSupplyAmount(String(a.amount));
        if (!sel) throw new Error("amount: tokens (1000000, 1.5M), a percentage (25%) or all");
        const ag = await getAgent();
        const r = await ag.burnSupply({ mint: a.mint ? String(a.mint) : undefined, symbol: a.symbol ? String(a.symbol) : undefined, ...sel, confirm: true });
        if (!r.ok) throw new Error(r.error ?? "burn failed");
        return { coin: r.coin, burned: r.plan?.tokens, signature: r.signature, disclosure: r.disclosure };
      },
    },
    {
      name: "vesk_lock_supply",
      description: "Lock supply of a coin this agent launched. Not available yet (Soon): returns the plan (amount and unlock date) and why. Nothing is sent.",
      inputSchema: obj({ mint: str("The coin's mint"), symbol: str("Or its ticker"), amount: str("Tokens or a percentage (25%)"), days: num("Lock length in days") }, ["amount", "days"]),
      async run(a) {
        const sel = parseSupplyAmount(String(a.amount));
        if (!sel) throw new Error("amount: tokens (1000000, 1.5M) or a percentage (25%)");
        const ag = await getAgent();
        const r = await ag.lockSupply({ mint: a.mint ? String(a.mint) : undefined, symbol: a.symbol ? String(a.symbol) : undefined, ...sel, days: Number(a.days) });
        return { available: false, soon: true, reason: r.error, plan: r.plan?.ok ? { tokens: r.plan.tokens, days: r.plan.days, unlockAt: new Date(r.plan.unlockAt).toISOString() } : null };
      },
    },
    {
      name: "vesk_launch_rule_accounts",
      description: "Accounts in a launch-on-post rule and whether each is on. Use the CLI (`vesk rules account <id> @handle on|off`) or the panel to switch one.",
      inputSchema: obj({ id: str("Launch rule id") }, ["id"]),
      async run(a) {
        const s = await store();
        const r = (s.data.launchRules ?? []).find((x) => x.id === a.id);
        if (!r) throw new Error(`No launch rule ${String(a.id)}`);
        const on = new Set(activeHandles(r));
        return r.trigger.handles.map((h) => ({ handle: h, on: on.has(h) }));
      },
    },
    {
      name: "vesk_pending_decide",
      description: "Launch or skip a pending launch-on-post draft. A draft that asks for a name (naming \"ask\") needs `name` (\"Night Ferry $FERRY\"). The running agent picks the decision up within 2 seconds. Needs VESK_MCP_ALLOW_TRADES=1 and confirm: true.",
      trades: true,
      inputSchema: obj({ id: str("Draft id"), launch: { type: "boolean" }, name: str("Optional: \"Name $TICKER\" for the coin"), confirm: { type: "boolean" } }, ["id", "launch", "confirm"]),
      async run(a) {
        if (a.confirm !== true) throw new Error("Confirm with the user first (confirm: true).");
        const named = a.name ? parseNameReply(String(a.name)) : null;
        if (a.name && !named) throw new Error("Name it like \"Night Ferry $FERRY\".");
        const f = join(cfg.dataDir, "control.json");
        const cur = JSON.parse(await readFile(f, "utf8").catch(() => "{}")) as { decisions?: Array<{ id: string; launch: boolean; name?: { name: string; symbol: string } }> };
        await writeFile(f, JSON.stringify({ ...cur, decisions: [...(cur.decisions ?? []), { id: String(a.id), launch: a.launch === true, ...(named ? { name: named } : {}) }], at: Date.now() }));
        return { sent: true, note: "The running agent applies it; limits and guardrails are checked again before signing." };
      },
    },
    {
      name: "vesk_buy",
      description: "Buy a coin with SOL from the user's own agent wallet. Requires VESK_MCP_ALLOW_TRADES=1 and confirm: true. Guardrails and limits always apply.",
      trades: true,
      inputSchema: obj({ mint: str("Mint address"), amountSol: num("SOL to spend"), slippagePct: num("Slippage %, default 15"), confirm: { type: "boolean" } }, ["mint", "amountSol", "confirm"]),
      async run(a) {
        if (a.confirm !== true) throw new Error("Confirm with the user first (confirm: true).");
        const ag = await getAgent();
        return ag.executor.buy({ action: "buy", wallet: ag.address, mint: String(a.mint), amountSol: Number(a.amountSol), slippageBps: Math.round(Number(a.slippagePct ?? 15) * 100), venue: "auto", reason: "mcp buy" });
      },
    },
    {
      name: "vesk_sell",
      description: "Sell a percentage of a position. Requires VESK_MCP_ALLOW_TRADES=1 and confirm: true.",
      trades: true,
      inputSchema: obj({ mint: str("Mint address"), percent: num("1-100"), confirm: { type: "boolean" } }, ["mint", "percent", "confirm"]),
      async run(a) {
        if (a.confirm !== true) throw new Error("Confirm with the user first (confirm: true).");
        const ag = await getAgent();
        return ag.executor.sell({ action: "sell", wallet: ag.address, mint: String(a.mint), sellPct: Number(a.percent), reason: "mcp sell" });
      },
    },
  ];
}

export async function runStdio(configPath?: string) {
  const { config } = await loadConfig(configPath);
  const allowTrades = process.env.VESK_MCP_ALLOW_TRADES === "1";
  let agent: Agent | undefined;
  const getAgent = async () => {
    if (agent) return agent;
    const pass = process.env.VESK_PASSPHRASE;
    if (!pass) throw new Error("Set VESK_PASSPHRASE in the MCP server's environment to use trading tools.");
    agent = await new Agent({ config, keystore: await Keystore.open(config.wallet.keystore, pass) }).init();
    return agent;
  };
  const tools = buildTools(config, getAgent).filter((t) => allowTrades || !t.trades);
  const send = (m: Json) => process.stdout.write(JSON.stringify(m) + "\n");
  const rl = createInterface({ input: process.stdin });
  process.stderr.write(`vesk mcp ${AGENT_VERSION} ready (${tools.length} tools${allowTrades ? ", trading enabled" : ", read-only + rules"})\n`);

  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: { id?: number | string; method?: string; params?: Json };
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    const { id, method, params } = msg;
    if (id === undefined) continue; // notifications (notifications/initialized, cancelled…)
    try {
      if (method === "initialize") {
        send({ jsonrpc: "2.0", id, result: { protocolVersion: (params?.protocolVersion as string) ?? "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "vesk", version: AGENT_VERSION }, instructions: `${BRAND.name} trades memecoins on Solana from the user's own wallet. Always show rule summaries and ask the user before saving rules or trading. Never promise profit.` } });
      } else if (method === "ping") {
        send({ jsonrpc: "2.0", id, result: {} });
      } else if (method === "tools/list") {
        send({ jsonrpc: "2.0", id, result: { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
      } else if (method === "tools/call") {
        const t = tools.find((x) => x.name === params?.name);
        if (!t) throw Object.assign(new Error(`Unknown tool ${String(params?.name)}`), { code: -32602 });
        try {
          const out = await t.run((params?.arguments as Json) ?? {});
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] } });
        } catch (e) {
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: (e as Error).message }], isError: true } });
        }
      } else {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    } catch (e) {
      send({ jsonrpc: "2.0", id, error: { code: (e as { code?: number }).code ?? -32603, message: (e as Error).message } });
    }
  }
}
