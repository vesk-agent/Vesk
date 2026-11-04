/**
 * vesk pulse [--column new|final|migrated] [--filter filter.json] [--buy <sol> --preset p2 [--max 1]] [--for <sec>] [--json]
 *
 * Live coins from PumpPortal's data stream with the same audits and filters as the panel's Pulse. With --buy, the
 * first coins that match get a quick buy with the chosen trading preset, through the same guardrails and limits as
 * every other buy (one wallet per coin, per-trade max, daily cap, kill switch). --paper decides without signing.
 * A filter file is a column filter or a full Pulse export from the panel (its column settings are used).
 * When the filter uses an audit that needs RPC data (holders, top 10, bundled, insiders) or hides unknown audits,
 * each candidate is enriched through your RPC (holders, largest holders, funding sources) and checked again before
 * it's shown or bought. That costs a few hundred ms per coin; it's the price of not buying hidden supply.
 */
import { readFile } from "node:fs/promises";
import {
  ageLabel, enrichCoin, POOL_PROGRAMS, PoolWatcher, importPulseSettings, Rpc, type PulseEnrichment, isPresetId, pulseAudits, pulseColumn, pulseFails, PulseFeed, snapshot, type PulseColumn, type PulseColumnFilter,
} from "@vesk-agent/core";
import { agent, config } from "../context.js";
import { dim, fail, ice, jsonMode, line, up } from "../ui.js";

export async function pulse(_args: string[], f: Record<string, unknown>) {
  if (typeof f.pools === "string") return pools(f);
  const col = (f.column ?? "new") as PulseColumn;
  if (!["new", "final", "migrated"].includes(col)) fail("--column is new, final or migrated.");
  let filter: PulseColumnFilter = {};
  if (typeof f.filter === "string") {
    try { filter = importPulseSettings(await readFile(f.filter, "utf8")).columns[col].filter; } catch (e) { fail(`Filter ${f.filter}: ${(e as Error).message}`); }
  }
  const buySol = f.buy !== undefined ? Number(f.buy) : 0;
  if (f.buy !== undefined && !(buySol > 0)) fail("--buy takes an amount in SOL.");
  if (f.preset !== undefined && !isPresetId(f.preset)) fail("--preset is p1, p2 or p3.");
  const max = Number(f.max ?? 1);
  const a = buySol ? await agent({ config: f.config as string | undefined, paper: !!f.paper }) : null;
  const x = a ? await a.tradeParams("buy", isPresetId(f.preset) ? f.preset : undefined) : null;
  let solUsd = 150;
  if (a) solUsd = await snapshot(a.rpc, "So11111111111111111111111111111111111111112").then((m) => m?.priceUsd || 150).catch(() => 150);
  const shown = new Set<string>();
  const RPC_AUDITS = ["holders", "top10Pct", "bundledPct", "insidersPct"] as const;
  const needRpc = !!filter.hideUnknown || RPC_AUDITS.some((k) => filter.audits?.[k]);
  const rpc = a?.rpc ?? (needRpc ? new Rpc((await config(f.config as string | undefined)).rpc.url) : null);
  const enriched = new Map<string, PulseEnrichment | "pending">();
  let bought = 0;
  const busy = new Set<string>();
  if (!jsonMode()) console.log(dim(`  Pulse · ${col === "new" ? "New pairs" : col === "final" ? "Final stretch" : "Migrated"}${buySol ? ` · quick buy ${buySol} SOL with ${String(f.preset ?? "the active preset").toUpperCase()} (max ${max})` : ""} · ctrl-c stops`));

  const check = (mint: string): void => {
    const t = feed.state.tokens[mint];
    if (!t || pulseColumn(t) !== col) return;
    let au = pulseAudits(feed.state, t);
    if (pulseFails(feed.state, t, filter, { solUsd }, au).length) return;
    if (needRpc && rpc) {
      const e = enriched.get(mint);
      if (!e) {
        enriched.set(mint, "pending");
        void enrichCoin(rpc, mint, { dev: t.creator }).then((x) => { enriched.set(mint, x); check(mint); }).catch(() => enriched.delete(mint));
        return;
      }
      if (e === "pending") return;
      au = pulseAudits(feed.state, t, e);
      if (pulseFails(feed.state, t, filter, { solUsd, enrich: { [mint]: e } }, au).length) return;
    }
    if (!shown.has(mint)) {
      shown.add(mint);
      line("pulse", `${t.symbol || "?"} ${dim(t.name)} ${dim(mint.slice(0, 4) + "…" + mint.slice(-4))} · ${ageLabel(t.createdAt)} · mc $${Math.round(t.mcapSol * solUsd).toLocaleString("en-US")} · curve ${t.curvePct}% · dev ${au.devPct ?? "–"}% · top10 ${au.top10Pct}% · snipers ${au.snipersPct}% · bundled ${au.bundledPct}%${au.insidersPct !== null ? ` · insiders ${au.insidersPct}%` : ""}${au.source === "rpc" ? ` · ${au.holders} holders (RPC)` : ""}`, ice);
    }
    if (a && x && bought < max && !busy.has(mint)) {
      busy.add(mint);
      bought++;
      void a.executor.buy({ action: "buy", wallet: a.address, mint, amountSol: buySol, slippageBps: x.slippageBps, priorityFeeSol: x.priorityFeeSol, jitoTipSol: x.jitoTipSol, jitoOnly: x.jitoOnly, venue: "auto", reason: `Pulse quick buy (${String(f.preset ?? "active").toUpperCase()})` }, t.symbol || mint.slice(0, 4))
        .then(async (r) => {
          line(r.ok ? "buy" : "guardrail", r.ok ? `Pulse quick buy: ${buySol} SOL of ${t.symbol} · ${x.mev !== "off" ? "Jito bundle only" : "via your RPC"} · ${r.latencyMs} ms` : `Pulse quick buy refused: ${r.error}`, r.ok ? up : undefined);
          await a.state.save();
          if (!r.ok) bought--;
          else if (bought >= max) setTimeout(stop, 300);
        });
    }
  };
  const feed: PulseFeed = new PulseFeed({
    onChange: (mint) => check(mint),
    onError: (e) => line("error", e.message),
  });
  const stop = () => { feed.stop(); process.exit(0); };
  feed.start();
  process.on("SIGINT", stop);
  if (f.for) setTimeout(stop, Number(f.for) * 1000);
}

