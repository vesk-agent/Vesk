/**
 * vesk order buy  <mint> <sol> --below <price> | --mcap <usd>      limit buy at a price or market cap
 * vesk order sell <mint> <pct> --above <price> | --mcap <usd>      limit sell
 * vesk order stop <mint> <pct> --below <price> | --mcap <usd>      stop-loss
 * vesk order trail <mint> <pct> --trail <pct>                     trailing stop: sell when price falls pct below the high
 * vesk order dca  <mint> <sol> --every <min> --times <n>          (or --every-sec <s>, --total <sol> --slices <n>,
 *                                                                  --min-mcap / --max-mcap, --side sell for a sell DCA in %)
 * vesk order twap <mint> <total> --over <30m|90s|2h> --slices <n> | --weights 50,30,20   (--side sell: total is a %)
 * vesk order dev-sell <mint> <sol> --dev <wallet> [--min <sol>]   buy the moment the dev wallet sells (--side sell: sell pct)
 * vesk orders [list | cancel <id>] [--json]
 * Every order takes --preset p1|p2|p3 (fees, MEV) and --slippage <pct>.
 * Orders are handed to the agent through control.json (picked up within 2 s, or when it next starts). Price
 * orders are checked every 2 s; dev-sell orders watch the coin's live trades. Every fill passes the same
 * guardrails and limits as any other trade.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dcaSlice, describeOrder, isPubkey, State, twapSchedule, validateOrder, type ControlFile, type Order } from "@vesk-agent/core";
import { config } from "../context.js";
import { dim, fail, json, table } from "../ui.js";

async function queue(dataDir: string, patch: Pick<ControlFile, "orders" | "cancelOrders">) {
  const f = join(dataDir, "control.json");
  const cur = existsSync(f) ? (JSON.parse(await readFile(f, "utf8")) as ControlFile) : {};
  await writeFile(f, JSON.stringify({ ...cur, orders: [...(cur.orders ?? []), ...(patch.orders ?? [])], cancelOrders: [...(cur.cancelOrders ?? []), ...(patch.cancelOrders ?? [])], at: Date.now() }));
}

/** "50k" → 50000, "1.2m" → 1200000, "$80,000" → 80000. */
export function parseUsd(v: unknown): number | undefined {
  if (v === undefined || v === true) return undefined;
  const m = /^\$?([\d,.]+)\s*([kmb])?$/i.exec(String(v).trim());
  if (!m) return NaN;
  const n = Number(m[1].replace(/,/g, ""));
  return n * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase() as "k"] ?? 1);
}
/** "90s" → 90, "30m" → 1800, "2h" → 7200, "1d" → 86400, "45" → 45 (seconds). */
export function parseDuration(v: unknown): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i.exec(String(v ?? "").trim());
  if (!m) return NaN;
  return Math.round(Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[(m[2] ?? "s").toLowerCase() as "s"]));
}

const USAGE = [
  "Usage: vesk order buy <mint> <sol> --below <price> | --mcap <usd>",
  "       vesk order sell <mint> <pct> --above <price> | --mcap <usd>",
  "       vesk order stop <mint> <pct> --below <price> | --mcap <usd>",
  "       vesk order trail <mint> <pct> --trail <pct>",
  "       vesk order dca <mint> <sol> --every <min> --times <n>   (or --every-sec <s>, --total <sol> --slices <n>)",
  "       vesk order twap <mint> <total sol> --over <30m> --slices <n> | --weights 50,30,20",
  "       vesk order dev-sell <mint> <sol> --dev <wallet> [--min <sol>]",
].join("\n");

