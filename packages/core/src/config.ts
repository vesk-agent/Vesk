/**
 * Configuration: `vesk.config.yaml` (or `.json`, or `vesk.config.ts` exporting `defineConfig({...})`).
 * Secrets are never stored in the config file. It names environment variables or keys in the
 * encrypted local keystore (`vesk keys set NAME`).
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { validateLimits, validateRule, type FieldError } from "./rules/validate.js";
import { defaultLaunchRule, validateLaunchRule, type LaunchOnPostRule } from "./launch/onpost.js";
import { DEFAULT_LIMITS, type Limits, type Rule, type WatchEntry } from "./types.js";

export type { WatchEntry };

export type ModelProvider = "anthropic" | "openai" | "openrouter" | "ollama" | "none";

export interface CoinConfig {
  /** The coin this agent runs for you (your launch). */
  mint: string;
  symbol: string;
  /** Accounts you own and linked. Posts go nowhere else. */
  postTo: { x?: string; telegramChatId?: string };
  updates: { enabled: boolean; everyMin: number; onMilestones: boolean };
  community: { answerQuestions: boolean; telegramGroupId?: string; faq: string };
  treasury: {
    claimFees: boolean;
    claimEveryMin: number;
    /** % of claimed fees used for disclosed buybacks (0 = off). */
    buybackPct: number;
    /** Burn bought-back tokens (always disclosed). */
    burnBuybacks: boolean;
  };
}

export interface VeskConfig {
  /** Where state, logs and the keystore live. Default ~/.vesk */
  dataDir: string;
  wallet: { keystore: string };
  rpc: {
    url: string;
    wsUrl?: string;
    priorityFeeSol: number;
    jito: { enabled: boolean; blockEngineUrl: string; tipSol: number };
  };
  model: { provider: ModelProvider; model: string; baseUrl?: string; apiKeyEnv?: string };
  x: {
    /**
     * relay: Vesk Relay (free for $VESK holders; needs `vesk pair`). official-api: your own X developer token.
     * provider: a data provider you pay for, pushing to a local webhook. off: no X watching.
     */
    source: "relay" | "official-api" | "provider" | "off";
    /** Env var or keystore key holding your X API bearer token (official API, your own developer account). */
    bearerTokenEnv: string;
    pollIntervalSec: number;
    /** A data provider you pay for that pushes posts to a local webhook. No scraping by default. */
    provider?: { listenPort: number; secretEnv: string };
  };
  launches: { enabled: boolean; source: "pumpportal" };
  telegram: { enabled: boolean; botTokenEnv: string; allowedChatIds: number[] };
  limits: Limits;
  /** Paper mode by default after `vesk init`: decisions are real, nothing is signed. `vesk summon --live` signs. */
  paper?: boolean;
  watchlist: WatchEntry[];
  rules: Rule[];
  coin?: CoinConfig;
  /** Optional: report status to the web panel after `vesk pair <code>`. Keys never leave your machine. */
  panel?: { url: string; report: boolean; syncRules: boolean };
  /**
   * v19: Strategy & safety (strategy/settings.ts): entry filters, rug check, can-sell check, exits, Rogue mode. Partial
   * is fine; missing values take the Balanced defaults. `vesk strategy set` writes rules.json, which wins over this.
   */
  strategy?: Record<string, unknown>;
  /**
   * v26: launch-on-post rules kept in this file (each a partial rule: missing settings take the defaults). They are
   * added to the rules saved by the panel / CLI (rules.json); a saved rule with the same id wins.
   */
  launchRules?: Array<Partial<LaunchOnPostRule> & { handles?: string[] }>;
}

export const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";

/** Where Vesk keeps its config, keystore and state. VESK_HOME overrides ~/.vesk. */
export function veskHome(): string {
  return process.env.VESK_HOME || join(homedir(), ".vesk");
}

export function defaultConfig(dataDir = veskHome()): VeskConfig {
  return {
    dataDir,
    wallet: { keystore: join(dataDir, "keystore.json") },
    rpc: { url: PUBLIC_RPC, priorityFeeSol: 0.0005, jito: { enabled: false, blockEngineUrl: "https://mainnet.block-engine.jito.wtf", tipSol: 0.001 } },
    model: { provider: "none", model: "" },
    x: { source: "off", bearerTokenEnv: "X_BEARER_TOKEN", pollIntervalSec: 15 },
    launches: { enabled: false, source: "pumpportal" },
    telegram: { enabled: false, botTokenEnv: "TELEGRAM_BOT_TOKEN", allowedChatIds: [] },
    limits: { ...DEFAULT_LIMITS },
    paper: true,
    watchlist: [],
    rules: [],
  };
}

/** Type helper for `vesk.config.ts`. */
export function defineConfig(c: DeepPartial<VeskConfig>): DeepPartial<VeskConfig> {
  return c;
}
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends Array<infer U> ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== "object" || Array.isArray(over)) return (over as T) ?? base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = b && typeof b === "object" && !Array.isArray(b) && v && typeof v === "object" && !Array.isArray(v) ? merge(b, v) : v;
  }
  return out as T;
}

