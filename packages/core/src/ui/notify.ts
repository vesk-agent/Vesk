/**
 * v17 notifications: the kinds, their default toast / sound / desktop settings, Do Not Disturb, the notification
 * centre's inbox (normalised, capped, grouped by day) and the rules the toast stack follows (priority, dedupe, burst
 * grouping, a rate limit). Pure, so it's tested here and shared with the panel and the edge function.
 */

export type NotifyKind = "trade" | "tracker" | "copy" | "launch" | "order" | "exit" | "callout" | "access" | "connection" | "error" | "info";
export const NOTIFY_KINDS: NotifyKind[] = ["trade", "tracker", "copy", "launch", "order", "exit", "callout", "access", "connection", "error", "info"];
export const NOTIFY_LABEL: Record<NotifyKind, [string, string]> = {
  trade: ["Trades", "Your buys and sells: sending, landed or failed"],
  tracker: ["Wallet tracker", "Trades by wallets you track"],
  copy: ["Copy trading", "Copied, waiting for you, or skipped (skips go to the centre only)"],
  launch: ["Launches", "A coin you launched landed, or the agent took it over"],
  order: ["Orders", "Placed, filled or cancelled"],
  exit: ["Exits", "Take-profit, stop-loss, trailing and timed sells"],
  callout: ["Callouts", "A holder posted a callout on a coin you hold"],
  access: ["Holder access", "Access granted or removed"],
  connection: ["Connection", "Your agent or the network went away, or came back"],
  error: ["Errors", "Something didn't work. These stay until you dismiss them"],
  info: ["Other", "Confirmations like \"Saved\" and Undo"],
};

/** Generated sounds (Web Audio, no files). */
export type NotifySound = "off" | "soft" | "pop" | "tick" | "chime" | "bell";
export const NOTIFY_SOUNDS: NotifySound[] = ["off", "soft", "pop", "tick", "chime", "bell"];
export interface KindPrefs { toast: boolean; sound: NotifySound; desktop: boolean }
export interface NotifySettings {
  /** Do Not Disturb: no sounds, no desktop notifications, and only errors and failed trades pop up. Everything still lands in the centre. */
  dnd: boolean;
  kinds: Record<NotifyKind, KindPrefs>;
}

const DEFAULT_KINDS: Record<NotifyKind, KindPrefs> = {
  trade: { toast: true, sound: "soft", desktop: false },
  tracker: { toast: true, sound: "tick", desktop: false },
  copy: { toast: true, sound: "soft", desktop: false },
  launch: { toast: true, sound: "chime", desktop: true },
  order: { toast: true, sound: "soft", desktop: false },
  exit: { toast: true, sound: "chime", desktop: true },
  callout: { toast: true, sound: "off", desktop: false },
  access: { toast: true, sound: "off", desktop: true },
  connection: { toast: true, sound: "off", desktop: true },
  error: { toast: true, sound: "off", desktop: false },
  info: { toast: true, sound: "off", desktop: false },
};
export const defaultNotifySettings = (): NotifySettings => ({ dnd: false, kinds: structuredClone(DEFAULT_KINDS) });

const obj = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
export function normalizeNotifySettings(x: unknown): NotifySettings {
  const o = obj(x), k = obj(o.kinds);
  const kinds = {} as Record<NotifyKind, KindPrefs>;
  for (const kind of NOTIFY_KINDS) {
    const d = DEFAULT_KINDS[kind], v = obj(k[kind]);
    kinds[kind] = {
      toast: typeof v.toast === "boolean" ? v.toast : d.toast,
      sound: NOTIFY_SOUNDS.includes(v.sound as NotifySound) ? (v.sound as NotifySound) : d.sound,
      desktop: typeof v.desktop === "boolean" ? v.desktop : d.desktop,
    };
  }
  return { dnd: o.dnd === true, kinds };
}

/** What one notification does, given the settings: pop up, play a sound, show a desktop notification. */
export function routeNotification(s: NotifySettings, kind: NotifyKind, critical: boolean): { toast: boolean; sound: NotifySound; desktop: boolean } {
  const p = s.kinds[kind] ?? DEFAULT_KINDS.info;
  if (s.dnd) return { toast: critical, sound: "off", desktop: false };
  // errors and failed trades always pop up: you can't switch off being told something didn't work
  return { toast: p.toast || critical, sound: p.sound, desktop: p.desktop };
}

// ---------------------------------------------------------------- the centre's inbox