export async function order(args: string[], f: Record<string, unknown>) {
  const [kind, mint, amount] = args;
  if (!kind || !mint || !amount) fail(USAGE);
  if (!isPubkey(mint)) fail("That isn't a token mint address.");
  const c = await config(f.config as string | undefined);
  const now = Date.now();
  const id = `o_${now.toString(36)}`;
  const preset = typeof f.preset === "string" && /^p[123]$/.test(f.preset) ? (f.preset as "p1" | "p2" | "p3") : undefined;
  const base = { id, mint, slippageBps: Math.round(Number(f.slippage ?? 15) * 100), createdAt: now, status: "open" as const, source: "cli" as const, ...(preset ? { preset } : {}) };
  const n = Number(String(amount).replace(/%$/, ""));
  const sell = f.side === "sell";
  const mcap = parseUsd(f.mcap);
  const trigger = (dir: "below" | "above") => (mcap !== undefined ? { atMcapUsd: mcap } : { priceSol: Number(f[dir]) });
  let o: Order;
  switch (kind) {
    case "buy": o = { ...base, kind: "limit-buy", amountSol: n, ...trigger("below") }; break;
    case "sell": o = { ...base, kind: "limit-sell", sellPct: n, ...trigger("above") }; break;
    case "stop": o = { ...base, kind: "stop-loss", sellPct: n, ...trigger("below") }; break;
    case "trail": o = { ...base, kind: "trailing", sellPct: n, trailPct: Number(f.trail) }; break;
    case "dca": {
      const slices = f.slices !== undefined ? Number(f.slices) : Number(f.times);
      const per = f.total !== undefined ? dcaSlice(Number(f.total), slices) : n;
      const every = f["every-sec"] !== undefined ? { intervalSec: Number(f["every-sec"]) } : { intervalMin: Number(f.every) };
      const band = { ...(f["min-mcap"] !== undefined ? { minMcapUsd: parseUsd(f["min-mcap"]) } : {}), ...(f["max-mcap"] !== undefined ? { maxMcapUsd: parseUsd(f["max-mcap"]) } : {}) };
      o = { ...base, kind: "dca", side: sell ? "sell" : "buy", ...(sell ? { sellPct: n } : { amountSol: per }), ...every, remaining: slices, slices, nextAt: now, ...band };
      break;
    }
    case "twap": {
      const durationSec = parseDuration(f.over);
      const weights = typeof f.weights === "string" ? f.weights.split(",").map(Number) : undefined;
      const schedule = twapSchedule({ side: sell ? "sell" : "buy", total: n, durationSec, slices: Number(f.slices ?? 0) || undefined, weights }, now);
      o = { ...base, kind: "twap", side: sell ? "sell" : "buy", ...(sell ? { totalPct: n } : { totalSol: n }), durationSec, schedule, slices: schedule.length };
      break;
    }
    case "dev-sell":
      o = { ...base, kind: "dev-sell", side: sell ? "sell" : "buy", ...(sell ? { sellPct: n } : { amountSol: n }), dev: String(f.dev ?? ""), ...(f.min !== undefined ? { minDevSellSol: Number(f.min) } : {}) };
      break;
    default:
      fail(USAGE);
  }
  const errs = validateOrder(o);
  if (errs.length) fail(errs.join(" "));
  await queue(c.dataDir, { orders: [o] });
  if (json({ queued: o })) return;
  console.log(`  ${dim("queued")} ${id}  ${describeOrder(o)}`);
  if (o.kind === "twap") for (const [i, s] of (o.schedule ?? []).entries()) console.log(dim(`    slice ${i + 1}  ${new Date(s.at).toLocaleTimeString()}  ${s.amountSol !== undefined ? `${s.amountSol} SOL` : `${s.sellPct}%`}`));
  console.log(dim(o.kind === "dev-sell"
    ? "  The running agent watches this coin's live trades and fires when the dev wallet sells. Limits and guardrails apply."
    : "  The running agent picks it up within 2 s (or when it starts) and checks it every 2 s. Limits and guardrails apply to every fill."));
}

export async function orders(args: string[], f: Record<string, unknown>) {
  const c = await config(f.config as string | undefined);
  if (args[0] === "cancel") {
    if (!args[1]) fail("Usage: vesk orders cancel <id>");
    await queue(c.dataDir, { cancelOrders: [args[1]] });
    if (json({ cancelled: args[1] })) return;
    return console.log(`  Cancel sent for ${args[1]}.`);
  }
  const s = await new State(c.dataDir).load();
  const list = s.data.orders;
  if (json(list)) return;
  if (!list.length) return console.log(dim("  No orders. Add one with `vesk order buy|sell|stop|trail|dca|twap|dev-sell …`."));
  table(list.map((o) => ({ id: o.id, status: o.status, mint: `${o.mint.slice(0, 4)}…${o.mint.slice(-4)}`, order: describeOrder(o), note: o.lastError ? `last try: ${o.lastError}` : "" })), ["id", "status", "mint", "order", "note"]);
}