export const CONFIG_NAMES = ["vesk.config.ts", "vesk.config.yaml", "vesk.config.yml", "vesk.config.json"];

export function findConfig(cwd = process.cwd()): string | null {
  for (const dir of [cwd, veskHome()]) for (const n of CONFIG_NAMES) if (existsSync(join(dir, n))) return join(dir, n);
  return null;
}

export async function loadConfig(path?: string | null): Promise<{ config: VeskConfig; path: string | null; errors: FieldError[] }> {
  const p = path ? resolve(path) : findConfig();
  let raw: unknown = {};
  if (p) {
    if (p.endsWith(".ts") || p.endsWith(".js") || p.endsWith(".mjs")) {
      // Node 22.18+ strips types natively; older Node needs `tsx`.
      const mod = (await import(pathToFileURL(p).href)) as { default?: unknown };
      raw = mod.default ?? {};
    } else {
      const text = await readFile(p, "utf8");
      raw = p.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
    }
  }
  const base = defaultConfig((raw as { dataDir?: string })?.dataDir);
  const config = merge(base, raw);
  config.rules = (config.rules ?? []).map((r) => ({ ...r, createdAt: r.createdAt ?? new Date(0).toISOString() }));
  config.launchRules = configLaunchRules(config);
  return { config, path: p, errors: validateConfig(config) };
}

/** v26: the config file's launch-on-post rules as full rules (`handles` at the top level is accepted for short YAML). */
export function configLaunchRules(c: Pick<VeskConfig, "launchRules">): LaunchOnPostRule[] {
  return (c.launchRules ?? []).map((r, i) => {
    const { handles, ...rest } = r;
    return defaultLaunchRule({ ...rest, id: rest.id ?? `cfg_${i + 1}`, enabled: rest.enabled ?? true, trigger: { requireImage: false, ...rest.trigger, handles: (rest.trigger?.handles ?? handles ?? []).map((h) => h.replace(/^@/, "").toLowerCase()) } });
  });
}

export function validateConfig(c: VeskConfig): FieldError[] {
  const e: FieldError[] = [];
  configLaunchRules(c).forEach((r, i) => e.push(...validateLaunchRule(r).map((x) => ({ ...x, field: `launchRules.${i}.${x.field}` }))));
  e.push(...validateLimits(c.limits).map((x) => ({ ...x, field: `limits.${x.field}` })));
  c.rules.forEach((r, i) => e.push(...validateRule(r, c.limits).map((x) => ({ ...x, field: `rules.${i}.${x.field}` }))));
  c.watchlist.forEach((w, i) => e.push(...validateRule(watchEntryToRule(w), c.limits).map((x) => ({ ...x, field: `watchlist.${i}.${x.field}` }))));
  if (!["relay", "official-api", "provider", "off"].includes(c.x.source)) e.push({ field: "x.source", message: "x.source is relay, official-api, provider or off." });
  if (c.x.source === "relay" && !c.panel?.url) e.push({ field: "x.source", message: "The relay needs a paired panel: run `vesk pair <CODE> --panel <url>` and set panel.url." });
  if (!/^https?:\/\//.test(c.rpc.url)) e.push({ field: "rpc.url", message: "RPC URL must start with http(s)://" });
  if (c.coin && c.coin.treasury.buybackPct > 50) e.push({ field: "coin.treasury.buybackPct", message: "Buybacks are capped at 50% of claimed fees." });
  return e;
}

/** Each watchlist entry becomes an x-post rule with id `w_<handle>`. */
export function watchEntryToRule(w: WatchEntry): Rule {
  const handle = w.handle.replace(/^@/, "").toLowerCase();
  return {
    id: `w_${handle}`,
    name: `Watch @${handle}`,
    enabled: w.enabled,
    trigger: { kind: "x-post", handles: [handle], mode: w.mode, keywords: w.keywords },
    buy: { amountSol: w.amountSol, maxMcapUsd: w.maxMcapUsd, slippageBps: w.slippageBps, priorityFeeSol: w.priorityFeeSol, jitoTipSol: w.jitoTipSol, venue: "auto", ...(w.preset ? { preset: w.preset } : {}) },
    exit: { takeProfit: w.takeProfit, stopLossPct: w.stopLossPct },
    maxBuysPerDay: w.maxBuysPerDay,
    cooldownSec: 30,
    multiCa: "skip",
    createdAt: new Date(0).toISOString(),
  };
}

export function allRules(c: VeskConfig): Rule[] {
  return [...c.rules, ...c.watchlist.map(watchEntryToRule)];
}

/** Resolve a secret: environment variable first, then the unlocked keystore's secrets. */
export function secret(name: string, keystoreSecrets?: Record<string, string>): string | undefined {
  return process.env[name] || keystoreSecrets?.[name] || undefined;
}
