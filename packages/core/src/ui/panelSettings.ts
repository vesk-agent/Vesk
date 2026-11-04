/**
 * Panel settings (the Settings center): layout, display, row elements, metric colours, hover previews, quick-buy
 * behaviour and styling, PnL and chart preferences, tracker alerts, appearance (themes) and the performance profile.
 * Pure and shared, so it's tested here and the panel only renders it. Saved per account (edge function
 * `panel-settings`) and in the browser for instant reloads. Trading presets and hotkeys live in trade/settings.ts,
 * the blacklist in watch/blacklist.ts.
 */
import { defaultNotifySettings, normalizeNotifySettings, type NotifySettings } from "./notify.js";
import { defaultInstantTrade, normalizeInstantTrade, type InstantTradeSettings } from "./instantTrade.js";
import type { PerfProfile } from "../watch/batcher.js";
import { defaultRowElements, ROW_ELEMENTS } from "../watch/facts.js";
import { BRAND } from "../brand.js";

export type ColumnId = "new" | "final" | "migrated";
export const COLUMN_IDS: ColumnId[] = ["new", "final", "migrated"];
export const COLUMN_TITLE: Record<ColumnId, string> = { new: "New pairs", final: "Final stretch", migrated: "Migrated" };

export type ThemeId = "dark" | "night" | "dusk" | "astro" | "neo" | "crimson" | "blue" | "nord" | "teal" | "orange" | "custom";
export const THEME_IDS: ThemeId[] = ["dark", "night", "dusk", "astro", "neo", "crimson", "blue", "nord", "teal", "orange", "custom"];
export const THEME_NAME: Record<ThemeId, string> = { dark: `Dark (${BRAND.name})`, night: "Night", dusk: "Dusk", astro: "Astro", neo: "Neo", crimson: "Crimson", blue: "Blue", nord: "Nord", teal: "Teal", orange: "Orange", custom: "Custom" };

/** Every colour the custom editor exposes. Hex #rrggbb. */
export interface ThemeTokens {
  bg1: string; bg2: string; bg3: string; stroke1: string; stroke2: string; subtle: string; chartBg: string; canvas: string;
  text1: string; text2: string; text3: string;
  inc: string; incHover: string; dec: string; decHover: string;
  candleUpBody: string; candleUpBorder: string; candleUpWick: string; candleDownBody: string; candleDownBorder: string; candleDownWick: string;
  green: string; yellow: string; orange: string; red: string; blue: string;
}
export const THEME_TOKEN_LABEL: Record<keyof ThemeTokens, string> = {
  bg1: "Primary background", bg2: "Secondary background", bg3: "Tertiary background", stroke1: "Primary stroke", stroke2: "Secondary stroke", subtle: "Subtle background",
  chartBg: "Chart background", canvas: "Canvas", text1: "Primary text", text2: "Secondary text", text3: "Tertiary text",
  inc: "Increase", incHover: "Increase (hover)", dec: "Decrease", decHover: "Decrease (hover)",
  candleUpBody: "Candle up body", candleUpBorder: "Candle up border", candleUpWick: "Candle up wick", candleDownBody: "Candle down body", candleDownBorder: "Candle down border", candleDownWick: "Candle down wick",
  green: "Primary green", yellow: "Primary yellow", orange: "Primary orange", red: "Primary red", blue: "Primary blue (accent)",
};

const T = (b: [string, string, string, string, string, string, string, string], t: [string, string, string], inc: string, dec: string, accent: string, extra: Partial<ThemeTokens> = {}): ThemeTokens => ({
  canvas: b[0], bg1: b[1], bg2: b[2], bg3: b[3], subtle: b[4], stroke1: b[5], stroke2: b[6], chartBg: b[7],
  text1: t[0], text2: t[1], text3: t[2], inc, incHover: inc, dec, decHover: dec,
  candleUpBody: inc, candleUpBorder: inc, candleUpWick: inc, candleDownBody: dec, candleDownBorder: dec, candleDownWick: dec,
  green: inc, yellow: "#f2c66f", orange: "#f5a65b", red: dec, blue: accent, ...extra,
});

