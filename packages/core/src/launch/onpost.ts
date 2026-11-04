/**
 * "Launch on post" rules. Pure logic, no I/O: trigger matching, the coin draft built from a post, the honesty
 * rules every auto-launched coin must pass, rate limits and dedupe, the plan handed to the launcher, and the
 * plain-English parser for chat. Shared by the agent, the hosted backend, the panel, the CLI and MCP.
 *
 * Honesty (enforced here, not settings):
 *  - The description always ends with "Inspired by a post from @handle. Not affiliated with or endorsed by them."
 *  - Names, tickers and descriptions can't claim to be the person's official / verified / endorsed coin.
 *  - The X link field is never set to the person's account or post. The post goes in the website (source) field.
 *  - Never two coins for the same post. Limits, cooldowns and the kill switch always apply.
 */
import { forbiddenIntent, type GuardResult } from "../guardrails.js";
import type { FieldError } from "../rules/validate.js";
import { validateExit } from "../rules/validate.js";
import type { ExitSpec, XPost } from "../types.js";
import { defaultPlan, DESCRIPTION_MAX, disclosureText, MAX_TEAM_WALLETS, type LaunchMode, type LaunchPlan, type TokenDetails } from "./plan.js";
import type { CreatorFeeMode, QuoteAsset } from "./launchpads.js";
import { findPair, pairSelectable } from "./pairs.js";
import { CUSTOM_PAIR_FEE } from "./pairs.js";
import type { RaceReport } from "./race.js";
import type { ClashAction } from "./clash.js";

/**
 * v26: how the name and ticker are picked. "model": your model, in a style. "template": the name / ticker templates.
 * "ask": Confirm mode only: the draft card asks you for the name and ticker (with the model's or the template's
 * suggestions to tap). "post" (older rules): the post's cashtag ($WORD), else the templates.
 */
export type NamingMethod = "model" | "template" | "ask" | "post";
/** v26: the style your model names coins in. */
export type NamingStyle = "short" | "literal" | "punny";
export const NAMING_STYLES: Record<NamingStyle, string> = {
  short: "Short: one or two strong words from the post, easy to type.",
  literal: "Literal: name the thing the post announces, plainly.",
  punny: "Punny: a light play on words about the post, still clearly about it.",
};
/** Older rules said punchy / playful / meme / deadpan; they read as short, punny and literal. */
export function normStyle(s?: string): NamingStyle {
  return s === "literal" || s === "deadpan" ? "literal" : s === "punny" || s === "meme" || s === "playful" ? "punny" : "short";
}
export type MediaFilter = "any" | "image" | "video" | "image-or-video";
export type Presence = "any" | "require" | "forbid";
export type LaunchTemplateId = "founder" | "breaking" | "memes" | "product" | "cashtag" | "custom";

export type ImageSource = "post" | "generate" | "mine";

export interface LaunchOnPostRule {
  id: string;
  kind: "launch-on-post";
  name: string;
  enabled: boolean;
  trigger: {
    /** One account watched 24/7, or many. */
    handles: string[];
    /** Accounts in `handles` that are switched off for now (kept in the list, ignored by matching). */
    off?: string[];
    /** Any of these words must appear in the post (case-insensitive). Empty = any post. */
    keywords?: string[];
    requireImage: boolean;
    /** Only when the X source returns counts; otherwise these filters are skipped and the log says so. */
    minLikes?: number;
    minViews?: number;
    // ---- v26 ----
    /** Tracker groups whose accounts this rule also watches (resolved to handles by the caller). */
    groups?: string[];
    /** Where posts come from: whatever the Tracker uses, Vesk Relay, or your own X API key. */
    source?: "tracker" | "relay" | "x-api";
    /** Each on by default: replies, quotes and reposts are ignored. */
    ignore?: { replies: boolean; quotes: boolean; reposts: boolean };
    /** Words or phrases that rule a post out. */
    exclude?: string[];
    /** Media the post must have. Replaces requireImage (kept in sync for older readers). */
    media?: MediaFilter;
    cashtag?: Presence;
    contract?: Presence;
    /** Languages to accept (e.g. ["en"]); applies when the X source returns the post's language. */
    languages?: string[];
    /** Engagement velocity: at least `likes` within `withinSec` of the post; Vesk waits up to `waitSec`, then decides. */
    velocity?: { likes: number; withinSec: number; waitSec: number };
    /** Time-of-day windows ("09:00"-"17:30"), in `tzOffsetMin` from UTC (0 = UTC). Empty = any time. */
    hours?: Array<{ from: string; to: string }>;
    tzOffsetMin?: number;
    /** One launch per topic across every account: same post link, or similar text within `windowMin`. */
    dedupe?: { topic: boolean; windowMin: number; similarity: number };
    /** v26 Advanced: regular expressions (case-insensitive). A post matches when a keyword OR an include pattern matches; any exclude pattern rules it out. */
    patterns?: { include?: string[]; exclude?: string[] };
    /**
     * v26: priority. `handles` is in priority order (first = highest). When several accounts post about the same topic,
     * a post from an account that isn't first waits this many seconds (0 = instant, the default) so a post from an
     * account higher in the list can win; the topic check then keeps only one.
     */
    priorityHoldSec?: number;
  };
  coin: {
    /** "model" asks your model for a name and ticker (falls back to the template). */
    naming: NamingMethod;
    nameTemplate: string;
    tickerTemplate: string;
    descriptionTemplate: string;
    image: ImageSource;
    /** "mine": a local path (agent) or an uploaded image (hosted). Also the fallback for "post" / "generate". */
    defaultImage?: string;
    /** Your own preset links. Empty website = the post URL is used as the source link. */
    links: { website?: string; twitter?: string; telegram?: string };
    // ---- v26 ----
    /** naming "model": the voice. */
    style?: NamingStyle;
    /** image "post": crop to a centred square (default on). */
    crop?: boolean;
    /** image "post": the post photo's short side must be at least this many px (default 256), else your image is used or the post is skipped. */
    minImagePx?: number;
    /** "post" puts the post link in the website field even when you have a preset website. */
    websiteFrom?: "preset" | "post";
  };
  /** v26: the quote pair and creator-fee settings (custom pairs from launch/pairs.ts; TODO-verify beyond SOL). */
  pair?: { quote: QuoteAsset; creatorFeePct?: number; fees: CreatorFeeMode; split?: Array<{ address: string; pct: number }> };
  /** v26: before launching, scan recent pump.fun creates for the same ticker / name / post link. */
  clash?: { action: ClashAction; windowSec: number; /** also match the post's image (byte hash), default on */ image?: boolean };
  /** v26: how far around the post (minutes) other coins count for the race report. */
  race?: { windowMin: number };
  /** v26: the template the rule started from. */
  template?: LaunchTemplateId;
  plan: { mode: LaunchMode; devBuySol: number; jitoTipSol: number; priorityFeeSol: number; slippagePct: number; teamWallets: number; teamSolEach: number; /** v26: the dev buy in the pair asset (custom pairs; TODO-verify). */ devBuyIn?: "SOL" | "quote" };
  exit: ExitSpec;
  /** auto: launch without asking. confirm: send a draft to Telegram / the panel, launch only on "Launch". */
  mode: "auto" | "confirm";
  confirmTtlSec: number;
  limits: { maxPerHour: number; maxPerDay: number; maxSolPerLaunch: number; maxSolPerDay: number; cooldownMin: number; /** v26 */ maxOpenCoins?: number };
  /** Use a named launch preset for plan, coin and exits (overrides the inline settings). */
  presetId?: string;
  updatedAt?: string;
}

export interface LaunchRecord {
  at: number;
  ruleId: string;
  handle: string;
  postId: string;
  status: "launched" | "paper" | "pending" | "skipped" | "expired" | "failed";
  sol: number;
  mint?: string;
  symbol?: string;
  reason?: string;
  /** Post received → landed, per step (ms since the post arrived). */
  timings?: Array<{ mark: string; ms: number }>;
  // ---- v26 ----
  name?: string;
  postUrl?: string;
  /** the post's own time (ms), for "1.7 s after the post" */
  postAt?: number;
  /** the post's text, for topic dedupe */
  postText?: string;
  quote?: string;
  /** when it landed (ms) */
  landedAt?: number;
  /** the clash check's outcome, when it changed something */
  clash?: { kind: "ticker" | "name" | "post" | "image"; action: ClashAction; renamedFrom?: string };
  race?: RaceReport;
}

export interface PendingLaunch {
  id: string;
  ruleId: string;
  handle: string;
  postId: string;
  postUrl: string;
  postText: string;
  imageUrl?: string;
  token: TokenDetails;
  devBuySol: number;
  teamWallets: number;
  exitSummary: string[];
  createdAt: number;
  expiresAt: number;
  /** v26: the pair and the clash check's note, for the Telegram card and the panel */
  quote?: string;
  clashNote?: string;
  postAt?: number;
  /** v26 naming "ask": the card asks for the name and ticker; these are the suggestions to tap */
  ask?: boolean;
  suggestions?: Array<{ name: string; symbol: string }>;
  /** why it matched (the rule and what matched), for the card and Live */
  reason?: string;
}

