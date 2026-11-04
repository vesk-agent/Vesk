/**
 * X (Twitter) watchers. Vesk uses the OFFICIAL X API with YOUR OWN developer credentials,
 * or a data provider you pay for that pushes posts to a local webhook. It does not scrape X.
 *
 *  - XSearchPoller: one recent-search query `from:a OR from:b …` every N seconds (works on the Basic tier;
 *    latency = your poll interval, rate limits apply to your plan).
 *  - XFilteredStream: the filtered stream endpoint (lowest latency; needs a plan that includes it).
 *  - ProviderWebhook: a provider POSTs posts to http://127.0.0.1:<port>/x with an HMAC signature.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { XPost } from "../types.js";
import { endpoints } from "../endpoints.js";

export interface XWatcher {
  readonly name: string;
  start(onPost: (p: XPost) => void, onError?: (e: Error) => void): Promise<void>;
  stop(): Promise<void>;
  setHandles(handles: string[]): Promise<void>;
}

const FIELDS = "tweet.fields=created_at,entities,referenced_tweets,note_tweet,author_id,attachments,public_metrics&expansions=author_id,attachments.media_keys&user.fields=username&media.fields=url,preview_image_url,type";

export type ApiTweet = {
  id: string; text: string; created_at?: string; author_id?: string;
  note_tweet?: { text: string };
  entities?: { urls?: Array<{ expanded_url?: string; url: string }> };
  referenced_tweets?: Array<{ type: "replied_to" | "quoted" | "retweeted"; id: string }>;
  attachments?: { media_keys?: string[] };
  public_metrics?: { like_count?: number; impression_count?: number; retweet_count?: number; reply_count?: number; bookmark_count?: number };
};
export type ApiUsers = { users?: Array<{ id: string; username: string }> };
export type ApiMedia = Array<{ media_key: string; type: "photo" | "video" | "animated_gif"; url?: string; preview_image_url?: string }>;

export function toXPost(t: ApiTweet, users: ApiUsers["users"] = [], media: ApiMedia = []): XPost {
  const refs = t.referenced_tweets ?? [];
  const keys = t.attachments?.media_keys ?? [];
  const m = keys.map((k) => media.find((x) => x.media_key === k)).filter((x): x is ApiMedia[number] => !!x && !!(x.url ?? x.preview_image_url));
  return {
    media: m.length ? m.map((x) => ({ type: x.type, url: (x.url ?? x.preview_image_url)! })).sort((a, b) => (a.type === "photo" ? -1 : 0) - (b.type === "photo" ? -1 : 0)) : undefined,
    metrics: t.public_metrics ? { likes: t.public_metrics.like_count, views: t.public_metrics.impression_count, reposts: t.public_metrics.retweet_count, replies: t.public_metrics.reply_count, bookmarks: t.public_metrics.bookmark_count } : undefined,
    id: t.id,
    handle: (users.find((u) => u.id === t.author_id)?.username ?? "").toLowerCase(),
    text: t.note_tweet?.text ?? t.text,
    urls: (t.entities?.urls ?? []).map((u) => u.expanded_url ?? u.url),
    createdAt: t.created_at ?? new Date().toISOString(),
    isReply: refs.some((r) => r.type === "replied_to"),
    isRepost: refs.some((r) => r.type === "retweeted"),
    isQuote: refs.some((r) => r.type === "quoted"),
  };
}

async function xget<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${endpoints.xApi()}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  if (r.status === 429) {
    const reset = Number(r.headers.get("x-rate-limit-reset") ?? 0) * 1000;
    throw Object.assign(new Error(`X API rate limit. Resets ${reset ? new Date(reset).toLocaleTimeString() : "soon"}.`), { retryAt: reset });
  }
  if (r.status === 401 || r.status === 403) throw new Error(`X API refused the token (${r.status}). Check your plan and bearer token.`);
  if (!r.ok) throw new Error(`X API ${r.status}`);
  return (await r.json()) as T;
}

export class XSearchPoller implements XWatcher {
  readonly name = "x-search-poll";
  private handles: string[] = [];
  private sinceId?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  constructor(private token: string, private intervalSec = 15) {}

  async setHandles(h: string[]) {
    this.handles = [...new Set(h.map((x) => x.replace(/^@/, "").toLowerCase()))];
  }

  /** X recent search queries are limited in length; split handles into chunks. */
  queries(): string[] {
    const out: string[] = [];
    let cur: string[] = [];
    for (const h of this.handles) {
      const next = [...cur, `from:${h}`].join(" OR ");
      if (next.length > 480 && cur.length) {
        out.push(cur.join(" OR "));
        cur = [];
      }
      cur.push(`from:${h}`);
    }
    if (cur.length) out.push(cur.join(" OR "));
    return out.map((q) => `(${q}) -is:retweet`);
  }

  async start(onPost: (p: XPost) => void, onError?: (e: Error) => void) {
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      let wait = this.intervalSec * 1000;
      try {
        for (const q of this.queries()) {
          const params = `query=${encodeURIComponent(q)}&max_results=20&${FIELDS}${this.sinceId ? `&since_id=${this.sinceId}` : ""}`;
          const j = await xget<{ data?: ApiTweet[]; includes?: ApiUsers & { media?: ApiMedia }; meta?: { newest_id?: string } }>(this.token, `/tweets/search/recent?${params}`);
          const first = !this.sinceId;
          if (j.meta?.newest_id && (!this.sinceId || BigInt(j.meta.newest_id) > BigInt(this.sinceId))) this.sinceId = j.meta.newest_id;
          // On the very first poll only remember where we are: never act on old posts.
          if (!first) for (const t of (j.data ?? []).reverse()) onPost(toXPost(t, j.includes?.users, j.includes?.media));
        }
      } catch (e) {
        const retryAt = (e as { retryAt?: number }).retryAt;
        if (retryAt) wait = Math.max(wait, retryAt - Date.now());
        onError?.(e as Error);
      }
      this.timer = setTimeout(tick, wait);
    };
    await tick();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }
}