/** Built-in themes. Text tokens pass WCAG AA (4.5:1) on every background in each theme (tested). */
export const THEMES: Record<Exclude<ThemeId, "custom">, ThemeTokens> = {
  // v27 (VESK-DESIGN-BIBLE.md §1): cool-neutral surfaces, one frame tone (bg1), the new green and red
  dark: T(["#08090b", "#0c0d10", "#111216", "#17191d", "#1d1f24", "#1b1c1f", "#242528", "#0c0d10"], ["#f3f4f6", "#b3b6be", "#868a94"], "#3ddc84", "#ff5d6c", "#8fe9ff"),
  night: T(["#000000", "#050505", "#0b0b0c", "#121214", "#18181b", "#1c1c1f", "#2a2a2e", "#060607"], ["#f2f2f3", "#acacb2", "#8c8c93"], "#5fd6a0", "#ff7380", "#a9c4ff"),
  dusk: T(["#0d0b12", "#121019", "#17141f", "#1e1a28", "#241f30", "#2a2436", "#3a3249", "#110e17"], ["#efeaf7", "#bdb3cf", "#9d93b0"], "#6fd6a8", "#ff7d8c", "#c4a7ff"),
  astro: T(["#070b16", "#0b1120", "#0f172a", "#152036", "#1a2640", "#1e2a44", "#2b3a5a", "#0a1020"], ["#e8eefc", "#adbad5", "#8f9dbb"], "#5fd3a2", "#ff7a88", "#7aa2ff"),
  neo: T(["#050806", "#080c09", "#0d120e", "#131a14", "#18221a", "#1b251d", "#283629", "#070a08"], ["#e9f5ec", "#a9bfae", "#8aa190"], "#7dffb3", "#ff7a7a", "#7dffb3"),
  crimson: T(["#0a0506", "#100809", "#160b0d", "#1e1013", "#251417", "#2a1619", "#3b2024", "#0d0607"], ["#f7ecee", "#cbb2b6", "#ab9195"], "#6fd6a6", "#ff6b81", "#ff6b81"),
  blue: T(["#04070d", "#070c16", "#0b1220", "#101a2c", "#142038", "#172440", "#22345a", "#060b14"], ["#eaf1ff", "#acbcd9", "#8d9fbe"], "#5ed4a3", "#ff7684", "#4da3ff"),
  nord: T(["#242933", "#2b303b", "#2e3440", "#353b48", "#3b4252", "#3b4252", "#4c566a", "#2a2f3a"], ["#eceff4", "#d8dee9", "#c0c8d6"], "#a3be8c", "#f09aa2", "#88c0d0"),
  teal: T(["#041010", "#061616", "#0a1d1d", "#0f2626", "#132e2e", "#163333", "#214545", "#051212"], ["#e6f7f6", "#a6c8c6", "#88aba9"], "#5ee0b0", "#ff7c86", "#4fd1c5"),
  orange: T(["#0c0804", "#120c06", "#181009", "#20160c", "#281b10", "#2c1f13", "#3d2b1b", "#0f0a05"], ["#fbf1e7", "#d1baa3", "#b19a83"], "#67d8a4", "#ff7a7a", "#ff9f43"),
};

export type MetricColorKey = "devPct" | "top10Pct" | "snipersPct" | "insidersPct" | "bundledPct" | "holders" | "taxPct";
export const METRIC_COLOR_LABEL: Record<MetricColorKey, string> = { devPct: "Dev holding %", top10Pct: "Top 10 %", snipersPct: "Snipers %", insidersPct: "Insiders %", bundledPct: "Bundlers %", holders: "Holders", taxPct: "Tax %" };
/** good: at or past this is good; bad: at or past this is bad; in between is neutral. `dir: "low"` = lower is better. */
export interface MetricRule { good: number; bad: number; dir: "low" | "high" }
export type Tone = "good" | "neutral" | "bad";

export type QbSize = "s" | "m" | "l" | "xl" | "ultra";
/** Quick-buy sizes shown as tiles in Settings (Small / Large / Mega / Ultra). "m" stays valid for older saves. */
export const QB_SIZE_LABEL: Record<QbSize, string> = { s: "Small", m: "Medium", l: "Large", xl: "Mega", ultra: "Ultra" };

/** Parts of the X post hover card you can show or hide (Settings → Hover previews → X card elements). */
export type XCardEl = "avatar" | "verified" | "renames" | "blacklist" | "xLogo" | "age" | "joined" | "followers" | "pinned" | "reply" | "quoted" | "media" | "timestamp" | "bookmarks" | "views" | "likes" | "reposts" | "replies" | "launch" | "readMore";
export const X_CARD_GROUPS: Array<{ title: string; els: Array<[XCardEl, string]> }> = [
  { title: "Card header", els: [["avatar", "Profile picture"], ["verified", "Verified badge"], ["renames", "X renames"], ["blacklist", "Blacklist button"], ["xLogo", "X logo"], ["age", "Post age"]] },
  { title: "Account", els: [["joined", "Joined date"], ["followers", "Followers"]] },
  { title: "Context", els: [["pinned", "Pinned label"], ["reply", "Reply context"], ["quoted", "Quoted post"]] },
  { title: "Post", els: [["media", "Media"], ["timestamp", "Timestamp"]] },
  { title: "Stats", els: [["bookmarks", "Bookmarks"], ["views", "Views"], ["likes", "Likes"], ["reposts", "Reposts"], ["replies", "Replies"]] },
  { title: "Actions", els: [["launch", "Launch button"], ["readMore", "Read more on X"]] },
];
export const X_CARD_ELS: XCardEl[] = X_CARD_GROUPS.flatMap((g) => g.els.map(([k]) => k));
export type QbStyle = "gray" | "glow" | "border" | "ultra" | "wide-ultra";
export type SoundId = "off" | "chime" | "tick" | "bell";
export type AlertKind = "wallet" | "callout" | "social" | "migration" | "live";