export const AUTO_LIMITS = { maxPerHour: 2, maxPerDay: 5, maxSolPerLaunch: 1, maxSolPerDay: 3, cooldownMin: 60 } as const;

export const DEFAULT_IGNORE = { replies: true, quotes: true, reposts: true } as const;
export const DEFAULT_CLASH = { action: "skip" as ClashAction, windowSec: 120 };
export const DEFAULT_RACE = { windowMin: 10 };
export const DEFAULT_DEDUPE = { topic: true, windowMin: 30, similarity: 0.6 };

export function defaultLaunchRule(p: Partial<LaunchOnPostRule> = {}): LaunchOnPostRule {
  return normalizeLaunchRule({
    id: p.id ?? `lp_${Math.random().toString(36).slice(2, 8)}`,
    kind: "launch-on-post",
    name: p.name ?? "Launch on post",
    enabled: p.enabled ?? false,
    trigger: { handles: [], requireImage: true, ...p.trigger },
    coin: {
      naming: "model", style: "short", nameTemplate: "{Word}", tickerTemplate: "{WORD}", descriptionTemplate: "{text}", image: "post",
      ...p.coin, links: { ...p.coin?.links },
    },
    plan: { mode: "standard", devBuySol: 0.3, jitoTipSol: 0, priorityFeeSol: 0, slippagePct: 10, teamWallets: 0, teamSolEach: 0.1, ...p.plan },
    exit: p.exit ?? { mcapTargets: [{ atMcapUsd: 100_000, sellPct: 50 }, { atMcapUsd: 250_000, sellPct: 100 }], stopBelowMcapUsd: 5_000, timeoutMin: 720 },
    mode: p.mode ?? "confirm",
    confirmTtlSec: p.confirmTtlSec ?? 120,
    limits: { ...AUTO_LIMITS, ...p.limits },
    ...(p.pair ? { pair: p.pair } : {}),
    ...(p.clash ? { clash: p.clash } : {}),
    ...(p.race ? { race: p.race } : {}),
    ...(p.template ? { template: p.template } : {}),
    ...(p.presetId ? { presetId: p.presetId } : {}),
  });
}

/**
 * v26: fill in the newer settings for a rule saved by an older version, and keep `requireImage` and `media` in step.
 * Pure; returns a copy. Older readers still see `requireImage`.
 */
export function normalizeLaunchRule(r: LaunchOnPostRule): LaunchOnPostRule {
  const t = r.trigger;
  const media: MediaFilter = t.media ?? (t.requireImage ? "image" : "any");
  return {
    ...r,
    trigger: {
      ...t,
      media,
      requireImage: media === "image",
      ignore: { ...DEFAULT_IGNORE, ...t.ignore },
      cashtag: t.cashtag ?? "any",
      contract: t.contract ?? "any",
      dedupe: { ...DEFAULT_DEDUPE, ...t.dedupe },
      source: t.source ?? "tracker",
    },
    coin: { ...r.coin, style: normStyle(r.coin.style), crop: r.coin.crop ?? true, minImagePx: r.coin.minImagePx ?? 256, websiteFrom: r.coin.websiteFrom ?? (r.coin.links.website ? "preset" : "post"), links: { ...r.coin.links } },
    pair: r.pair ?? { quote: "SOL", fees: "creator" },
    clash: { ...DEFAULT_CLASH, ...r.clash },
    race: { ...DEFAULT_RACE, ...r.race },
    plan: { ...r.plan, devBuyIn: r.plan.devBuyIn ?? "SOL" },
  };
}

// ---------- helpers ----------

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
/** Accounts in the rule that are switched on. */
export function activeHandles(r: Pick<LaunchOnPostRule, "trigger">): string[] {
  const off = new Set((r.trigger.off ?? []).map((h) => h.toLowerCase()));
  return r.trigger.handles.filter((h) => !off.has(h.toLowerCase()));
}

/** Switch one account on or off without removing it from the rule. */
export function setHandleOn<R extends Pick<LaunchOnPostRule, "trigger">>(r: R, handle: string, on: boolean): R {
  const h = handle.toLowerCase();
  const off = new Set((r.trigger.off ?? []).map((x) => x.toLowerCase()));
  if (on) off.delete(h); else off.add(h);
  const list = r.trigger.handles.filter((x) => off.has(x.toLowerCase())).map((x) => x.toLowerCase());
  return { ...r, trigger: { ...r.trigger, off: list } };
}

export const postUrl = (p: Pick<XPost, "handle" | "id">) => `https://x.com/${p.handle}/status/${p.id}`;
export const disclaimer = (handle: string) => `Inspired by a post from @${handle}. Not affiliated with or endorsed by them.`;
export function parseUsd(s: string): number | null {
  const m = s.trim().replace(/[$,\s]/g, "").match(/^(\d+(?:\.\d+)?)([kmb])?$/i);
  if (!m) return null;
  return Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase() as "k"] ?? 1);
}
export const fmtUsd = (n: number) => (n >= 1e6 ? `$${+(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${+(n / 1e3).toFixed(1)}k` : `$${Math.round(n)}`);

const STOP = new Set("the a an and or but to of in on for with at by from is are was were be been it this that these those my your our their his her its i you we they me just so very really now new today what when who how why not no yes all any more most can will would should could about into over than then there here have has had do does did get got make made like one two out up down off".split(" "));
/** v26: announcement words that never make a good coin name ("Introducing X" names X, not "Introducing"). */
const ANNOUNCE = new Set("introducing announcing launching launched shipping shipped available breaking confirmed tonight tomorrow yesterday version update updates finally officially excited proud thanks thank".split(" "));