export class XFilteredStream implements XWatcher {
  readonly name = "x-filtered-stream";
  private ctl?: AbortController;
  private handles: string[] = [];
  constructor(private token: string) {}

  async setHandles(h: string[]) {
    this.handles = [...new Set(h.map((x) => x.replace(/^@/, "").toLowerCase()))];
    const current = await xget<{ data?: Array<{ id: string; tag?: string }> }>(this.token, "/tweets/search/stream/rules");
    const ours = (current.data ?? []).filter((r) => r.tag?.startsWith("vesk:"));
    if (ours.length) await xget(this.token, "/tweets/search/stream/rules", { method: "POST", body: JSON.stringify({ delete: { ids: ours.map((r) => r.id) } }) });
    if (this.handles.length)
      await xget(this.token, "/tweets/search/stream/rules", { method: "POST", body: JSON.stringify({ add: this.handles.map((h) => ({ value: `from:${h} -is:retweet`, tag: `vesk:${h}` })) }) });
  }

  async start(onPost: (p: XPost) => void, onError?: (e: Error) => void) {
    let backoff = 1000;
    const connect = async () => {
      this.ctl = new AbortController();
      try {
        const r = await fetch(`${endpoints.xApi()}/tweets/search/stream?${FIELDS}`, { headers: { Authorization: `Bearer ${this.token}` }, signal: this.ctl.signal });
        if (!r.ok || !r.body) throw new Error(`X stream ${r.status}`);
        backoff = 1000;
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\r\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 2);
            if (!line) continue; // keep-alive
            const j = JSON.parse(line) as { data?: ApiTweet; includes?: ApiUsers & { media?: ApiMedia } };
            if (j.data) onPost(toXPost(j.data, j.includes?.users, j.includes?.media));
          }
        }
      } catch (e) {
        if (this.ctl?.signal.aborted) return;
        onError?.(e as Error);
      }
      if (this.ctl?.signal.aborted) return;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 60_000);
    };
    void connect();
  }

  async stop() {
    this.ctl?.abort();
  }
}

/** A provider you choose pushes posts to this local endpoint. Body: { id, handle, text, urls?, createdAt?, isReply?, isRepost? }. */
export class ProviderWebhook implements XWatcher {
  readonly name = "x-provider-webhook";
  private server?: Server;
  private handles = new Set<string>();
  constructor(private port: number, private secret: string) {}

  async setHandles(h: string[]) {
    this.handles = new Set(h.map((x) => x.replace(/^@/, "").toLowerCase()));
  }

  verify(body: string, sig: string | undefined): boolean {
    if (!sig) return false;
    const want = createHmac("sha256", this.secret).update(body).digest("hex");
    const a = Buffer.from(want), b = Buffer.from(sig.replace(/^sha256=/, ""));
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async start(onPost: (p: XPost) => void, onError?: (e: Error) => void) {
    this.server = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/x") return void res.writeHead(404).end();
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString("utf8")));
      req.on("end", () => {
        if (!this.verify(body, req.headers["x-vesk-signature"] as string | undefined)) return void res.writeHead(401).end();
        try {
          const p = JSON.parse(body) as XPost;
          const handle = String(p.handle ?? "").replace(/^@/, "").toLowerCase();
          if (this.handles.has(handle)) onPost({ ...p, handle, urls: p.urls ?? [], createdAt: p.createdAt ?? new Date().toISOString() });
          res.writeHead(204).end();
        } catch (e) {
          onError?.(e as Error);
          res.writeHead(400).end();
        }
      });
    });
    await new Promise<void>((r) => this.server!.listen(this.port, "127.0.0.1", r));
  }

  async stop() {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

/** v26: a post's public counts right now (engagement velocity). Null when the API doesn't return them. */
export async function postMetrics(token: string, id: string): Promise<XPost["metrics"] | null> {
  const j = await xget<{ data?: ApiTweet }>(token, `/tweets/${id}?tweet.fields=public_metrics`);
  const m = j.data?.public_metrics;
  return m ? { likes: m.like_count, views: m.impression_count, reposts: m.retweet_count, replies: m.reply_count, bookmarks: m.bookmark_count } : null;
}

/**
 * v26: the last days of posts from some accounts (recent search reaches back 7 days), for a launch-rule backtest.
 * Read-only; at most `pages` pages of 100 per query.
 */
export async function recentPosts(token: string, handles: string[], sinceMs: number, pages = 5): Promise<XPost[]> {
  const out: XPost[] = [];
  const start = new Date(Math.max(sinceMs, Date.now() - 7 * 86_400_000 + 60_000)).toISOString();
  for (let i = 0; i < handles.length; i += 20) {
    const q = handles.slice(i, i + 20).map((h) => `from:${h}`).join(" OR ");
    let next: string | undefined;
    for (let p = 0; p < pages; p++) {
      const j = await xget<{ data?: ApiTweet[]; includes?: ApiUsers & { media?: ApiMedia }; meta?: { next_token?: string } }>(token, `/tweets/search/recent?query=${encodeURIComponent(q)}&max_results=100&start_time=${start}&${FIELDS}${next ? `&next_token=${next}` : ""}`);
      for (const t of j.data ?? []) out.push(toXPost(t, j.includes?.users, j.includes?.media));
      next = j.meta?.next_token;
      if (!next) break;
    }
  }
  return out;
}
