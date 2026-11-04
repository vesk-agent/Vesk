/**
 * v26: the race report. After a launch-on-post coin lands, the other coins created for the same post (same post link
 * in their links, or the same ticker or name) within ± `windowMin` of the post are ranked by create time, with ours
 * among them: "1st of 14 · 1.7 s after the post". Stored with the launch and shown on Live, Your launches and the
 * coin page. Pure; the creates come from the PumpPortal stream (CreateFeed), so it counts what that stream saw: a coin
 * created while it was disconnected is missing, and `complete` says so.
 */
import { sameImage, statusId, type ImageHash, type RecentCreate } from "./clash.js";

export interface RaceEntry { mint: string; name: string; symbol: string; at: number; mine: boolean; match: Array<"post" | "ticker" | "name" | "image"> }
export interface RaceReport {
  postId: string;
  postAt: number;
  landedAt: number;
  rank: number;
  total: number;
  msAfterPost: number;
  windowMin: number;
  computedAt: number;
  entries: RaceEntry[];
  /** the creates stream was connected the whole window (else the report may miss coins) */
  complete: boolean;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
export const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
export const fmtGap = (ms: number) => (ms < 1000 ? `${Math.max(0, Math.round(ms))} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`);

export function raceReport(
  mine: { mint: string; name: string; symbol: string; landedAt: number },
  post: { id: string; url: string; at: number },
  creates: RecentCreate[],
  o: { windowMin: number; now?: number; complete?: boolean; image?: ImageHash | null },
): RaceReport {
  const id = statusId(post.url) ?? post.id;
  const lo = post.at - o.windowMin * 60_000, hi = post.at + o.windowMin * 60_000;
  const entries: RaceEntry[] = [];
  for (const c of creates) {
    if (c.mint === mine.mint || c.at < lo || c.at > hi) continue;
    const match: RaceEntry["match"] = [];
    if (statusId(c.website) === id || statusId(c.twitter) === id) match.push("post");
    if (norm(c.symbol) === norm(mine.symbol)) match.push("ticker");
    if (norm(c.name) === norm(mine.name)) match.push("name");
    if (o.image && sameImage(o.image, c.image)) match.push("image");
    if (match.length) entries.push({ mint: c.mint, name: c.name, symbol: c.symbol, at: c.at, mine: false, match });
  }
  entries.push({ mint: mine.mint, name: mine.name, symbol: mine.symbol, at: mine.landedAt, mine: true, match: ["post"] });
  entries.sort((a, b) => a.at - b.at || (a.mine ? -1 : 1));
  const rank = entries.findIndex((e) => e.mine) + 1;
  return { postId: post.id, postAt: post.at, landedAt: mine.landedAt, rank, total: entries.length, msAfterPost: mine.landedAt - post.at, windowMin: o.windowMin, computedAt: o.now ?? Date.now(), entries, complete: o.complete ?? true };
}

/** "1st of 14 · 1.7 s after the post" */
export const raceLabel = (r: Pick<RaceReport, "rank" | "total" | "msAfterPost">) => `${ordinal(r.rank)} of ${r.total} · ${fmtGap(r.msAfterPost)} after the post`;