/** The most "nameable" word in a post: longest alphabetic word that isn't a stop word, link, mention or number. */
export function topWord(text: string): string {
  const words = text.replace(/https?:\/\/\S+/g, " ").replace(/[@$][A-Za-z0-9_]+/g, " ").match(/[A-Za-z][A-Za-z'-]{2,}/g) ?? [];
  const pick = words.map((w) => w.replace(/['-]/g, "")).filter((w) => !STOP.has(w.toLowerCase()) && !ANNOUNCE.has(w.toLowerCase()) && w.length <= 16).sort((a, b) => b.length - a.length)[0];
  return pick ? pick[0].toUpperCase() + pick.slice(1).toLowerCase() : "Post";
}

/** Template variables: {Word} {word} {WORD} {handle} {text} {url} {date}, and in descriptions {name} {ticker}. */
export const TEMPLATE_VARS = ["{Word}", "{WORD}", "{word}", "{handle}", "{text}", "{url}", "{date}", "{name}", "{ticker}"] as const;
export function fillTemplate(t: string, post: Pick<XPost, "handle" | "text"> & Partial<Pick<XPost, "id" | "createdAt">>, coin?: { name: string; symbol: string }): string {
  const w = topWord(post.text);
  const clean = post.text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
  const url = post.id ? `https://x.com/${post.handle}/status/${post.id}` : "";
  const date = (post.createdAt ? new Date(post.createdAt) : new Date()).toISOString().slice(0, 10);
  let out = t.replace(/\{Word\}/g, w).replace(/\{word\}/g, w.toLowerCase()).replace(/\{WORD\}/g, w.toUpperCase()).replace(/\{handle\}/g, post.handle).replace(/\{text\}/g, clean).replace(/\{url\}/g, url).replace(/\{date\}/g, date);
  if (coin) out = out.replace(/\{name\}/g, coin.name).replace(/\{ticker\}/g, coin.symbol);
  return out;
}

/** v26 naming "post": the first cashtag in the post ($FERRY → Ferry / FERRY), or null. */
export function fromPost(text: string): { name: string; symbol: string } | null {
  const m = text.match(/(?:^|[^A-Za-z0-9_])\$([A-Za-z][A-Za-z0-9]{1,9})\b/);
  if (!m) return null;
  const sym = m[1].toUpperCase();
  return { name: sym[0] + sym.slice(1).toLowerCase(), symbol: sym };
}

/**
 * v26 naming "ask": what you typed on the draft card ("Night Ferry $FERRY", "FERRY", "Night Ferry / FERRY") as a name
 * and ticker, or null. The ticker is 2-10 letters or digits; a name alone takes its first word as the ticker.
 */
export function parseNameReply(text: string): { name: string; symbol: string } | null {
  const t = text.trim().replace(/^\/launch\s+\S+\s*/i, "");
  if (!t) return null;
  const tag = t.match(/\$([A-Za-z0-9]{2,10})\b/);
  const slash = t.match(/^(.{2,32}?)\s*[/|·,]\s*([A-Za-z0-9]{2,10})$/);
  let name: string, symbol: string;
  if (tag) { symbol = tag[1].toUpperCase(); name = t.replace(tag[0], "").replace(/\s+/g, " ").trim() || symbol[0] + symbol.slice(1).toLowerCase(); }
  else if (slash) { name = slash[1].trim(); symbol = slash[2].toUpperCase(); }
  else if (/^[A-Za-z0-9]{2,10}$/.test(t)) { symbol = t.toUpperCase(); name = symbol[0] + symbol.slice(1).toLowerCase(); }
  else { name = t; symbol = (t.match(/[A-Za-z0-9]+/)?.[0] ?? "").toUpperCase().slice(0, 10); }
  name = name.slice(0, 32);
  return name.length >= 2 && symbol.length >= 2 ? { name, symbol } : null;
}

/** v26 naming "ask": up to three suggestions for the card: your model's, the post's cashtag, the templates'. */
export function askSuggestions(r0: LaunchOnPostRule, post: XPost, s?: Suggestion | null): Array<{ name: string; symbol: string }> {
  const r = normalizeLaunchRule(r0);
  const out: Array<{ name: string; symbol: string }> = [];
  const add = (x: { name?: string; symbol?: string } | null | undefined) => {
    const sym = (x?.symbol ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 10);
    const name = (x?.name ?? "").trim().slice(0, 32);
    if (name.length < 2 || sym.length < 2 || claimIn(`${name} ${sym}`, [post.handle]) || forbiddenIntent(`${name} ${sym}`)) return;
    if (!out.some((o) => o.symbol === sym)) out.push({ name, symbol: sym });
  };
  add(s);
  add(fromPost(post.text));
  add({ name: fillTemplate(r.coin.nameTemplate, post), symbol: fillTemplate(r.coin.tickerTemplate, post) });
  return out.slice(0, 3);
}

/** v26 naming "ask": the token with the name you gave, through the same honesty pass. */
export function applyName(t: TokenDetails, post: Pick<XPost, "handle" | "id">, n: { name: string; symbol: string }): { token: TokenDetails; errors: string[] } {
  const r = enforceHonesty({ ...t, name: n.name.slice(0, 32), symbol: n.symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 10) }, post);
  return r;
}

// ---------- validation ----------

export function validateLaunchRule(r: LaunchOnPostRule): FieldError[] {
  const e: FieldError[] = [];
  if (!r.name.trim() || r.name.length > 60) e.push({ field: "name", message: "Give the rule a name (up to 60 characters)." });
  if (!r.trigger.handles.length) e.push({ field: "trigger.handles", message: "Pick at least one account." });
  if (r.trigger.handles.length > 20) e.push({ field: "trigger.handles", message: "At most 20 accounts per rule." });
  for (const h of r.trigger.handles) if (!HANDLE.test(h)) e.push({ field: "trigger.handles", message: `@${h} isn't a valid X handle.` });
  if (r.trigger.handles.length && !activeHandles(r).length && r.enabled) e.push({ field: "trigger.handles", message: "Every account is switched off. Turn one on, or turn the rule off." });
  for (const k of ["minLikes", "minViews"] as const) if (r.trigger[k] !== undefined && !(r.trigger[k]! >= 0)) e.push({ field: `trigger.${k}`, message: "Must be 0 or more." });
  if (!r.coin.nameTemplate.trim()) e.push({ field: "coin.nameTemplate", message: "Name template can't be empty." });
  if (!r.coin.tickerTemplate.trim()) e.push({ field: "coin.tickerTemplate", message: "Ticker template can't be empty." });
  if (r.coin.descriptionTemplate.length > 300) e.push({ field: "coin.descriptionTemplate", message: "Description template must be under 300 characters." });
  if (r.coin.image === "mine" && !r.coin.defaultImage) e.push({ field: "coin.defaultImage", message: "Add your image, or pick From post." });
  for (const [k, v] of Object.entries(r.coin.links)) if (v && !/^https:\/\/\S+$/.test(v)) e.push({ field: `coin.links.${k}`, message: "Links must start with https://" });
  if (r.coin.links.twitter && pointsAt(r.coin.links.twitter, r.trigger.handles)) e.push({ field: "coin.links.twitter", message: "The X link can't be a watched account. Use your own coin's account." });
  for (const f of [r.coin.nameTemplate, r.coin.tickerTemplate, r.coin.descriptionTemplate]) {
    const bad = forbiddenIntent(f) ?? claimIn(f, r.trigger.handles);
    if (bad) e.push({ field: "coin", message: `Refused: ${bad}.` });
  }
  const p = r.plan;
  if (p.mode === "manual" && p.devBuySol !== 0) e.push({ field: "plan.devBuySol", message: "Manual mode has no dev buy." });
  if (!(p.devBuySol >= 0 && p.devBuySol <= 50)) e.push({ field: "plan.devBuySol", message: "Dev buy must be 0-50 SOL." });
  if (!(p.teamWallets >= 0 && p.teamWallets <= MAX_TEAM_WALLETS)) e.push({ field: "plan.teamWallets", message: `Team wallets: 0-${MAX_TEAM_WALLETS}, always disclosed.` });
  if (p.teamWallets && p.mode !== "standard") e.push({ field: "plan.teamWallets", message: "Team wallets need Standard mode." });
  const perLaunch = spendOf(r);
  const L = r.limits;
  if (!(L.maxPerHour >= 1 && L.maxPerHour <= 10)) e.push({ field: "limits.maxPerHour", message: "Max launches per hour: 1-10." });
  if (!(L.maxPerDay >= 1 && L.maxPerDay <= 50)) e.push({ field: "limits.maxPerDay", message: "Max launches per day: 1-50." });
  if (!(L.cooldownMin >= 0 && L.cooldownMin <= 10_080)) e.push({ field: "limits.cooldownMin", message: "Cooldown: 0-10080 minutes." });
  if (!(L.maxSolPerLaunch > 0)) e.push({ field: "limits.maxSolPerLaunch", message: "Max SOL per launch must be above 0." });
  else if (perLaunch > L.maxSolPerLaunch + 1e-9) e.push({ field: "limits.maxSolPerLaunch", message: `This setup spends ${perLaunch} SOL per launch, above your ${L.maxSolPerLaunch} SOL limit.` });
  if (!(L.maxSolPerDay >= L.maxSolPerLaunch)) e.push({ field: "limits.maxSolPerDay", message: "Max SOL per day must be at least the per-launch max." });
  if (!(r.confirmTtlSec >= 30 && r.confirmTtlSec <= 3600)) e.push({ field: "confirmTtlSec", message: "Confirm window: 30-3600 seconds." });
  e.push(...validateExit(r.exit));
  e.push(...validateV26(normalizeLaunchRule(r)));
  return e;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** v26 settings: triggers, pair and fees, clash check, limits. */
function validateV26(r: LaunchOnPostRule): FieldError[] {
  const e: FieldError[] = [];
  const t = r.trigger;
  if (t.velocity) {
    const v = t.velocity;
    if (!(v.likes >= 1)) e.push({ field: "trigger.velocity", message: "Velocity: at least 1 like." });
    if (!(v.withinSec >= 5 && v.withinSec <= 3600)) e.push({ field: "trigger.velocity", message: "Velocity window: 5-3600 seconds." });
    if (!(v.waitSec >= v.withinSec && v.waitSec <= 3600)) e.push({ field: "trigger.velocity", message: "Wait at least as long as the velocity window (at most an hour)." });
  }
  for (const h of t.hours ?? []) if (!HHMM.test(h.from) || !HHMM.test(h.to)) e.push({ field: "trigger.hours", message: "Times look like 09:00." });
  if (t.languages?.some((l) => !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(l))) e.push({ field: "trigger.languages", message: "Languages are codes like en, es, ja." });
  if (t.dedupe && !(t.dedupe.windowMin >= 1 && t.dedupe.windowMin <= 1440)) e.push({ field: "trigger.dedupe", message: "Topic window: 1-1440 minutes." });
  if (t.dedupe && !(t.dedupe.similarity >= 0.3 && t.dedupe.similarity <= 1)) e.push({ field: "trigger.dedupe", message: "Similarity: 0.3-1." });
  const pr = r.pair;
  if (pr && pr.quote !== "SOL") {
    const p = findPair(pr.quote);
    if (!p) e.push({ field: "pair.quote", message: `${pr.quote} isn't in the pair list.` });
    else if (!pairSelectable(p)) e.push({ field: "pair.quote", message: p.note ? `${p.id} can't be used: it's ${p.note}.` : `${p.id}'s mint isn't verified yet, so it can't be used.` });
    if (pr.creatorFeePct !== undefined && !(pr.creatorFeePct >= CUSTOM_PAIR_FEE.min && pr.creatorFeePct <= CUSTOM_PAIR_FEE.max)) e.push({ field: "pair.creatorFeePct", message: `Creator fee on a custom pair: ${CUSTOM_PAIR_FEE.min}-${CUSTOM_PAIR_FEE.max}%.` });
  }
  if (pr && (pr.fees === "cashback" || pr.fees === "split") && pr.quote === "SOL") e.push({ field: "pair.fees", message: "Cashback and a fee split are for custom pairs." });
  if (pr?.fees === "split") {
    const sp = pr.split ?? [];
    const sum = sp.reduce((a, x) => a + x.pct, 0);
    if (!sp.length || sp.length > 10) e.push({ field: "pair.split", message: "A split has 1-10 recipients." });
    else if (Math.abs(sum - 100) > 1e-6) e.push({ field: "pair.split", message: `Shares must add up to 100% (now ${+sum.toFixed(2)}%).` });
    if (sp.some((x) => !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x.address))) e.push({ field: "pair.split", message: "Each recipient needs a Solana address." });
  }
  if (r.plan.devBuyIn === "quote" && (pr?.quote ?? "SOL") === "SOL") e.push({ field: "plan.devBuyIn", message: "A dev buy in the pair asset needs a custom pair." });
  if (r.coin.minImagePx !== undefined && !(r.coin.minImagePx >= 64 && r.coin.minImagePx <= 2048)) e.push({ field: "coin.minImagePx", message: "Minimum image size: 64-2048 px." });
  if (r.clash && !(r.clash.windowSec >= 10 && r.clash.windowSec <= 3600)) e.push({ field: "clash.windowSec", message: "Clash check: look back 10-3600 seconds." });
  if (r.race && !(r.race.windowMin >= 1 && r.race.windowMin <= 120)) e.push({ field: "race.windowMin", message: "Race window: 1-120 minutes." });
  if (r.limits.maxOpenCoins !== undefined && !(r.limits.maxOpenCoins >= 1 && r.limits.maxOpenCoins <= 100)) e.push({ field: "limits.maxOpenCoins", message: "Max open launched coins: 1-100." });
  for (const p of [...(t.patterns?.include ?? []), ...(t.patterns?.exclude ?? [])]) { const bad = patternError(p); if (bad) e.push({ field: "trigger.patterns", message: `/${p}/: ${bad}` }); }
  if (t.priorityHoldSec !== undefined && !(t.priorityHoldSec >= 0 && t.priorityHoldSec <= 120)) e.push({ field: "trigger.priorityHoldSec", message: "Priority hold: 0-120 seconds." });
  if (r.coin.naming === "ask" && r.mode !== "confirm") e.push({ field: "coin.naming", message: "\"Ask me\" needs Confirm mode: the draft card is where you name the coin." });
  return e;
}

/**
 * v26: a regular expression from the Advanced triggers, or why it can't be used. Kept small and simple on purpose:
 * at most 120 characters, and no nested repeats like (a+)+ that can take seconds on one post.
 */
export function patternError(p: string): string | null {
  if (!p.trim()) return "empty";
  if (p.length > 120) return "at most 120 characters";
  if (/\([^)]*[+*][^)]*\)\s*[+*{]/.test(p)) return "nested repeats like (a+)+ aren't allowed";
  try { new RegExp(p, "iu"); return null; } catch (err) { return `not a valid pattern (${(err as Error).message.replace(/^Invalid regular expression: /, "")})`; }
}
const rx = (p: string) => { try { return new RegExp(p, "iu"); } catch { return null; } };

/** v26: how long a post from this account waits for a higher-priority account (0 for the first account, or no hold). */
export function priorityHold(r: Pick<LaunchOnPostRule, "trigger">, handle: string): number {
  const hold = r.trigger.priorityHoldSec ?? 0;
  if (!hold) return 0;
  return priorityOf(r, handle) > 1 ? hold : 0;
}
/** v26: the account's place in the rule's priority order (1 = first), or 0 when it isn't watched or is switched off. */
export const priorityOf = (r: Pick<LaunchOnPostRule, "trigger">, handle: string) => activeHandles(r).map((h) => h.toLowerCase()).indexOf(handle.toLowerCase()) + 1;

/** v26: move an account up or down the priority order. */
export function moveHandle<R extends Pick<LaunchOnPostRule, "trigger">>(r: R, handle: string, by: -1 | 1): R {
  const hs = [...r.trigger.handles];
  const i = hs.findIndex((h) => h.toLowerCase() === handle.toLowerCase());
  const j = i + by;
  if (i < 0 || j < 0 || j >= hs.length) return r;
  [hs[i], hs[j]] = [hs[j], hs[i]];
  return { ...r, trigger: { ...r.trigger, handles: hs } };
}

export const spendOf = (r: Pick<LaunchOnPostRule, "plan">) => +((r.plan.mode === "standard" ? r.plan.devBuySol + r.plan.teamWallets * r.plan.teamSolEach : 0).toFixed(9));

function pointsAt(url: string, handles: string[]): boolean {
  const m = url.match(/^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})/i);
  return !!m && handles.map((h) => h.toLowerCase()).includes(m[1].toLowerCase());
}

/** Claims of being the person's official / verified / endorsed coin. Returns what was claimed, or null. */
export function claimIn(text: string, handles: string[]): string | null {
  if (/\b(official|verified|authentic|endorsed|approved|sanctioned|real)\b/i.test(text)) return "claiming to be official or endorsed";
  if (/[✓✔☑✅]/u.test(text)) return "verified-style marks";
  for (const h of handles) {
    const re = new RegExp(`(\\b(by|from|team of|on behalf of)\\s+@?${h}\\b)|(@?${h}'?s\\s+(own\\s+|first\\s+)?(coin|token|memecoin))`, "i");
    if (re.test(text)) return `presenting it as @${h}'s coin`;
  }
  return null;
}

/**
 * The honesty pass every auto-launched coin goes through. Returns the token as it will be launched, or errors.
 * The disclaimer is appended last and can't be removed; the X link can't point at the person; the post is the source link.
 */
export function enforceHonesty(t: TokenDetails, post: Pick<XPost, "handle" | "id">, reserveForTeam = 0): { token: TokenDetails; errors: string[] } {
  const errors: string[] = [];
  const d = disclaimer(post.handle);
  const url = postUrl(post);
  const handles = [post.handle];
  for (const [field, v] of [["name", t.name], ["ticker", t.symbol]] as const) {
    const bad = claimIn(v, handles) ?? forbiddenIntent(v);
    if (bad) errors.push(`${field}: refused, ${bad}`);
  }
  const body = t.description.replace(/Inspired by a post from @\w+\. Not affiliated with or endorsed by them\.?/gi, "").trim();
  const bad = claimIn(body, handles) ?? forbiddenIntent(body);
  if (bad) errors.push(`description: refused, ${bad}`);
  const room = DESCRIPTION_MAX - reserveForTeam - d.length - 2;
  const description = `${body.length > room ? body.slice(0, Math.max(0, room - 1)).trimEnd() + "…" : body}${body ? "\n\n" : ""}${d}`;
  const twitter = t.twitter && (pointsAt(t.twitter, handles) || t.twitter.includes(`/status/${post.id}`)) ? undefined : t.twitter;
  const website = t.website || url;
  return { token: { ...t, description, twitter, website }, errors };
}

// ---------- matching ----------

export const CASHTAG = /(^|[^A-Za-z0-9_])\$[A-Za-z][A-Za-z0-9]{1,9}\b/;
export const CONTRACT = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;
const phraseIn = (text: string, p: string) => text.toLowerCase().includes(p.toLowerCase().trim());

/** "09:00" → minutes after midnight. */
const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
/** v26: is `at` inside one of the rule's time-of-day windows (windows may cross midnight)? No windows = always. */
export function inHours(t: Pick<LaunchOnPostRule["trigger"], "hours" | "tzOffsetMin">, at: number): boolean {
  if (!t.hours?.length) return true;
  const d = new Date(at + (t.tzOffsetMin ?? 0) * 60_000);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return t.hours.some((h) => { const a = mins(h.from), b = mins(h.to); return a <= b ? m >= a && m < b : m >= a || m < b; });
}

/** v26: word sets for topic dedupe (links, mentions and stop words out). */
export function topicWords(text: string): Set<string> {
  return new Set((text.toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/@\w+/g, " ").match(/[a-z0-9$]{3,}/g) ?? []).filter((w) => !STOP.has(w)));
}
/** Jaccard similarity of two posts' words, 0-1. */
export function similarity(a: string, b: string): number {
  const A = topicWords(a), B = topicWords(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / (A.size + B.size - n);
}

/**
 * Does a post match the rule's triggers? Velocity isn't decided here (it needs the post's likes over time): a match
 * with `velocity` set comes back with `wait` and the caller watches the counts (velocityDecision) before going on.
 */
export function matchLaunchPost(r0: LaunchOnPostRule, post: XPost, now = Date.now()): { ok: true; notes: string[]; wait?: NonNullable<LaunchOnPostRule["trigger"]["velocity"]> } | { ok: false; reason: string } {
  const r = normalizeLaunchRule(r0);
  if (!r.enabled) return { ok: false, reason: "rule is off" };
  const t = r.trigger;
  const h = post.handle.toLowerCase();
  if (!t.handles.map((x) => x.toLowerCase()).includes(h)) return { ok: false, reason: "not a watched account" };
  if ((t.off ?? []).map((x) => x.toLowerCase()).includes(h)) return { ok: false, reason: `@${post.handle} is switched off in this rule` };
  const ig = t.ignore!;
  if (post.isReply && ig.replies) return { ok: false, reason: "replies are ignored" };
  if (post.isQuote && ig.quotes) return { ok: false, reason: "quotes are ignored" };
  if (post.isRepost && ig.reposts) return { ok: false, reason: "reposts are ignored" };
  const kw = (t.keywords ?? []).map((k) => k.trim()).filter(Boolean);
  const inc = (t.patterns?.include ?? []).filter((p) => !patternError(p));
  if ((kw.length || inc.length) && !kw.some((k) => phraseIn(post.text, k)) && !inc.some((p) => rx(p)?.test(post.text))) return { ok: false, reason: inc.length && !kw.length ? "no pattern matched the post" : "no keyword in the post" };
  const ex = (t.exclude ?? []).map((k) => k.trim()).filter(Boolean).find((k) => phraseIn(post.text, k));
  if (ex) return { ok: false, reason: `the post says "${ex}" (excluded)` };
  const exp = (t.patterns?.exclude ?? []).filter((p) => !patternError(p)).find((p) => rx(p)?.test(post.text));
  if (exp) return { ok: false, reason: `the post matches /${exp}/ (excluded)` };
  const photo = post.media?.some((m) => m.type === "photo");
  const video = post.media?.some((m) => m.type === "video" || m.type === "animated_gif");
  if (t.media === "image" && !photo) return { ok: false, reason: "post has no image" };
  if (t.media === "video" && !video) return { ok: false, reason: "post has no video" };
  if (t.media === "image-or-video" && !photo && !video) return { ok: false, reason: "post has no image or video" };
  const tag = CASHTAG.test(post.text), ca = CONTRACT.test(post.text) || post.urls.some((u) => CONTRACT.test(u));
  if (t.cashtag === "require" && !tag) return { ok: false, reason: "no cashtag in the post" };
  if (t.cashtag === "forbid" && tag) return { ok: false, reason: "the post has a cashtag" };
  if (t.contract === "require" && !ca) return { ok: false, reason: "no contract address in the post" };
  if (t.contract === "forbid" && ca) return { ok: false, reason: "the post has a contract address" };
  const notes: string[] = [];
  if (t.languages?.length) {
    if (!post.lang) notes.push("language not given by this X source; filter skipped");
    else if (!t.languages.some((l) => post.lang!.toLowerCase().startsWith(l.toLowerCase()))) return { ok: false, reason: `post is in ${post.lang}, not ${t.languages.join(" / ")}` };
  }
  if (!inHours(t, now)) return { ok: false, reason: "outside the rule's hours" };
  if (t.minLikes !== undefined) {
    if (post.metrics?.likes === undefined) notes.push("likes not available from this X source; filter skipped");
    else if (post.metrics.likes < t.minLikes) return { ok: false, reason: `${post.metrics.likes} likes, below ${t.minLikes}` };
  }
  if (t.minViews !== undefined) {
    if (post.metrics?.views === undefined) notes.push("views not available from this X source; filter skipped");
    else if (post.metrics.views < t.minViews) return { ok: false, reason: `${post.metrics.views} views, below ${t.minViews}` };
  }
  return t.velocity ? { ok: true, notes, wait: t.velocity } : { ok: true, notes };
}

/**
 * v26: engagement velocity. `samples` are like counts read since the post (ms after the post, likes). Decides once the
 * velocity window has passed or the like count is reached; "wait" until then; "no" when the wait is over.
 */
export function velocityDecision(v: NonNullable<LaunchOnPostRule["trigger"]["velocity"]>, samples: Array<{ ms: number; likes?: number }>, elapsedMs: number): { go: true; note: string } | { go: false; wait: true } | { go: false; wait: false; reason: string } {
  const inWindow = samples.filter((x) => x.likes !== undefined && x.ms <= v.withinSec * 1000);
  const hit = inWindow.find((x) => (x.likes ?? 0) >= v.likes);
  if (hit) return { go: true, note: `${hit.likes} likes ${Math.round(hit.ms / 1000)} s after the post` };
  const over = elapsedMs >= v.withinSec * 1000 || elapsedMs >= v.waitSec * 1000;
  if (!over) return { go: false, wait: true };
  if (!samples.some((x) => x.likes !== undefined)) return { go: false, wait: false, reason: "likes aren't available from this X source, so velocity can't be checked" };
  const best = Math.max(0, ...inWindow.map((x) => x.likes ?? 0));
  return { go: false, wait: false, reason: `${best} likes within ${v.withinSec} s, below ${v.likes}` };
}

/** v26: one launch per topic: the same post, or a similar post from any account, within the window. */
export function topicClash(r: LaunchOnPostRule, post: Pick<XPost, "id" | "text" | "handle">, history: LaunchRecord[], now = Date.now()): string | null {
  const d = normalizeLaunchRule(r).trigger.dedupe!;
  if (!d.topic) return null;
  for (const h of history) {
    if (h.status !== "launched" && h.status !== "pending" && h.status !== "paper") continue;
    if (now - h.at > d.windowMin * 60_000 || h.postId === post.id || !h.postText) continue;
    const sim = similarity(h.postText, post.text);
    if (sim >= d.similarity) return `same topic as @${h.handle}'s post ${Math.max(1, Math.round((now - h.at) / 60_000))} min ago (${Math.round(sim * 100)}% similar)`;
  }
  return null;
}

// ---------- limits ----------

export interface AutoLaunchContext {
  killSwitch: boolean;
  paused?: boolean;
  /** Every launch-on-post record (all rules), newest last. */
  history: LaunchRecord[];
  now?: number;
  /** v26: coins this rule launched that are still open (for maxOpenCoins) */
  openLaunched?: number;
}

/** Rate limits, cooldown, spend and dedupe. Runs before a draft is even built, and again right before signing. */
export function checkAutoLaunch(r: LaunchOnPostRule, post: Pick<XPost, "id" | "handle">, c: AutoLaunchContext): GuardResult {
  const now = c.now ?? Date.now();
  const no = (code: Extract<GuardResult, { ok: false }>["code"], reason: string): GuardResult => ({ ok: false, code, reason });
  if (c.killSwitch) return no("kill-switch", "Kill switch is on. Automated launches are stopped.");
  if (c.paused) return no("paused", "Agent is paused.");
  if (c.history.some((h) => h.postId === post.id && h.status !== "skipped" && h.status !== "expired" && h.status !== "failed"))
    return no("launch-dedupe", "Already launched (or drafted) a coin for this post.");
  const counted = c.history.filter((h) => h.status === "launched" || h.status === "paper" || h.status === "pending");
  const last = [...counted].reverse().find((h) => h.handle.toLowerCase() === post.handle.toLowerCase());
  if (last && now - last.at < r.limits.cooldownMin * 60_000) return no("launch-cooldown", `Cooldown: last launch from @${post.handle} was ${Math.round((now - last.at) / 60_000)} min ago (${r.limits.cooldownMin} min).`);
  const mine = counted.filter((h) => h.ruleId === r.id);
  if (mine.filter((h) => now - h.at < 3_600_000).length >= r.limits.maxPerHour) return no("launch-rate", `Hit ${r.limits.maxPerHour} launches this hour.`);
  const today = mine.filter((h) => now - h.at < 86_400_000);
  if (today.length >= r.limits.maxPerDay) return no("launch-rate", `Hit ${r.limits.maxPerDay} launches in 24 hours.`);
  if (r.limits.maxOpenCoins !== undefined && (c.openLaunched ?? 0) >= r.limits.maxOpenCoins) return no("launch-rate", `${c.openLaunched} launched coins still open (max ${r.limits.maxOpenCoins}).`);
  const spend = spendOf(r);
  if (spend > r.limits.maxSolPerLaunch + 1e-9) return no("launch-spend", `${spend} SOL per launch is above the ${r.limits.maxSolPerLaunch} SOL limit.`);
  const spent = today.reduce((a, h) => a + h.sol, 0);
  if (spent + spend > r.limits.maxSolPerDay + 1e-9) return no("launch-spend", `Daily launch budget: ${+spent.toFixed(4)} of ${r.limits.maxSolPerDay} SOL used.`);
  return { ok: true };
}

// ---------- drafting ----------

export interface Suggestion {
  name?: string;
  symbol?: string;
  description?: string;
}

export const POST_LAUNCH_PROMPT = `You name a memecoin inspired by a public post. Reply with JSON only:
{"name": string (2-32 chars), "symbol": string (2-10 letters/digits, no $), "description": string (under 200 chars)}
Be specific to the post's content. The coin is NOT the poster's coin: never use the words official, verified,
authentic, endorsed or real; never present it as the poster's own coin; never use the poster's name as the whole name.
No price talk, no promises.`;

/** v26: the model prompt in the rule's voice. */
export const postLaunchPrompt = (style: string = "short") => `${POST_LAUNCH_PROMPT}\nVoice: ${NAMING_STYLES[normStyle(style)]}`;

/** Name, ticker and description for a post: the model's suggestion if it passes the honesty rules, else the templates. */
export function draftToken(r0: LaunchOnPostRule, post: XPost, s?: Suggestion | null): { token: TokenDetails; errors: string[]; usedModel: boolean } {
  const r = normalizeLaunchRule(r0);
  const fp = r.coin.naming === "post" ? fromPost(post.text) : null;
  const tpl = fp ?? { name: fillTemplate(r.coin.nameTemplate, post).slice(0, 32), symbol: fillTemplate(r.coin.tickerTemplate, post).replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 10) };
  const cleanSym = (x?: string) => (x ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 10);
  const handles = [post.handle];
  const modelOk = !!s?.name && !!s.symbol && !claimIn(`${s.name} ${s.symbol} ${s.description ?? ""}`, handles) && cleanSym(s.symbol).length >= 2;
  const name = modelOk && !fp ? s!.name!.trim().slice(0, 32) : tpl.name;
  const symbol = modelOk && !fp ? cleanSym(s!.symbol) : tpl.symbol.length >= 2 ? tpl.symbol : "POST";
  const desc = modelOk && s!.description ? s!.description : fillTemplate(r.coin.descriptionTemplate, post, { name, symbol });
  const team = r.plan.mode === "standard" && r.plan.teamWallets ? disclosureText({ wallets: Array.from({ length: r.plan.teamWallets }, () => "x".repeat(44)), solEach: r.plan.teamSolEach, disclosed: true }, 99.9).length + 2 : 0;
  const pr = r.pair!;
  const base: TokenDetails = {
    name, symbol, description: desc, website: r.coin.websiteFrom === "post" ? undefined : r.coin.links.website, twitter: r.coin.links.twitter, telegram: r.coin.links.telegram,
    quote: pr.quote, creatorFees: pr.fees,
    ...(pr.quote !== "SOL" ? { creatorFeePct: pr.creatorFeePct ?? CUSTOM_PAIR_FEE.min } : {}),
    ...(pr.fees === "split" && pr.split ? { feeSplit: pr.split } : {}),
  };
  const { token, errors } = enforceHonesty(base, post, team);
  return { token, errors, usedModel: modelOk && !fp };
}