export interface PanelSettings {
  version: 1;
  layout: { order: ColumnId[]; hidden: ColumnId[]; view: "list" | "grid"; walletSwitcher: "left" | "right"; headerSync: boolean; syncAmount: number; search: boolean };
  display: {
    metricSize: "s" | "m" | "l"; spacing: "compact" | "normal" | "comfy"; tableDensity: "compact" | "normal";
    imageSize: 28 | 36 | 44 | 56; imageShape: "square" | "rounded" | "circle"; progress: "ring" | "bar" | "none"; volume: "right" | "strip";
    roundedMcap: boolean; bondingOnHover: boolean; tickerFirst: boolean; copyMark: boolean; showHidden: boolean; showMigrated: boolean; showPreMigrated: boolean;
    /** Merged: the columns form one table. Spaced: each column is its own panel. */
    spacedTables: "merged" | "spaced";
    /** Coins you hid on New pairs / Final stretch show again once they migrate. */
    unhideOnMigrated: boolean;
  };
  row: Record<string, boolean>;
  colors: { metrics: Record<MetricColorKey, MetricRule>; good: string; neutral: string; bad: string; trackedDev: string; rowBorder: string; hover: string };
  hover: { xPost: boolean; image: boolean; chart: boolean; xCard: Record<XCardEl, boolean> };
  quickBuy: { onBuy: "nothing" | "open" | "new-tab"; inHeader: boolean; sellInRows: boolean };
  /** grey: quiet grey buttons instead of the accent. ultraGlow / ultraBordered / ultraWider apply to the Ultra size. `style` is kept for older saves. */
  qb: { size: QbSize; style: QbStyle; grey: boolean; ultraGlow: boolean; ultraBordered: boolean; ultraWider: boolean; font: "system" | "mono" | "custom"; customFont: string; text: string; glow: "off" | "soft" | "strong"; glowColor: string; gradient: boolean; from: string; to: string; holdings: boolean };
  trading: {
    pnl: { unit: "sol" | "usd"; mode: "pct" | "abs"; includeFees: boolean };
    chart: { interval: "1m" | "5m" | "15m" | "1h"; myTrades: boolean; devTrades: boolean; migrationLine: boolean; axis: "price" | "mcap" };
    groups: Array<{ id: string; name: string; wallets: string[] }>;
  };
  tracker: { toasts: Record<AlertKind, boolean>; sounds: Record<AlertKind, SoundId>; walletMinSol: number; walletSides: "both" | "buy" | "sell" };
  appearance: { theme: ThemeId; custom: ThemeTokens; font: string; myBuys: boolean; mySells: boolean };
  perf: PerfProfile;
  /** v12.2: the floating Instant Trade panel (chips, preset, confirm, lines shown, size, position). */
  instantTrade: InstantTradeSettings;
  /** v15: where notifications appear, slide to confirm above your confirm size, rolling digits. */
  feel: FeelSettings;
  /** v17: per-kind toast / sound / desktop notifications, and Do Not Disturb. */
  notify: NotifySettings;
}

/** v20: four corners-ish: top centre (default), top right, bottom right, bottom left. */
export type ToastPlacement = "top" | "top-right" | "bottom-right" | "bottom-left";
export const TOAST_PLACEMENTS: readonly ToastPlacement[] = ["top", "top-right", "bottom-right", "bottom-left"];
/**
 * v19: "list" shows every toast in full, one under the other (default); "stacked" is the v17 deck (two peek behind).
 * v20: "compact" is the list with one line per card; "minimal" is no card at all, the icon and the text.
 */
export type ToastStack = "list" | "stacked" | "compact" | "minimal";
export const TOAST_STACKS: readonly ToastStack[] = ["list", "stacked", "compact", "minimal"];
/** The kinds a notification accent can be set for (the same kinds as Settings → Notifications). */
export const TOAST_ACCENT_KINDS = ["trade", "tracker", "copy", "launch", "order", "exit", "callout", "access", "connection", "error", "info"] as const;
export type ToastAccentKind = (typeof TOAST_ACCENT_KINDS)[number];
/**
 * v20: how a notification looks (Settings → Notifications → Appearance). None of it changes how long a toast stays
 * except `duration`, which scales every toast's clock (the v18.1 model is unchanged: one clock per toast).
 */
