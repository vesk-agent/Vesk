/** Where "run your coin" posts go: only accounts the owner linked. */
import { endpoints } from "../endpoints.js";
export interface Poster {
  /** Account id used by guardrails (X handle or Telegram chat id). */
  readonly account: string;
  readonly kind: "x" | "telegram";
  post(text: string): Promise<{ id: string; url?: string }>;
}

/** X: POST /2/tweets with the owner's OAuth 2.0 user-context token (scope tweet.write). */
export class XPoster implements Poster {
  readonly kind = "x" as const;
  constructor(readonly account: string, private userToken: string) {}
  async post(text: string) {
    const r = await fetch(`${endpoints.xApi()}/tweets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.userToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) throw new Error(`X post failed (${r.status})`);
    const j = (await r.json()) as { data: { id: string } };
    return { id: j.data.id, url: `https://x.com/${this.account}/status/${j.data.id}` };
  }
}

/** Telegram: the owner's bot posts to the owner's channel or group. */
export class TelegramPoster implements Poster {
  readonly kind = "telegram" as const;
  constructor(readonly account: string, private botToken: string) {}
  async post(text: string) {
    const r = await fetch(`${endpoints.telegram()}/bot${this.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: this.account, text, disable_web_page_preview: true }),
    });
    const j = (await r.json()) as { ok: boolean; result?: { message_id: number }; description?: string };
    if (!j.ok) throw new Error(`Telegram post failed: ${j.description ?? r.status}`);
    return { id: String(j.result?.message_id ?? "") };
  }
}