/** Which image to use. Returns a URL for "post", or a marker for the caller to resolve. */
export function pickImage(r: LaunchOnPostRule, post: XPost): { kind: "url"; url: string } | { kind: "generate" } | { kind: "mine"; ref?: string } {
  const photo = post.media?.find((m) => m.type === "photo");
  if (r.coin.image === "post" && photo) return { kind: "url", url: photo.url };
  if (r.coin.image === "generate") return { kind: "generate" };
  return { kind: "mine", ref: r.coin.defaultImage };
}

/** The LaunchPlan the existing launcher runs (same validation, same guardrails, same disclosure). */
export function planFor(r: LaunchOnPostRule, token: TokenDetails, teamAddresses: string[]): LaunchPlan {
  const d = defaultPlan();
  const n = r.plan.mode === "standard" ? Math.min(r.plan.teamWallets, teamAddresses.length) : 0;
  return {
    ...d, launchpad: "pumpfun", mode: r.plan.mode, token,
    devBuySol: r.plan.mode === "standard" ? r.plan.devBuySol : 0, jitoTipSol: r.plan.jitoTipSol, priorityFeeSol: r.plan.priorityFeeSol, slippagePct: r.plan.slippagePct,
    team: n ? { wallets: teamAddresses.slice(0, n), solEach: r.plan.teamSolEach, disclosed: true } : null,
  };
}

