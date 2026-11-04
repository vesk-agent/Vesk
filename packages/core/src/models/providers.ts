/**
 * Bring your own model. Thin fetch clients for Anthropic, OpenAI, OpenRouter (any model) and Ollama (local).
 * Keys come from your environment or the encrypted keystore; they are sent only to the provider you chose.
 */
import { endpoints } from "../endpoints.js";
import { BRAND } from "../brand.js";
export type Role = "system" | "user" | "assistant";
export interface ChatMessage {
  role: Role;
  content: string;
}
export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  /** Ask for a JSON object reply (providers that support it). */
  json?: boolean;
}
export interface ModelClient {
  readonly provider: string;
  readonly model: string;
  chat(messages: ChatMessage[], o?: ChatOptions): Promise<string>;
}

export const DEFAULT_MODELS = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4.1-mini",
  openrouter: "anthropic/claude-sonnet-4.5",
  ollama: "llama3.1",
} as const;

async function post<T>(url: string, headers: Record<string, string>, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${new URL(url).hostname} ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return (await r.json()) as T;
}

export class AnthropicClient implements ModelClient {
  readonly provider = "anthropic";
  constructor(private key: string, readonly model: string = DEFAULT_MODELS.anthropic) {}
  async chat(messages: ChatMessage[], o: ChatOptions = {}) {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const j = await post<{ content: Array<{ type: string; text?: string }> }>(
      endpoints.anthropic(),
      { "x-api-key": this.key, "anthropic-version": "2023-06-01" },
      { model: this.model, max_tokens: o.maxTokens ?? 1024, temperature: o.temperature ?? 0.2, system, messages: messages.filter((m) => m.role !== "system") },
    );
    return j.content.filter((c) => c.type === "text").map((c) => c.text).join("");
  }
}

/** OpenAI and every OpenAI-compatible API (OpenRouter, LM Studio, vLLM…). */
export class OpenAICompatClient implements ModelClient {
  constructor(readonly provider: string, private baseUrl: string, private key: string | undefined, readonly model: string, private extraHeaders: Record<string, string> = {}) {}
  async chat(messages: ChatMessage[], o: ChatOptions = {}) {
    const j = await post<{ choices: Array<{ message: { content: string } }> }>(
      `${this.baseUrl.replace(/\/$/, "")}/chat/completions`,
      { ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}), ...this.extraHeaders },
      { model: this.model, messages, max_tokens: o.maxTokens ?? 1024, temperature: o.temperature ?? 0.2, ...(o.json ? { response_format: { type: "json_object" } } : {}) },
    );
    return j.choices[0]?.message.content ?? "";
  }
}

export class OllamaClient implements ModelClient {
  readonly provider = "ollama";
  constructor(readonly model: string = DEFAULT_MODELS.ollama, private baseUrl = "http://127.0.0.1:11434") {}
  async chat(messages: ChatMessage[], o: ChatOptions = {}) {
    const j = await post<{ message: { content: string } }>(`${this.baseUrl.replace(/\/$/, "")}/api/chat`, {}, {
      model: this.model, messages, stream: false, ...(o.json ? { format: "json" } : {}), options: { temperature: o.temperature ?? 0.2 },
    });
    return j.message.content;
  }
}

export function makeModel(cfg: { provider: string; model: string; baseUrl?: string }, key?: string): ModelClient | null {
  switch (cfg.provider) {
    case "anthropic":
      if (!key) throw new Error("Anthropic needs ANTHROPIC_API_KEY (env or `vesk keys set ANTHROPIC_API_KEY`).");
      return new AnthropicClient(key, cfg.model || DEFAULT_MODELS.anthropic);
    case "openai":
      if (!key) throw new Error("OpenAI needs OPENAI_API_KEY.");
      return new OpenAICompatClient("openai", cfg.baseUrl ?? "https://api.openai.com/v1", key, cfg.model || DEFAULT_MODELS.openai);
    case "openrouter":
      if (!key) throw new Error("OpenRouter needs OPENROUTER_API_KEY.");
      return new OpenAICompatClient("openrouter", cfg.baseUrl ?? "https://openrouter.ai/api/v1", key, cfg.model || DEFAULT_MODELS.openrouter, { "X-Title": `${BRAND.name} agent` });
    case "ollama":
      return new OllamaClient(cfg.model || DEFAULT_MODELS.ollama, cfg.baseUrl);
    default:
      return null;
  }
}

export const KEY_ENV: Record<string, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY" };