export interface ToastLook {
  size: "s" | "m" | "l";
  /** glass: translucent with a blur; solid: the panel's card colour (default); tinted: the card washed with the accent. */
  bg: "glass" | "solid" | "tinted";
  /** A colour per kind for the icon, the time bar and the tint. Missing = the theme's default for that kind. */
  accents: Partial<Record<ToastAccentKind, string>>;
  /** How a card comes in and goes: slide (default), fade, scale. */
  motion: "slide" | "fade" | "scale";
  speed: "slow" | "normal" | "fast";
  /** Multiplies every toast's time on screen (0.5 to 3). */
  duration: number;
  /** Cards on screen at once (1 to 6); the rest wait behind "+N more". */
  maxVisible: number;
  /** The thin time-left bar. Off hides it; the clock still runs. */
  progress: boolean;
  /** The coin's or wallet's picture; off shows the kind icon instead. */
  avatars: boolean;
}
export const defaultToastLook = (): ToastLook => ({ size: "m", bg: "solid", accents: {}, motion: "slide", speed: "normal", duration: 1, maxVisible: 3, progress: true, avatars: true });
/** Motion speed as a factor on every transition (and on the exit's removal fallback). */
export const TOAST_SPEED: Record<ToastLook["speed"], number> = { slow: 1.5, normal: 1, fast: 0.6 };
export interface FeelSettings {
  /** Where the stack sits. */
  toasts: ToastPlacement;
  /** How several toasts sit together (v19, default list). */
  toastStack: ToastStack;
  /** v20: size, background, accents, motion, duration, max visible, bar and pictures. */
  toastLook: ToastLook;
  /** Above your confirm size, trades ask for a slide instead of a click. */
  slideConfirm: boolean;
  /** Values that change roll their digits (off under reduced motion and the Low profile anyway). */
  rollingDigits: boolean;
}
export const defaultFeel = (): FeelSettings => ({ toasts: "top", toastStack: "list", toastLook: defaultToastLook(), slideConfirm: false, rollingDigits: true });

/** Fill a look from a save: unknown values fall back to the default, numbers are clamped, accents must be #rrggbb. */
export function normalizeToastLook(x: unknown): ToastLook {
  const d = defaultToastLook(), o = obj(x), A = obj(o.accents);
  const accents: ToastLook["accents"] = {};
  for (const k of TOAST_ACCENT_KINDS) if (typeof A[k] === "string" && HEX.test(A[k] as string)) accents[k] = (A[k] as string).toLowerCase();
  return {
    size: pick(o.size, ["s", "m", "l"] as const, d.size), bg: pick(o.bg, ["glass", "solid", "tinted"] as const, d.bg), accents,
    motion: pick(o.motion, ["slide", "fade", "scale"] as const, d.motion), speed: pick(o.speed, ["slow", "normal", "fast"] as const, d.speed),
    duration: Math.round(num(o.duration, d.duration, 0.5, 3) * 100) / 100, maxVisible: Math.round(num(o.maxVisible, d.maxVisible, 1, 6)),
    progress: bool(o.progress, d.progress), avatars: bool(o.avatars, d.avatars),
  };
}

export const DEFAULT_METRIC_RULES: Record<MetricColorKey, MetricRule> = {
  devPct: { good: 5, bad: 10, dir: "low" }, top10Pct: { good: 20, bad: 30, dir: "low" }, snipersPct: { good: 5, bad: 15, dir: "low" },
  insidersPct: { good: 5, bad: 15, dir: "low" }, bundledPct: { good: 5, bad: 15, dir: "low" }, holders: { good: 50, bad: 10, dir: "high" }, taxPct: { good: 0, bad: 1, dir: "low" },
};