export function describeLaunchExit(x: ExitSpec): string[] {
  const out: string[] = [];
  for (const t of x.timeSells ?? []) out.push(`Sell ${t.sellPct === 100 ? "the dev position" : `${t.sellPct}%`} ${t.afterSec} s after launch`);
  for (const t of x.mcapTargets ?? []) out.push(`Sell ${t.sellPct === 100 ? "the rest" : `${t.sellPct}%`} at ${fmtUsd(t.atMcapUsd)} market cap`);
  if (x.stopBelowMcapUsd !== undefined) out.push(`Sell everything if market cap drops below ${fmtUsd(x.stopBelowMcapUsd)}`);
  for (const t of x.takeProfit ?? []) out.push(`Sell ${t.sellPct}% at ${t.atMultiple}x`);
  if (x.stopLossPct !== undefined) out.push(`Stop-loss at -${x.stopLossPct}%`);
  if (x.trailingStopPct !== undefined) out.push(`Trailing stop ${x.trailingStopPct}%`);
  if (x.timeoutMin !== undefined) out.push(`Sell everything after ${x.timeoutMin >= 120 ? `${+(x.timeoutMin / 60).toFixed(1)}h` : `${x.timeoutMin} min`}`);
  if (x.noVolume) out.push(`Sell everything if under ${x.noVolume.minVolSol} SOL trades in ${x.noVolume.windowSec} s`);
  return out;
}

