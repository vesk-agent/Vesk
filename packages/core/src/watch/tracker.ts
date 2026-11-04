/**
 * The tracker: one 24/7 X watcher feeds the live feed, snipe rules and launch-on-post rules.
 * Pure logic here: groups, filters, CA detection per post and latency, so the agent, the hosted backend and
 * the panel agree on what a post is and which column it belongs in.
 */
import { detectMints } from "../ca.js";
import type { XPost } from "../types.js";

export interface TrackerGroup {
  id: string;
  name: string;
  handles: string[];
  sound: boolean;
  notify: boolean;
}

export interface TrackerFilter {
  keywords?: string[];
  hasMedia?: boolean;
  handles?: string[];
  groups?: string[];
  minFollowers?: number;
}

/** A post as the feed shows it. */
export interface FeedPost extends XPost {
  /** When the watcher received it (ms). */
  receivedAt: number;
  /** received - created, ms. The X source's delay plus the watcher's. */
  latencyMs: number;
  author?: { name?: string; followers?: number; avatarUrl?: string; verified?: boolean };
  quoted?: { handle: string; text: string; name?: string; avatarUrl?: string };
  replyTo?: { handle: string };
  ca?: { mint: string; source: "text" | "url" };
  groups: string[];
}

export function enrichPost(p: XPost & Partial<Pick<FeedPost, "author" | "quoted" | "replyTo">>, groups: TrackerGroup[], receivedAt = Date.now()): FeedPost {
  const created = Date.parse(p.createdAt);
  const m = detectMints(p.text, p.urls)[0];
  return {
    ...p, receivedAt, latencyMs: Number.isFinite(created) ? Math.max(0, receivedAt - created) : 0,
    ca: m ? { mint: m.mint, source: m.source } : undefined,
    groups: groups.filter((g) => g.handles.map((h) => h.toLowerCase()).includes(p.handle.toLowerCase())).map((g) => g.id),
  };
}

export function matchFilter(p: FeedPost, f: TrackerFilter): boolean {
  if (f.handles?.length && !f.handles.map((h) => h.toLowerCase()).includes(p.handle.toLowerCase())) return false;
  if (f.groups?.length && !p.groups.some((g) => f.groups!.includes(g))) return false;
  if (f.hasMedia && !p.media?.length) return false;
  if (f.keywords?.length && !f.keywords.some((k) => p.text.toLowerCase().includes(k.toLowerCase()))) return false;
  if (f.minFollowers !== undefined && (p.author?.followers ?? 0) < f.minFollowers) return false;
  return true;
}

export type FeedColumn = { id: string; title: string; filter: TrackerFilter; caOnly?: boolean };

/** Default columns: All, one per group, and posts with a contract address. */
export function columnsFor(groups: TrackerGroup[]): FeedColumn[] {
  return [
    { id: "all", title: "All", filter: {} },
    ...groups.map((g) => ({ id: `g:${g.id}`, title: g.name, filter: { groups: [g.id] } })),
    { id: "ca", title: "Mentions CA", filter: {}, caOnly: true },
  ];
}

export function inColumn(p: FeedPost, c: FeedColumn): boolean {
  return (!c.caOnly || !!p.ca) && matchFilter(p, c.filter);
}

/** Every watched handle: tracker groups + rule handles, deduped. */
export function trackedHandles(groups: TrackerGroup[], extra: string[] = []): string[] {
  return [...new Set([...groups.flatMap((g) => g.handles), ...extra].map((h) => h.replace(/^@/, "").toLowerCase()))].sort();
}

/** Honest notes on each X source. */
export const X_SOURCES = [
  { id: "stream", name: "Official X API · filtered stream", note: "Fastest. Posts arrive as they're published (typically well under a second plus X's own delay). Needs an X API plan that includes filtered stream." },
  { id: "poll", name: "Official X API · polling", note: "Checks recent posts every N seconds. Simple, but posts can be up to N seconds late." },
  { id: "provider", name: "Provider webhook", note: "A third-party X data provider pushes posts to your agent. Speed depends entirely on the provider." },
] as const;
