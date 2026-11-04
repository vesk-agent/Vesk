/**
 * Migration orders: buy a coin the moment it migrates (pump.fun / LetsBonk curve → PumpSwap or Raydium), or sell
 * what you hold when it migrates (useful for coins you only wanted on the curve). Driven by PumpPortal's
 * `subscribeMigration` event (watch/migrationWatcher.ts). Every order runs through the same executor, guardrails,
 * limits and blacklist as any other trade, with the preset you pick, through your own RPC (or a Jito bundle if the
 * preset's MEV mode says so).
 *
 * Pure logic here (tested); the agent wires it up in agent.ts (`startMigrations`) and the CLI in `vesk migration`.
 */
import { isPubkey } from "../base58.js";
import { isPresetId, type PresetId } from "../trade/settings.js";

export type MigrationSide = "buy" | "sell";
export type MigrationStatus = "armed" | "done" | "failed" | "cancelled";

export interface MigrationOrder {
  id: string;
  mint: string;
  symbol?: string;
  side: MigrationSide;
  /** buy: SOL to spend. */
  amountSol?: number;
  /** sell: percent of your holding. */
  pct?: number;
  /** Trading preset for slippage, fees and MEV mode. Default: your active preset for that side. */
  preset?: PresetId;
  status: MigrationStatus;
  createdAt: string;
  firedAt?: string;
  /** What happened: signature, refusal reason or error. */
  result?: string;
}

/** A PumpPortal migration message (the fields we use). */
export interface MigrationEvent { mint: string; pool?: string; signature?: string }

export interface MigrationFieldError { field: string; message: string }
export const MIGRATION_MAX_ARMED = 50;

export function validateMigrationOrder(o: Partial<MigrationOrder>): MigrationFieldError[] {
  const e: MigrationFieldError[] = [];
  if (!isPubkey(o.mint ?? "")) e.push({ field: "mint", message: "That isn't a coin address." });
  if (o.side !== "buy" && o.side !== "sell") e.push({ field: "side", message: "Pick buy or sell." });
  if (o.side === "buy" && !(Number(o.amountSol) > 0 && Number(o.amountSol) <= 100)) e.push({ field: "amountSol", message: "Buy amount must be above 0 SOL (and at most 100)." });
  if (o.side === "sell" && !(Number(o.pct) > 0 && Number(o.pct) <= 100)) e.push({ field: "pct", message: "Sell 1-100% of what you hold." });
  if (o.preset !== undefined && !isPresetId(o.preset)) e.push({ field: "preset", message: "Preset is p1, p2 or p3." });
  return e;
}

let seq = 0;
export function newMigrationOrder(o: { mint: string; side: MigrationSide; amountSol?: number; pct?: number; preset?: PresetId; symbol?: string }, now = new Date()): MigrationOrder {
  const errs = validateMigrationOrder(o);
  if (errs.length) throw new Error(errs[0].message);
  return {
    id: `mig_${now.getTime().toString(36)}${(seq++).toString(36)}`, mint: o.mint, side: o.side, status: "armed", createdAt: now.toISOString(),
    ...(o.symbol ? { symbol: o.symbol.slice(0, 12) } : {}), ...(o.side === "buy" ? { amountSol: Number(o.amountSol) } : { pct: Number(o.pct) }), ...(o.preset ? { preset: o.preset } : {}),
  };
}

export function normalizeMigrationOrders(x: unknown): MigrationOrder[] {
  if (!Array.isArray(x)) return [];
  return x.filter((o): o is MigrationOrder => !!o && typeof o === "object" && validateMigrationOrder(o as MigrationOrder).length === 0 && typeof (o as MigrationOrder).id === "string")
    .map((o) => ({ ...o, status: (["armed", "done", "failed", "cancelled"] as const).includes(o.status) ? o.status : "armed" }))
    .slice(-200);
}

/** The armed orders this migration fires: every armed order on that mint, sells first (get out before adding). */
export function matchMigration(orders: MigrationOrder[], ev: MigrationEvent): MigrationOrder[] {
  if (!ev?.mint) return [];
  return orders.filter((o) => o.status === "armed" && o.mint === ev.mint).sort((a, b) => (a.side === b.side ? 0 : a.side === "sell" ? -1 : 1));
}

/** Mark an order fired. Returns a new list. */
export function settleMigration(orders: MigrationOrder[], id: string, ok: boolean, result: string, now = new Date()): MigrationOrder[] {
  return orders.map((o) => (o.id === id ? { ...o, status: ok ? "done" : "failed", firedAt: now.toISOString(), result: result.slice(0, 200) } : o));
}

export const armedCount = (orders: MigrationOrder[]) => orders.filter((o) => o.status === "armed").length;

export function describeMigrationOrder(o: MigrationOrder): string {
  const what = o.side === "buy" ? `buy ${o.amountSol} SOL` : `sell ${o.pct}%`;
  return `On migration: ${what} of ${o.symbol ? `$${o.symbol}` : `${o.mint.slice(0, 4)}…${o.mint.slice(-4)}`}${o.preset ? ` with ${o.preset.toUpperCase()}` : ""}`;
}

/**
 * Orders pulled from the panel: the panel decides which orders exist (adds, cancels), but an order this agent
 * already fired keeps its done/failed status, so a pull never re-arms it.
 */
export function mergeMigration(local: MigrationOrder[], remote: MigrationOrder[]): MigrationOrder[] {
  const fired = new Map(local.filter((o) => o.status === "done" || o.status === "failed").map((o) => [o.id, o]));
  return remote.map((o) => fired.get(o.id) ?? o);
}
