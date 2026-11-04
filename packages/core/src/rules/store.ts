/** Rules and watchlist entries added from the CLI, chat, Telegram or MCP live in <dataDir>/rules.json. */
import type { TradingSettings } from "../trade/settings.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WatchEntry } from "../config.js";
import type { Limits, Rule } from "../types.js";
import { validateRule } from "./validate.js";
import { validateLaunchRule, type LaunchOnPostRule } from "../launch/onpost.js";
import { validatePreset, type LaunchPreset } from "../launch/presets.js";
import type { TrackerGroup } from "../watch/tracker.js";
import type { Blacklist } from "../watch/blacklist.js";
import type { MigrationOrder } from "../watch/migration.js";

export interface RuleFile {
  version: number;
  rules: Rule[];
  watchlist: WatchEntry[];
  limits?: Partial<Limits>;
  /** Launch-on-post rules. */
  launchRules?: LaunchOnPostRule[];
  /** Named launch presets (Deploy, Instant deploy, launch-on-post). */
  presets?: LaunchPreset[];
  /** Tracker account groups. */
  trackerGroups?: TrackerGroup[];
  /** Default preset for Instant deploy. */
  defaultPresetId?: string;
  /** Trading presets (P1/P2/P3), quick amounts, hotkeys. Synced from the panel when panel.syncRules is on. */
  trading?: TradingSettings;
  /** Pulse column settings (filters, quick-buy, display), synced from the panel. */
  pulse?: unknown;
  /** Your blacklist (watch/blacklist.ts): coins, devs, funders and wallets that are hidden and never bought. */
  blacklist?: Blacklist;
  /** Migration orders (watch/migration.ts): buy or sell when a coin migrates. */
  migration?: MigrationOrder[];
  /** Copy trading (copy/settings.ts CopyConfig): tracked wallets, the default profile and per-wallet overrides. */
  copy?: unknown;
  /** v19: Strategy & safety (strategy/settings.ts StrategySettings), including the Rogue mode switch. */
  strategy?: unknown;
}

export class RuleStore {
  data: RuleFile = { version: 0, rules: [], watchlist: [] };
  constructor(private dir: string) {}
  get file() {
    return join(this.dir, "rules.json");
  }
  async load(): Promise<this> {
    try {
      this.data = { version: 0, rules: [], watchlist: [], ...(JSON.parse(await readFile(this.file, "utf8")) as Partial<RuleFile>) };
    } catch {
      /* first run */
    }
    return this;
  }
  async save() {
    this.data.version++;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(this.file + ".tmp", JSON.stringify(this.data, null, 2), { mode: 0o600 });
    await rename(this.file + ".tmp", this.file);
  }
  async upsert(r: Rule, limits?: Limits) {
    const errors = validateRule(r, limits);
    if (errors.length) throw new Error(errors.map((e) => `${e.field}: ${e.message}`).join("; "));
    const i = this.data.rules.findIndex((x) => x.id === r.id);
    const next = { ...r, updatedAt: new Date().toISOString() };
    if (i >= 0) this.data.rules[i] = next;
    else this.data.rules.push(next);
    await this.save();
  }
  async upsertLaunchRule(r: LaunchOnPostRule) {
    const errors = validateLaunchRule(r);
    if (errors.length) throw new Error(errors.map((e) => `${e.field}: ${e.message}`).join("; "));
    const list = (this.data.launchRules ??= []);
    const i = list.findIndex((x) => x.id === r.id);
    const next = { ...r, updatedAt: new Date().toISOString() };
    if (i >= 0) list[i] = next;
    else list.push(next);
    await this.save();
  }
  async upsertPreset(p: LaunchPreset) {
    const errors = validatePreset(p);
    if (errors.length) throw new Error(errors.map((e) => `${e.field}: ${e.message}`).join("; "));
    const list = (this.data.presets ??= []);
    const i = list.findIndex((x) => x.id === p.id);
    if (i >= 0) list[i] = p;
    else list.push(p);
    this.data.defaultPresetId ??= p.id;
    await this.save();
  }
  async setGroups(groups: TrackerGroup[]) {
    this.data.trackerGroups = groups;
    await this.save();
  }
  async remove(id: string) {
    this.data.presets = (this.data.presets ?? []).filter((p) => p.id !== id);
    this.data.launchRules = (this.data.launchRules ?? []).filter((r) => r.id !== id);
    this.data.rules = this.data.rules.filter((r) => r.id !== id);
    this.data.watchlist = this.data.watchlist.filter((w) => `w_${w.handle.toLowerCase()}` !== id);
    await this.save();
  }
  async setEnabled(id: string, enabled: boolean) {
    const r = this.data.rules.find((x) => x.id === id);
    if (r) r.enabled = enabled;
    const w = this.data.watchlist.find((x) => `w_${x.handle.toLowerCase()}` === id);
    if (w) w.enabled = enabled;
    const l = (this.data.launchRules ?? []).find((x) => x.id === id);
    if (l) l.enabled = enabled;
    if (!r && !w && !l) throw new Error(`No rule ${id}`);
    await this.save();
  }
  async watch(w: WatchEntry) {
    const h = w.handle.replace(/^@/, "").toLowerCase();
    this.data.watchlist = [...this.data.watchlist.filter((x) => x.handle.toLowerCase() !== h), { ...w, handle: h }];
    await this.save();
  }
}
