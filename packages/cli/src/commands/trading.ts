/**
 * vesk trading [show | export [--out file] | import <file> | active <p1|p2|p3> [--sell]] [--json]
 * The trading presets (P1/P2/P3 for buys and sells), quick amounts, wallet, confirmation and hotkeys. The panel
 * edits the same settings; a paired agent pulls them with your rules.
 */
import { readFile, writeFile } from "node:fs/promises";
import { isPresetId, normalizeTradingSettings, RuleStore, validateTradingSettings, type TradingSettings } from "@vesk-agent/core";
import { config } from "../context.js";
import { dim, fail, ice, json, kv, table } from "../ui.js";

export async function trading(args: string[], f: Record<string, unknown>) {
  const c = await config(f.config as string | undefined);
  const s = await new RuleStore(c.dataDir).load();
  const t = normalizeTradingSettings(s.data.trading);
  const [sub, arg] = args;
  if (sub === "export") {
    const text = JSON.stringify(t, null, 2);
    if (typeof f.out === "string") { await writeFile(f.out, text); return console.log(`  Wrote ${f.out}`); }
    return console.log(text);
  }
  if (sub === "import") {
    if (!arg) fail("Usage: vesk trading import <file.json>");
    let next: TradingSettings;
    try { next = normalizeTradingSettings(JSON.parse(await readFile(arg, "utf8"))); } catch (e) { return fail(`Couldn't read ${arg}: ${(e as Error).message}`); }
    const errs = validateTradingSettings(next);
    if (errs.length) fail(errs.map((e) => e.message).join("\n"));
    s.data.trading = next;
    await s.save();
    return console.log("  Trading settings imported. A running agent picks them up within 2 s.");
  }
  if (sub === "active") {
    if (!isPresetId(arg)) fail("Usage: vesk trading active <p1|p2|p3> [--sell]");
    s.data.trading = { ...t, ...(f.sell ? { activeSell: arg } : { activeBuy: arg }) };
    await s.save();
    return console.log(`  Active ${f.sell ? "sell" : "buy"} preset: ${arg.toUpperCase()}`);
  }
  if (json(t)) return;
  kv([["active", `buy ${ice(t.activeBuy.toUpperCase())} · sell ${ice(t.activeSell.toUpperCase())}`], ["quick buy", t.quickBuy.map((n) => `${n} SOL`).join("  ")], ["quick sell", t.quickSellPct.map((n) => `${n}%`).join("  ")], ["confirm above", t.confirmAboveSol ? `${t.confirmAboveSol} SOL` : "never"], ["wallet", t.wallet ?? "main"]]);
  console.log();
  const row = (side: "buy" | "sell") => (id: "p1" | "p2" | "p3") => {
    const p = t[side][id];
    return { preset: `${side} ${id.toUpperCase()}`, slippage: `${p.slippagePct}%`, priority: `${p.priorityFeeSol}`, tip: `${p.jitoTipSol}`, "auto fee": p.autoFee ? `≤ ${p.maxFeeSol}` : "off", mev: p.mev };
  };
  table([...(["p1", "p2", "p3"] as const).map(row("buy")), ...(["p1", "p2", "p3"] as const).map(row("sell"))]);
  console.log(dim("\n  MEV reduced/secure send only as a Jito bundle (no public mempool fallback). Secure also caps slippage at 10%."));
}