export function defaultPanelSettings(): PanelSettings {
  return {
    version: 1,
    layout: { order: ["new", "final", "migrated"], hidden: [], view: "list", walletSwitcher: "right", headerSync: false, syncAmount: 0.1, search: true },
    display: { metricSize: "m", spacing: "normal", tableDensity: "normal", imageSize: 36, imageShape: "square", progress: "ring", volume: "right", roundedMcap: true, bondingOnHover: true, tickerFirst: true, copyMark: true, showHidden: false, showMigrated: true, showPreMigrated: true, spacedTables: "merged", unhideOnMigrated: false },
    row: defaultRowElements(),
    // v27: values are near-white (bible §1.3): a neutral metric in --t1, a good one a step quieter (--t2), a bad one amber
    colors: { metrics: structuredCloneSafe(DEFAULT_METRIC_RULES), good: "#b3b6be", neutral: "#f3f4f6", bad: "#f2c66f", trackedDev: "#8fe9ff", rowBorder: "#26272e", hover: "#17191d" },
    hover: { xPost: true, image: true, chart: true, xCard: Object.fromEntries(X_CARD_ELS.map((k) => [k, k !== "renames"])) as Record<XCardEl, boolean> },
    quickBuy: { onBuy: "nothing", inHeader: true, sellInRows: false },
    qb: { size: "l", style: "gray", grey: true, ultraGlow: true, ultraBordered: false, ultraWider: false, font: "mono", customFont: "", text: "#edf0f4", glow: "off", glowColor: "#8fe9ff", gradient: false, from: "#1c2a33", to: "#0f171c", holdings: false },
    trading: { pnl: { unit: "sol", mode: "abs", includeFees: true }, chart: { interval: "5m", myTrades: true, devTrades: true, migrationLine: true, axis: "mcap" }, groups: [] },
    tracker: { toasts: { wallet: true, callout: true, social: false, migration: true, live: false }, sounds: { wallet: "tick", callout: "chime", social: "off", migration: "bell", live: "off" }, walletMinSol: 0, walletSides: "both" },
    appearance: { theme: "dark", custom: { ...THEMES.dark }, font: "", myBuys: true, mySells: true },
    perf: "auto",
    instantTrade: defaultInstantTrade(),
    feel: defaultFeel(),
    notify: defaultNotifySettings(),
  };
}

function structuredCloneSafe<T>(x: T): T { return JSON.parse(JSON.stringify(x)) as T; }