export function describeLaunchRule(r0: LaunchOnPostRule): string[] {
  const r = normalizeLaunchRule(r0);
  const t = r.trigger;
  const ig = t.ignore!;
  const skip = [ig.replies && "replies", ig.quotes && "quotes", ig.reposts && "reposts"].filter(Boolean) as string[];
  const media = t.media === "image" ? " a picture" : t.media === "video" ? " a video" : t.media === "image-or-video" ? " a picture or video" : "";
  const extra = [
    t.keywords?.length ? `mentioning ${t.keywords.map((k) => `"${k}"`).join(" or ")}` : "",
    t.exclude?.length ? `not ${t.exclude.map((k) => `"${k}"`).join(" or ")}` : "",
    t.cashtag === "require" ? "with a cashtag" : t.cashtag === "forbid" ? "without a cashtag" : "",
    t.contract === "require" ? "with a contract address" : t.contract === "forbid" ? "without a contract address" : "",
    t.languages?.length ? `in ${t.languages.join(" / ")}` : "",
  ].filter(Boolean).join(", ");
  const pr = r.pair!;
  const fee = pr.quote !== "SOL" ? `, creator fee ${pr.creatorFeePct ?? CUSTOM_PAIR_FEE.min}% paid in ${pr.quote}` : "";
  const feesTo = pr.fees === "holders" ? ", fees to holders" : pr.fees === "cashback" ? ", Cashback" : pr.fees === "split" ? `, fees split ${pr.split?.length ?? 0} ways` : "";
  return [
    `When ${activeHandles(r).map((h) => "@" + h).join(", ") || "(pick accounts)"}${activeHandles(r).length > 1 ? " (in priority order)" : ""}${t.groups?.length ? ` and ${t.groups.length} tracker group${t.groups.length === 1 ? "" : "s"}` : ""} posts${media}${extra ? ` ${extra}` : ""}${skip.length ? ` (no ${skip.join(", ")})` : ""}${t.off?.length ? `; switched off: ${t.off.map((h) => "@" + h).join(", ")}` : ""}`,
    ...(t.patterns?.include?.length || t.patterns?.exclude?.length ? [`Patterns: ${[...(t.patterns.include ?? []).map((p) => `/${p}/`), ...(t.patterns.exclude ?? []).map((p) => `not /${p}/`)].join(", ")}`] : []),
    t.velocity ? `Only if it gets ${t.velocity.likes} likes within ${t.velocity.withinSec} s (waits up to ${t.velocity.waitSec} s)` : "Instant: no wait for likes",
    ...(t.priorityHoldSec && activeHandles(r).length > 1 ? [`Accounts below the first wait ${t.priorityHoldSec} s for a post on the same topic from one higher up`] : []),
    ...(t.hours?.length ? [`Only ${t.hours.map((h) => `${h.from}-${h.to}`).join(", ")}${t.tzOffsetMin ? ` (UTC${t.tzOffsetMin > 0 ? "+" : "-"}${Math.abs(t.tzOffsetMin / 60)})` : " UTC"}`] : []),
    t.dedupe?.topic ? `One launch per topic across every account (${t.dedupe.windowMin} min)` : "One launch per post",
    `Launch a coin on pump.fun: ${r.coin.naming === "model" ? `name and ticker from your model (${r.coin.style})` : r.coin.naming === "ask" ? "you name it on the draft card (with suggestions)" : r.coin.naming === "post" ? "the post's cashtag as name and ticker (else the templates)" : `name "${r.coin.nameTemplate}", ticker "${r.coin.tickerTemplate}"`}, image ${r.coin.image === "post" ? `from the post${r.coin.crop ? ", cropped square" : ""} (at least ${r.coin.minImagePx ?? 256} px)` : r.coin.image === "generate" ? "generated" : "your own"}`,
    `Pair ${pr.quote}${fee}${feesTo}`,
    r.plan.mode === "standard" ? `Standard: ${r.plan.devBuySol} ${r.plan.devBuyIn === "quote" ? pr.quote : "SOL"} dev buy${r.plan.teamWallets ? `, ${r.plan.teamWallets} disclosed team wallets × ${r.plan.teamSolEach} SOL` : ""}` : "Manual: deploy only, no dev buy",
    `Links: ${r.coin.websiteFrom === "post" || !r.coin.links.website ? "the post as the source link" : "your website"}${r.coin.links.telegram ? ", your Telegram" : ""}${r.coin.links.twitter ? ", your X" : ""}`,
    `Same post, ticker, name${r.clash!.image !== false ? " or image" : ""} launched in the last ${r.clash!.windowSec} s: ${r.clash!.action === "skip" ? "skip" : r.clash!.action === "rename" ? "rename the ticker" : "launch anyway"}`,
    ...describeLaunchExit(r.exit),
    `${r.mode === "auto" ? "Auto: launches without asking" : `Confirm: sends a draft to Telegram and the panel, expires after ${r.confirmTtlSec}s`}`,
    `Limits: ${r.limits.maxPerHour}/hour, ${r.limits.maxPerDay}/day, ${r.limits.maxSolPerLaunch} SOL per launch, ${r.limits.maxSolPerDay} SOL per day, ${r.limits.cooldownMin} min cooldown per account${r.limits.maxOpenCoins ? `, ${r.limits.maxOpenCoins} open coins at most` : ""}`,
    "Description always ends with: \"Inspired by a post from @handle. Not affiliated with or endorsed by them.\"",
  ];
}