export interface InboxItem {
  id: string; at: number; kind: NotifyKind; title: string; detail?: string;
  /** A coin, a wallet, or a panel path to open from the item. */
  mint?: string; wallet?: string; href?: string;
  err?: boolean; read: boolean;
  /** A burst merged into one item. */
  n?: number;
}
export const INBOX_MAX = 200;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Keep only well-formed items, newest first, at most INBOX_MAX; links stay inside the panel. */
export function normalizeInbox(x: unknown): InboxItem[] {
  const out: InboxItem[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(x) ? x : []) {
    const o = obj(raw);
    const id = str(o.id, 64), title = str(o.title, 160), at = Number(o.at);
    if (!id || !title || !Number.isFinite(at) || seen.has(id)) continue;
    seen.add(id);
    const kind = NOTIFY_KINDS.includes(o.kind as NotifyKind) ? (o.kind as NotifyKind) : "info";
    const href = str(o.href, 200);
    out.push({
      id, at, kind, title, detail: str(o.detail, 240),
      mint: typeof o.mint === "string" && B58.test(o.mint) ? o.mint : undefined,
      wallet: typeof o.wallet === "string" && B58.test(o.wallet) ? o.wallet : undefined,
      href: href && /^\/(app|docs)(\/|$|\?)/.test(href) ? href : undefined,
      err: o.err === true || undefined, read: o.read === true,
      n: Number.isInteger(o.n) && (o.n as number) > 1 ? Math.min(999, o.n as number) : undefined,
    });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, INBOX_MAX);
}

/** Add or replace one item (same id), newest first, capped. */
export function upsertInbox(list: InboxItem[], item: InboxItem): InboxItem[] {
  return [item, ...list.filter((x) => x.id !== item.id)].sort((a, b) => b.at - a.at).slice(0, INBOX_MAX);
}
export const unreadCount = (list: InboxItem[]) => list.filter((x) => !x.read).length;
export const markAllRead = (list: InboxItem[]) => list.map((x) => (x.read ? x : { ...x, read: true }));

/** Today and Earlier, by the local day that `todayStart` (ms, local midnight) begins. */
export function inboxSections(list: InboxItem[], todayStart: number): { today: InboxItem[]; earlier: InboxItem[] } {
  return { today: list.filter((x) => x.at >= todayStart), earlier: list.filter((x) => x.at < todayStart) };
}

/** Where an item goes when you click it in the centre. */
export function inboxLink(i: InboxItem): string | null {
  if (i.href) return i.href;
  if (i.mint) return `/app/coin/${i.mint}`;
  if (i.kind === "tracker" && i.wallet) return "/app/tracker?tab=wallets";
  if (i.kind === "copy") return "/app/copy";
  if (i.kind === "access") return "/app/access";
  if (i.kind === "connection") return "/app/connections";
  if (i.kind === "order" || i.kind === "exit") return "/app/positions";
  return null;
}

// ---------------------------------------------------------------- stack rules

/**
 * Rate limit: at most `max` new toasts per `windowMs`. Past that, new ones go to the centre only and one summary
 * toast counts them, so a flood never covers the screen. Returns the timestamps to keep.
 */
export function rateAllow(times: number[], now: number, max = 6, windowMs = 4000): { allow: boolean; times: number[] } {
  const recent = times.filter((t) => now - t < windowMs);
  if (recent.length >= max) return { allow: false, times: recent };
  return { allow: true, times: [...recent, now] };
}

/** The line that sums up a burst: "3 buys from Night desk", "4 copies", "5 alerts". */
export function groupSummary(kind: NotifyKind, n: number, who?: string, side?: "buy" | "sell" | "mixed"): string {
  const noun = side === "buy" ? (n === 1 ? "buy" : "buys") : side === "sell" ? (n === 1 ? "sell" : "sells") : n === 1 ? "trade" : "trades";
  if (kind === "tracker") return `${n} ${noun}${who ? ` from ${who}` : ""}`;
  if (kind === "copy") return `${n} ${n === 1 ? "copy" : "copies"}${who ? ` of ${who}` : ""}`;
  if (kind === "trade") return `${n} ${noun}`;
  if (kind === "exit") return `${n} exits`;
  if (kind === "order") return `${n} orders`;
  return `${n} alerts`;
}

/** Errors and failed trades stay until dismissed; everything else leaves on its own. */
export const isSticky = (kind: NotifyKind, err: boolean) => err || kind === "error";