const HEX = /^#[0-9a-f]{6}$/i;
const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => ((allowed as readonly unknown[]).includes(v) ? (v as T) : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const num = (v: unknown, d: number, min = -Infinity, max = Infinity) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d);
const hex = (v: unknown, d: string) => (typeof v === "string" && HEX.test(v) ? v.toLowerCase() : d);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Fill missing fields with defaults and drop anything invalid. Never throws. */
export function normalizePanelSettings(x: unknown): PanelSettings {
  const d = defaultPanelSettings();
  const o = obj(x);
  const L = obj(o.layout), D = obj(o.display), C = obj(o.colors), H = obj(o.hover), Q = obj(o.quickBuy), B = obj(o.qb), TR = obj(o.trading), TK = obj(o.tracker), A = obj(o.appearance);
  const order = Array.isArray(L.order) ? (L.order as unknown[]).filter((c): c is ColumnId => COLUMN_IDS.includes(c as ColumnId)) : [];
  const fullOrder = [...new Set([...order, ...COLUMN_IDS])];
  const hidden = Array.isArray(L.hidden) ? [...new Set((L.hidden as unknown[]).filter((c): c is ColumnId => COLUMN_IDS.includes(c as ColumnId)))] : [];
  const rowIn = obj(o.row);
  const row = Object.fromEntries(ROW_ELEMENTS.map((e) => [e.id, e.avail === "unavailable" ? false : bool(rowIn[e.id], d.row[e.id])]));
  const MC = obj(C.metrics);
  const metrics = Object.fromEntries((Object.keys(DEFAULT_METRIC_RULES) as MetricColorKey[]).map((k) => {
    const r = obj(MC[k]); const dr = DEFAULT_METRIC_RULES[k];
    return [k, { good: num(r.good, dr.good, 0, 1e9), bad: num(r.bad, dr.bad, 0, 1e9), dir: pick(r.dir, ["low", "high"] as const, dr.dir) }];
  })) as Record<MetricColorKey, MetricRule>;
  const PN = obj(TR.pnl), CH = obj(TR.chart);
  const groups = Array.isArray(TR.groups) ? (TR.groups as unknown[]).map(obj).filter((g) => typeof g.name === "string" && Array.isArray(g.wallets)).slice(0, 20)
    .map((g, i) => ({ id: typeof g.id === "string" ? g.id : `g${i + 1}`, name: String(g.name).slice(0, 30), wallets: (g.wallets as unknown[]).filter((w): w is string => typeof w === "string").slice(0, 50) })) : [];
  const kinds: AlertKind[] = ["wallet", "callout", "social", "migration", "live"];
  const TT = obj(TK.toasts), TS = obj(TK.sounds);
  const CU = obj(A.custom);
  const custom = Object.fromEntries((Object.keys(THEMES.dark) as Array<keyof ThemeTokens>).map((k) => [k, hex(CU[k], d.appearance.custom[k])])) as unknown as ThemeTokens;
  return {
    version: 1,
    layout: { order: fullOrder, hidden: hidden.length >= 3 ? [] : hidden, view: pick(L.view, ["list", "grid"] as const, d.layout.view), walletSwitcher: pick(L.walletSwitcher, ["left", "right"] as const, d.layout.walletSwitcher), headerSync: bool(L.headerSync, d.layout.headerSync), syncAmount: num(L.syncAmount, d.layout.syncAmount, 0, 100), search: bool(L.search, d.layout.search) },
    display: {
      metricSize: pick(D.metricSize, ["s", "m", "l"] as const, d.display.metricSize), spacing: pick(D.spacing, ["compact", "normal", "comfy"] as const, d.display.spacing), tableDensity: pick(D.tableDensity, ["compact", "normal"] as const, d.display.tableDensity),
      imageSize: pick(D.imageSize as never, [28, 36, 44, 56] as never[], d.display.imageSize as never), imageShape: pick(D.imageShape, ["square", "rounded", "circle"] as const, d.display.imageShape), progress: pick(D.progress, ["ring", "bar", "none"] as const, d.display.progress),
      volume: pick(D.volume, ["right", "strip"] as const, d.display.volume), roundedMcap: bool(D.roundedMcap, true), bondingOnHover: bool(D.bondingOnHover, true), tickerFirst: bool(D.tickerFirst, true), copyMark: bool(D.copyMark, true),
      showHidden: bool(D.showHidden, false), showMigrated: bool(D.showMigrated, true), showPreMigrated: bool(D.showPreMigrated, true),
      spacedTables: pick(D.spacedTables, ["merged", "spaced"] as const, d.display.spacedTables), unhideOnMigrated: bool(D.unhideOnMigrated, false),
    },
    row,
    colors: { metrics, good: hex(C.good, d.colors.good), neutral: hex(C.neutral, d.colors.neutral), bad: hex(C.bad, d.colors.bad), trackedDev: hex(C.trackedDev, d.colors.trackedDev), rowBorder: hex(C.rowBorder, d.colors.rowBorder), hover: hex(C.hover, d.colors.hover) },
    hover: { xPost: bool(H.xPost, true), image: bool(H.image, true), chart: bool(H.chart, true), xCard: Object.fromEntries(X_CARD_ELS.map((k) => [k, bool(obj(H.xCard)[k], d.hover.xCard[k])])) as Record<XCardEl, boolean> },
    quickBuy: { onBuy: pick(Q.onBuy, ["nothing", "open", "new-tab"] as const, "nothing"), inHeader: bool(Q.inHeader, true), sellInRows: bool(Q.sellInRows, false) },
    qb: {
      size: pick(B.size, ["s", "m", "l", "xl", "ultra"] as const, d.qb.size), style: pick(B.style, ["gray", "glow", "border", "ultra", "wide-ultra"] as const, d.qb.style),
      // older saves have only `style`: grey unless they picked a coloured style; "wide-ultra" meant wider
      grey: bool(B.grey, B.style === undefined ? d.qb.grey : B.style === "gray"), ultraGlow: bool(B.ultraGlow, B.style === undefined ? d.qb.ultraGlow : B.style === "glow" || B.style === "ultra" || B.style === "wide-ultra"),
      ultraBordered: bool(B.ultraBordered, d.qb.ultraBordered), ultraWider: bool(B.ultraWider, B.style === "wide-ultra"),
      font: pick(B.font, ["system", "mono", "custom"] as const, d.qb.font), customFont: typeof B.customFont === "string" ? B.customFont.replace(/[^\w\s-]/g, "").slice(0, 40) : "", text: hex(B.text, d.qb.text),
      glow: pick(B.glow, ["off", "soft", "strong"] as const, "off"), glowColor: hex(B.glowColor, d.qb.glowColor), gradient: bool(B.gradient, false), from: hex(B.from, d.qb.from), to: hex(B.to, d.qb.to), holdings: bool(B.holdings, false),
    },
    trading: {
      pnl: { unit: pick(PN.unit, ["sol", "usd"] as const, "sol"), mode: pick(PN.mode, ["pct", "abs"] as const, "abs"), includeFees: bool(PN.includeFees, true) },
      chart: { interval: pick(CH.interval, ["1m", "5m", "15m", "1h"] as const, "5m"), myTrades: bool(CH.myTrades, true), devTrades: bool(CH.devTrades, true), migrationLine: bool(CH.migrationLine, true), axis: pick(CH.axis, ["price", "mcap"] as const, "mcap") },
      groups,
    },
    tracker: {
      toasts: Object.fromEntries(kinds.map((k) => [k, bool(TT[k], d.tracker.toasts[k])])) as Record<AlertKind, boolean>,
      sounds: Object.fromEntries(kinds.map((k) => [k, pick(TS[k], ["off", "chime", "tick", "bell"] as const, d.tracker.sounds[k])])) as Record<AlertKind, SoundId>,
      walletMinSol: num(TK.walletMinSol, 0, 0, 1000), walletSides: pick(TK.walletSides, ["both", "buy", "sell"] as const, "both"),
    },
    appearance: { theme: pick(A.theme, THEME_IDS, "dark"), custom, font: typeof A.font === "string" ? A.font.replace(/[^\w\s-]/g, "").slice(0, 40) : "", myBuys: bool(A.myBuys, true), mySells: bool(A.mySells, true) },
    perf: pick(o.perf, ["low", "auto", "full"] as const, "auto"),
    instantTrade: normalizeInstantTrade(o.instantTrade),
    feel: { toasts: pick(obj(o.feel).toasts, TOAST_PLACEMENTS, "top"), toastStack: pick(obj(o.feel).toastStack, TOAST_STACKS, "list"), toastLook: normalizeToastLook(obj(o.feel).toastLook), slideConfirm: bool(obj(o.feel).slideConfirm, false), rollingDigits: bool(obj(o.feel).rollingDigits, true) },
    notify: normalizeNotifySettings(o.notify),
  };
}