// ---------- CLI / chat ----------

/** "50%@100k,100%@250k" → market-cap targets. */
export function parseSellLadder(s: string): ExitSpec["mcapTargets"] | null {
  const out: NonNullable<ExitSpec["mcapTargets"]> = [];
  for (const part of s.split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^(\d{1,3}|all|half|rest)%?\s*@\s*(.+)$/i);
    if (!m) return null;
    const pct = /^(all|rest)$/i.test(m[1]) ? 100 : /^half$/i.test(m[1]) ? 50 : Number(m[1]);
    const usd = parseUsd(m[2]);
    if (!usd || !(pct >= 1 && pct <= 100)) return null;
    out.push({ atMcapUsd: usd, sellPct: pct });
  }
  return out.length ? out : null;
}

export const LAUNCH_RULE_REQUEST = /\blaunch\b.{0,60}\b(whenever|every\s*time|each\s*time|when|if)\b.{0,40}@[A-Za-z0-9_]{1,15}.{0,40}\bposts?\b|\b(whenever|every\s*time|each\s*time|when|if)\s+@[A-Za-z0-9_]{1,15}\b.{0,80}\bposts?\b.{0,120}\blaunch\b/i;

/** v26 chat: the quote pair named in a sentence ("pair it with USDC", "on a USDC pair", "on NVDAx", "quoted in USD1"). */
export function pairFromText(t: string): string | null {
  const pats = [
    /\bpair(?:ed)?\s+(?:it\s+|them\s+|the\s+coin\s+)?(?:with|to|against|on|in)\s+(?:an?\s+)?\$?([A-Za-z0-9]{2,10})\b/i,
    /\b(?:on|with|in)\s+(?:an?\s+|the\s+)?\$?([A-Za-z0-9]{2,10})\s+(?:pair|quote)\b/i,
    /\bquoted?\s+(?:in|with|on)\s+\$?([A-Za-z0-9]{2,10})\b/i,
    /\b(?:launch|deploy)\w*\s+(?:it\s+|a\s+coin\s+|the\s+coin\s+)?on\s+\$?([A-Za-z0-9]{2,10})\b/i,
  ];
  for (const re of pats) { const m = t.match(re); const p = m ? findPair(m[1]) : undefined; if (p) return p.id; }
  return null;
}
/** v26 chat: "0.5% fee", "creator fee 0.25%", "fee of 1%" → percent. */
export function feeFromText(t: string): number | null {
  const m = t.match(/(\d+(?:\.\d+)?)\s*%\s*(?:creator\s+)?fees?\b/i) ?? t.match(/\b(?:creator\s+)?fees?\s+(?:of\s+|at\s+|=\s*)?(\d+(?:\.\d+)?)\s*%/i);
  return m ? Number(m[1]) : null;
}