/**
 * `vesk pulse --pools all|meteora-dbc,raydium-launchlab,…`: new pools on the programs in data/programs.ts, from
 * logsSubscribe on YOUR RPC's websocket. Prints each new coin with its protocol. No buying from this mode.
 */
async function pools(f: Record<string, unknown>) {
  const c = await config(f.config as string | undefined);
  const want = String(f.pools) === "all" ? undefined : String(f.pools).split(",").map((x) => x.trim()).filter(Boolean);
  const known = new Set(POOL_PROGRAMS.map((p) => p.protocol));
  for (const w of want ?? []) if (!known.has(w as never)) fail(`Unknown protocol "${w}". Watched: ${[...known].join(", ")}.`);
  const rpc = new Rpc(c.rpc.url, 10_000, c.rpc.wsUrl);
  const pw = new PoolWatcher(rpc, (p) => line("pool", `${p.protocol} · ${p.program} · ${p.mint}${p.quote ? ` / ${p.quote}` : ""} ${dim(p.signature.slice(0, 10) + "…")}`, ice), { protocols: want, onError: (e) => line("error", e.message) });
  console.log(dim(`  New pools via your RPC websocket · ${pw.programs().map((p) => p.name).join(", ")} · ctrl-c stops`));
  pw.start();
  const stop = () => { pw.stop(); process.exit(0); };
  process.on("SIGINT", stop);
  if (f.for) setTimeout(stop, Number(f.for) * 1000);
}