// ---------------------------------------------------------------- layout

/** Move a column to a new index (drag and drop). Returns a new order; unknown ids are ignored. */
export function moveColumn(order: ColumnId[], id: ColumnId, to: number): ColumnId[] {
  const from = order.indexOf(id);
  if (from < 0) return order;
  const next = order.filter((c) => c !== id);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, id);
  return next;
}

/** Columns to render, in your order, minus hidden ones and the migrated / pre-migrated display toggles. */
export function visibleColumns(s: PanelSettings): ColumnId[] {
  return s.layout.order.filter((c) => !s.layout.hidden.includes(c) && (c === "migrated" ? s.display.showMigrated : s.display.showPreMigrated));
}

// ---------------------------------------------------------------- formatting and colour

/** $63.7K (rounded) or $63,712 (exact). */
export function fmtMcapUsd(usd: number, rounded: boolean): string {
  if (!Number.isFinite(usd)) return "–";
  if (!rounded) return `$${Math.round(usd).toLocaleString("en-US")}`;
  return usd >= 1e9 ? `$${(usd / 1e9).toFixed(2)}B` : usd >= 1e6 ? `$${(usd / 1e6).toFixed(2)}M` : usd >= 1e3 ? `$${(usd / 1e3).toFixed(1)}K` : `$${Math.round(usd)}`;
}

/** good / neutral / bad for a metric value under your rule. null (unknown) is neutral. */
export function metricTone(rule: MetricRule, v: number | null | undefined): Tone {
  if (v === null || v === undefined || !Number.isFinite(v)) return "neutral";
  if (rule.dir === "low") return v <= rule.good ? "good" : v >= rule.bad ? "bad" : "neutral";
  return v >= rule.good ? "good" : v <= rule.bad ? "bad" : "neutral";
}