export function parseLaunchRuleRequest(text: string): { draft: LaunchOnPostRule; summary: string[]; errors: FieldError[] } | null {
  const t = text.trim();
  if (!LAUNCH_RULE_REQUEST.test(t)) return null;
  // the watched accounts are the ones named before "post(s)"; later mentions ("split with @team") aren't watched
  const cut = t.search(/\bposts?\b/i);
  const mentions = [...t.matchAll(/@([A-Za-z0-9_]{1,15})/g)];
  const before = mentions.filter((m) => cut < 0 || (m.index ?? 0) < cut);
  const handles = [...new Set((before.length ? before : mentions).map((m) => m[1].toLowerCase()))];
  const r = defaultLaunchRule({ name: `Launch on @${handles[0]} posts`, enabled: false });
  r.trigger = { handles, requireImage: /\b(picture|photo|image|pic|meme)s?\b/i.test(t) };
  const kw = t.match(/\b(?:mentions?|mentioning|about|with the word)\s+["']?([A-Za-z0-9$#]{2,24})/i);
  if (kw) r.trigger.keywords = [kw[1].replace(/^[#$]/, "")];
  if (/\b(no dev buy|manual|deploy only)\b/i.test(t)) r.plan = { ...r.plan, mode: "manual", devBuySol: 0 };
  const dev = t.match(/(\d+(?:\.\d+)?)\s*sol\s+dev\s*buy|dev\s*buy\s*(?:of\s*)?(\d+(?:\.\d+)?)/i);
  if (dev) r.plan = { ...r.plan, mode: "standard", devBuySol: Number(dev[1] ?? dev[2]) };
  const targets: NonNullable<ExitSpec["mcapTargets"]> = [];
  for (const m of t.matchAll(/\bsell\s+(half|all|everything|\d{1,3}\s*%)\s*(?:at|@)\s*\$?(\d+(?:\.\d+)?\s*[kmb]?)/gi)) {
    const pct = /half/i.test(m[1]) ? 50 : /all|everything/i.test(m[1]) ? 100 : Number(m[1].replace(/\D/g, ""));
    const usd = parseUsd(m[2]);
    if (usd) targets.push({ atMcapUsd: usd, sellPct: pct });
  }
  const rest = t.match(/\b(?:the\s+)?(?:rest|remainder)\s*(?:at|@)\s*\$?(\d+(?:\.\d+)?\s*[kmb]?)/i);
  if (rest && parseUsd(rest[1])) targets.push({ atMcapUsd: parseUsd(rest[1])!, sellPct: 100 });
  const stop = t.match(/\bstop\s*(?:out|loss)?\s*(?:if|at|below|under)\s*(?:mcap\s*|market\s*cap\s*)?(?:drops?\s*(?:below|under)\s*)?\$?(\d+(?:\.\d+)?\s*[kmb]?)/i);
  const timeout = t.match(/\b(?:sell\s+(?:everything|all)\s+)?after\s+(\d+)\s*(h|hours?|m|min|minutes?)\b/i);
  const exit: ExitSpec = { ...(targets.length ? { mcapTargets: targets.sort((a, b) => a.atMcapUsd - b.atMcapUsd) } : r.exit) };
  if (stop && parseUsd(stop[1])) exit.stopBelowMcapUsd = parseUsd(stop[1])!;
  else if (!targets.length) exit.stopBelowMcapUsd = r.exit.stopBelowMcapUsd;
  if (timeout) exit.timeoutMin = Number(timeout[1]) * (/^h/i.test(timeout[2]) ? 60 : 1);
  else if (!targets.length) exit.timeoutMin = r.exit.timeoutMin;
  // v26: "sell if under 0.5 SOL trades in 2 min" / "no volume for 120s"
  const nov = t.match(/\b(?:under|less than|below)\s+(\d+(?:\.\d+)?)\s*sol\s+(?:trades?|volume|traded)\s+(?:in|within|over)\s+(\d+)\s*(s|sec|seconds?|m|min|minutes?)\b/i);
  const nov2 = t.match(/\bno\s+volume\s+(?:for|in)\s+(\d+)\s*(s|sec|seconds?|m|min|minutes?)\b/i);
  if (nov) exit.noVolume = { minVolSol: Number(nov[1]), windowSec: Number(nov[2]) * (/^m/i.test(nov[3]) ? 60 : 1) };
  else if (nov2) exit.noVolume = { minVolSol: 0.1, windowSec: Number(nov2[1]) * (/^m/i.test(nov2[2]) ? 60 : 1) };
  r.exit = exit;
  r.mode = /\b(auto(matically)?|without asking|by itself|on its own|fully automated)\b/i.test(t) ? "auto" : "confirm";
  // v26: velocity, language, cashtags, pairs, clash handling, templates
  const vel = t.match(/(\d+)\s*likes?\s*(?:in|within)\s*(\d+)\s*(s|sec|seconds?|m|min|minutes?)\b/i);
  if (vel) { const w = Number(vel[2]) * (/^m/i.test(vel[3]) ? 60 : 1); r.trigger.velocity = { likes: Number(vel[1]), withinSec: w, waitSec: w }; }
  const lang = t.match(/\bonly\s+(english|spanish|japanese|korean|chinese|french|german|portuguese)\b/i);
  if (lang) r.trigger.languages = [{ english: "en", spanish: "es", japanese: "ja", korean: "ko", chinese: "zh", french: "fr", german: "de", portuguese: "pt" }[lang[1].toLowerCase() as "english"]];
  if (/\b(?:no|without)\s+(?:a\s+)?(?:contract|ca)\b/i.test(t)) r.trigger.contract = "forbid";
  if (/\b(?:no|without)\s+(?:a\s+)?cashtags?\b/i.test(t)) r.trigger.cashtag = "forbid";
  if (/\bvideos?\b/i.test(t) && !/\b(picture|photo|image|pic)s?\b/i.test(t)) r.trigger = { ...r.trigger, media: "video", requireImage: false };
  const pairId = pairFromText(t);
  const pairHit = pairId ? findPair(pairId) : undefined;
  const notes: string[] = [];
  if (pairHit && pairSelectable(pairHit)) r.pair = { quote: pairHit.id, fees: "creator", ...(pairHit.id !== "SOL" ? { creatorFeePct: CUSTOM_PAIR_FEE.min } : {}) };
  else if (pairHit) notes.push(pairHit.note ? `${pairHit.id} can't be used (${pairHit.note}); kept SOL` : `${pairHit.id} has no mint listed yet, so it can't be used; kept SOL`);
  else {
    // v27 G: a ticker named as the pair that isn't on pump.fun's supported list (USDT, mSOL…): say so, never guess a mint
    const named = t.match(/\bpair(?:ed)?\s+(?:it\s+|them\s+|the\s+coin\s+)?(?:with|to|against|on|in)\s+(\$?[A-Z][A-Za-z0-9]{1,9})\b/);
    if (named && (named[1].startsWith("$") || named[1] === named[1].toUpperCase())) notes.push(`${named[1].replace(/^\$/, "")} isn't on pump.fun's supported pairs list, so it can't be used; kept SOL`);
  }
  const fee = feeFromText(t);
  if (fee !== null && r.pair && r.pair.quote !== "SOL") r.pair = { ...r.pair, creatorFeePct: fee };
  else if (fee !== null) notes.push("On a SOL pair pump.fun sets the creator fee; the fee you named applies to custom pairs only");
  if (/\bcash\s?back\b/i.test(t)) r.pair = { ...(r.pair ?? { quote: "SOL" }), fees: "cashback" };
  else if (/\b(?:to|for)\s+(?:the\s+)?holders\b|\bholder\s+rewards?\b/i.test(t)) r.pair = { ...(r.pair ?? { quote: "SOL" }), fees: "holders" };
  const addrs = [...t.matchAll(/\b([1-9A-HJ-NP-Za-km-z]{32,44})(?::(\d{1,3}(?:\.\d+)?))?/g)];
  if (/\bsplit\b/i.test(t)) {
    if (addrs.length) {
      const even = +(100 / addrs.length).toFixed(4);
      const split = addrs.slice(0, 10).map((m, i, a) => ({ address: m[1], pct: m[2] ? Number(m[2]) : i === a.length - 1 ? +(100 - even * (a.length - 1)).toFixed(4) : even }));
      r.pair = { ...(r.pair ?? { quote: "SOL" }), fees: "split", split };
    } else notes.push("Fee split: add up to 10 wallet addresses in the panel (Pair & fees) or with --split");
  }
  if (/\brename\b.{0,30}\b(?:clash|taken|exists|already)\b|\bif\s+(?:the\s+)?ticker\s+is\s+taken\s+rename\b/i.test(t)) r.clash = { action: "rename", windowSec: 120 };
  else if (/\blaunch\s+anyway\b/i.test(t)) r.clash = { action: "launch", windowSec: 120 };
  else if (/\bskip\b.{0,30}\b(?:clash|clashes|taken|exists|already)\b/i.test(t)) r.clash = { action: "skip", windowSec: 120 };
  if (/\bconfirm\s+(?:first|before)|\bask\s+(?:me\s+)?first\b/i.test(t)) r.mode = "confirm";
  if (/\bask\s+(?:me\s+)?(?:for\s+)?(?:the\s+)?(?:name|ticker)|\blet\s+me\s+(?:name|pick\s+the\s+name)/i.test(t)) { r.mode = "confirm"; r.coin = { ...r.coin, naming: "ask" }; }
  const sty = t.match(/\b(short|literal|punny|pun)\s+names?\b/i);
  if (sty) r.coin = { ...r.coin, naming: r.coin.naming === "ask" ? "ask" : "model", style: normStyle(sty[1].toLowerCase() === "pun" ? "punny" : sty[1].toLowerCase()) };
  if (r.plan.devBuySol > r.limits.maxSolPerLaunch) r.limits = { ...r.limits, maxSolPerLaunch: r.plan.devBuySol, maxSolPerDay: Math.max(r.limits.maxSolPerDay, r.plan.devBuySol * 3) };
  const n = normalizeLaunchRule(r);
  return { draft: n, summary: [...describeLaunchRule(n), ...notes], errors: validateLaunchRule(n) };
}

/** v26: the Telegram confirm card's caption, under the post's picture: the coin as it will appear, then the plan. */
export function confirmCardText(p: PendingLaunch): string {
  const first = p.token.description.split("\n")[0].slice(0, 160);
  return [
    `Launch draft · @${p.handle}'s post`,
    ...(p.reason ? [p.reason] : []),
    "",
    ...(p.ask
      ? [`Name it: reply "Name $TICKER", or tap a suggestion${p.suggestions?.length ? ` (${p.suggestions.map((x) => `${x.name} $${x.symbol}`).join(" · ")})` : ""}`]
      : [`${p.token.name}  $${p.token.symbol}${p.quote && p.quote !== "SOL" ? `  ·  ${p.token.symbol}/${p.quote}` : ""}`, first]),
    "",
    `${p.devBuySol ? `${p.devBuySol} SOL dev buy` : "No dev buy"}${p.teamWallets ? ` · ${p.teamWallets} disclosed team wallets` : ""}`,
    ...p.exitSummary.slice(0, 3),
    ...(p.clashNote ? [`Clash check: ${p.clashNote}`] : []),
    `Expires in ${Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000))} s`,
  ].join("\n");
}

/** Text for a confirm draft (Telegram / panel). */
export function pendingText(p: PendingLaunch): string {
  return [
    `Launch draft from @${p.handle}'s post (expires in ${Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000))}s)`,
    p.ask ? `Name it: /launch ${p.id} Name $TICKER${p.suggestions?.length ? ` (suggested: ${p.suggestions.map((x) => `${x.name} $${x.symbol}`).join(", ")})` : ""}` : `${p.token.name} $${p.token.symbol}${p.quote && p.quote !== "SOL" ? ` · ${p.token.symbol}/${p.quote}` : ""} · ${p.devBuySol} SOL dev buy${p.teamWallets ? ` · ${p.teamWallets} disclosed team wallets` : ""}`,
    ...(p.clashNote ? [`Clash check: ${p.clashNote}`] : []),
    ...p.exitSummary,
    `Post: ${p.postUrl}`,
    `Reply /launch ${p.id} or /skip ${p.id}`,
  ].join("\n");
}

// ---------- v26: chat questions about launch-on-post ----------

/** "backtest my launch rule", "launch rule stats", "race report for $FERRY", "which stock pairs can I use" */
export interface LaunchInfoChat { kind: "launch-info"; ask: "backtest" | "stats" | "race" | "pairs"; symbol?: string; query?: string; summary: string[] }

export function parseLaunchInfoRequest(text: string): LaunchInfoChat | null {
  const t = text.trim();
  if (t.length > 160) return null;
  const sym = /\$([A-Za-z][A-Za-z0-9]{1,9})\b/.exec(t)?.[1]?.toUpperCase();
  if (/\bback-?test\b/i.test(t)) return { kind: "launch-info", ask: "backtest", summary: ["Backtest: replay the last 7 days of posts through your launch-on-post rule. Nothing is spent."] };
  if (/\brace\s+report\b|\bwho\s+launched\s+first\b|\bwas\s+i\s+first\b|\brace\s+(?:for|of)\s+\$[A-Za-z]/i.test(t)) return { kind: "launch-info", ask: "race", symbol: sym, summary: [sym ? `Race report for $${sym}` : "Race reports for your launches"] };
  if (/\b(?:launch[\s-]?(?:on[\s-]?post\s+)?rules?\s+stats|stats\s+(?:for|of)\s+(?:my\s+)?launch|how\s+(?:are|is)\s+my\s+launch\s+rules?\s+doing|how\s+did\s+my\s+launch(?:[\s-]on[\s-]post)?\s+rules?\s+do)\b/i.test(t)) return { kind: "launch-info", ask: "stats", summary: ["Launch-on-post stats per rule: launches, first-place rate, median post → landed, PnL, creator fees"] };
  const pm = t.match(/\b(?:which|what|list|show)\b.{0,30}?\b(stock|stablecoin|metal|crypto|pre-?ipo|token)?s?\s*(?:quote\s+)?pairs?\b|\bquote\s+pairs?\b|\bcustom\s+pairs?\b/i);
  if (pm) return { kind: "launch-info", ask: "pairs", query: pm[1]?.toLowerCase().replace("-", ""), summary: ["Quote pairs for pump.fun launches, by category and status"] };
  return null;
}