const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (h: string) => { const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(h.slice(i, i + 2), 16) / 255)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export function contrast(a: string, b: string): number {
  if (!HEX.test(a) || !HEX.test(b)) return 1;
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

/** AA problems in a theme: text on every background (4.5:1), PnL colours and the accent on cards (4.5:1 / 3:1). */
export function themeWarnings(t: ThemeTokens): Array<{ fg: keyof ThemeTokens; bg: keyof ThemeTokens; ratio: number; need: number }> {
  const out: Array<{ fg: keyof ThemeTokens; bg: keyof ThemeTokens; ratio: number; need: number }> = [];
  const bgs: Array<keyof ThemeTokens> = ["canvas", "bg1", "bg2", "bg3", "subtle"];
  const check = (fg: keyof ThemeTokens, bg: keyof ThemeTokens, need: number) => { const r = contrast(t[fg], t[bg]); if (r < need) out.push({ fg, bg, ratio: +r.toFixed(2), need }); };
  for (const fg of ["text1", "text2", "text3"] as const) for (const bg of bgs) check(fg, bg, 4.5);
  for (const fg of ["inc", "dec", "yellow"] as const) check(fg, "bg2", 4.5);
  check("blue", "bg2", 3);
  return out;
}

/** Theme tokens → CSS custom properties on the panel root. The default dark theme uses the stylesheet as is.
 *  v27: a theme redefines the v27 tokens (styles/v27.css); the older names (--p1, --ink, --rim, …) are aliases of
 *  them on `.app`, so every rule follows. bg1 is the one frame tone (sidebar, top bar, page, status bar). */
export function themeVars(s: PanelSettings["appearance"]): Record<string, string> {
  if (s.theme === "dark" && !s.font) return {};
  const t = s.theme === "custom" ? s.custom : s.theme === "dark" ? null : THEMES[s.theme];
  const v: Record<string, string> = {};
  if (t) Object.assign(v, {
    "--s0": t.bg1, "--s-in": t.canvas, "--s1": t.bg2, "--s2": t.bg3, "--s3": t.subtle, "--s-dlg": mix(t.bg1, t.bg2, 0.5),
    "--l1": t.stroke1, "--l2": t.stroke2, "--l3": t.stroke2,
    "--t1": t.text1, "--t2": t.text2, "--t3": t.text3, "--t4": mix(t.text3, t.bg2, 0.45),
    "--acc": t.blue, "--acc-ink": mix(t.blue, "#ffffff", 0.85), "--acc-wash": withAlpha(t.blue, 0.08), "--acc-line": withAlpha(t.blue, 0.38),
    "--btn": mix(t.blue, "#ffffff", 0.85),
    "--up": t.inc, "--up-h": t.incHover, "--down": t.dec, "--down-h": t.decHover, "--warn": t.yellow,
    "--up-wash": withAlpha(t.inc, 0.12), "--down-wash": withAlpha(t.dec, 0.12),
    "--chart-bg": t.chartBg, "--rim-a": withAlpha(t.blue, 0.12), "--rim-b": withAlpha(t.blue, 0.28),
    "--cc-up-body": t.candleUpBody, "--cc-up-border": t.candleUpBorder, "--cc-up-wick": t.candleUpWick,
    "--cc-dn-body": t.candleDownBody, "--cc-dn-border": t.candleDownBorder, "--cc-dn-wick": t.candleDownWick,
    "--green": t.green, "--orange": t.orange, "--red": t.red,
  });
  if (s.font) v["--sans"] = `"${s.font}", var(--sans-base, ui-sans-serif, system-ui, sans-serif)`;
  return v;
}

export function mix(a: string, b: string, w: number): string {
  if (!HEX.test(a) || !HEX.test(b)) return a;
  const ch = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
  return "#" + [1, 3, 5].map((i) => Math.round(ch(a, i) * (1 - w) + ch(b, i) * w).toString(16).padStart(2, "0")).join("");
}
export const withAlpha = (h: string, a: number) => (HEX.test(h) ? `rgba(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)}, ${a})` : h);

/** Quick-buy button styling → CSS custom properties and classes (Pulse sets these on its root). */
export function qbVars(q: PanelSettings["qb"]): { cls: string; vars: Record<string, string> } {
  const glow = q.glow === "off" ? "none" : `0 0 ${q.glow === "soft" ? 10 : 22}px -2px ${withAlpha(q.glowColor, q.glow === "soft" ? 0.45 : 0.8)}`;
  const font = q.font === "mono" ? "var(--mono)" : q.font === "system" ? "var(--sans)" : q.customFont ? `"${q.customFont}", var(--sans)` : "var(--sans)";
  return {
    cls: `qb-${q.size} ${q.grey ? "qbs-gray" : "qbs-accent"}${q.size === "ultra" ? `${q.ultraGlow ? " qb-uglow" : ""}${q.ultraBordered ? " qb-bordered" : ""}${q.ultraWider ? " qb-wider" : ""}` : ""}${q.gradient ? " qb-grad" : ""}`,
    vars: { "--qb-text": q.text, "--qb-glow": glow, "--qb-font": font, "--qb-from": q.from, "--qb-to": q.to, "--qb-glow-color": q.glowColor },
  };
}

// ---------------------------------------------------------------- import / export

export const exportPanelSettings = (s: PanelSettings) => JSON.stringify(s, null, 2);
export function importPanelSettings(text: string): PanelSettings {
  let j: unknown;
  try { j = JSON.parse(text); } catch { throw new Error("That isn't valid JSON."); }
  return normalizePanelSettings(j);
}
export const exportTheme = (t: ThemeTokens) => JSON.stringify({ kind: "vesk-theme", version: 1, tokens: t }, null, 2);
/** A theme export, or a bare token object. Missing tokens keep `base`'s value. */
export function importTheme(text: string, base: ThemeTokens = THEMES.dark): ThemeTokens {
  let j: unknown;
  try { j = JSON.parse(text); } catch { throw new Error("That isn't valid JSON."); }
  const o = obj(j);
  const src = obj(o.tokens ?? o);
  return Object.fromEntries((Object.keys(base) as Array<keyof ThemeTokens>).map((k) => [k, hex(src[k], base[k])])) as unknown as ThemeTokens;
}

/** Jito's public tip floor (bundles.jito.wtf/api/v1/bundles/tip_floor) → SOL at the 50th and 75th percentile. */
export function tipFloor(json: unknown): { p50: number; p75: number } | null {
  const r = Array.isArray(json) ? json[0] : json;
  const o = obj(r);
  const p50 = Number(o.landed_tips_50th_percentile), p75 = Number(o.landed_tips_75th_percentile);
  return Number.isFinite(p50) && Number.isFinite(p75) ? { p50, p75 } : null;
}
