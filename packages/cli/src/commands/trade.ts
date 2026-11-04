/** vesk buy | sell | launch */
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import {
  finalDescription, findPair, pairSelectable, STATUS_LABEL, fmtK, isLaunchpad, isPresetId, isPubkey, launchpad, launchRoute, LAUNCHPADS, snapshot, summarizePlan, unverifiedSettings, feeRange, planFee, validateLaunch, validatePlan, type LaunchMode, type LaunchPlan,
} from "@vesk-agent/core";
import { agent } from "../context.js";
import { bold, confirm, dim, fail, ice, sol, up, warn } from "../ui.js";

export async function buy(args: string[], flags: Record<string, string | boolean | undefined>) {
  const [mint, amt] = args;
  if (!mint || !isPubkey(mint) || !amt) fail("Usage: vesk buy <mint> <sol> [--preset p1|p2|p3] [--slippage 15] [--jito 0.001]");
  if (flags.preset !== undefined && !isPresetId(flags.preset)) fail("--preset is p1, p2 or p3 (see `vesk trading`).");
  const a = await agent({ config: flags.config as string | undefined, paper: !!flags.paper });
  const x = isPresetId(flags.preset) ? await a.tradeParams("buy", flags.preset) : null;
  if (x) console.log(`  ${dim("preset")} ${String(flags.preset).toUpperCase()}  ${dim("slippage")} ${x.slippageBps / 100}%  ${dim("priority")} ${x.priorityFeeSol} SOL  ${dim("tip")} ${x.jitoTipSol ?? 0} SOL  ${dim("MEV")} ${x.mev}`);
  const m = await snapshot(a.rpc, mint);
  if (m) console.log(`  ${dim("mcap")} $${fmtK(m.mcapUsd)}  ${dim("liquidity")} ${sol(m.liquiditySol)}  ${dim(m.onCurve ? "on pump.fun curve" : "DEX pool")}`);
  if (!flags.yes && !(await confirm(`  Buy ${sol(Number(amt))} of ${mint.slice(0, 4)}…${mint.slice(-4)}?`))) return;
  const r = await a.executor.buy({ action: "buy", wallet: a.address, mint, amountSol: Number(amt), slippageBps: x?.slippageBps ?? Math.round(Number(flags.slippage ?? 15) * 100), priorityFeeSol: x?.priorityFeeSol, jitoTipSol: x ? x.jitoTipSol : flags.jito ? Number(flags.jito) : undefined, jitoOnly: x?.jitoOnly, venue: "auto", reason: `manual buy${x ? ` · ${String(flags.preset).toUpperCase()}` : ""}` }, mint.slice(0, 4));
  console.log(r.ok ? `  ${up("bought")} in ${r.latencyMs} ms · ${r.signature ?? ""}` : `  ${warn(r.error ?? "failed")}`);
}

export async function sell(args: string[], flags: Record<string, string | boolean | undefined>) {
  const [mint, pctArg] = args;
  if (!mint || !isPubkey(mint)) fail("Usage: vesk sell <mint> <percent|all>");
  const pct = !pctArg || pctArg === "all" ? 100 : Number(pctArg.replace("%", ""));
  if (flags.preset !== undefined && !isPresetId(flags.preset)) fail("--preset is p1, p2 or p3 (see `vesk trading`).");
  const a = await agent({ config: flags.config as string | undefined, paper: !!flags.paper });
  const x = isPresetId(flags.preset) ? await a.tradeParams("sell", flags.preset) : null;
  if (!flags.yes && !(await confirm(`  Sell ${pct}% of ${mint.slice(0, 4)}…${mint.slice(-4)}?`))) return;
  const r = await a.executor.sell({ action: "sell", wallet: a.address, mint, sellPct: pct, ...(x ? { slippageBps: x.slippageBps, priorityFeeSol: x.priorityFeeSol, jitoTipSol: x.jitoTipSol, jitoOnly: x.jitoOnly } : {}), reason: `manual sell${x ? ` · ${String(flags.preset).toUpperCase()}` : ""}` });
  console.log(r.ok ? `  ${up("sold")} for ${sol(r.solDelta ?? 0)} · ${r.signature ?? ""}` : `  ${warn(r.error ?? "failed")}`);
}

export async function launch(flags: Record<string, string | boolean | undefined>) {
  const lp = (flags.launchpad as string | undefined) ?? "pumpfun";
  if (!isLaunchpad(lp)) fail(`Unknown launchpad "${lp}". Ready: ${LAUNCHPADS.filter((l) => l.status === "ready").map((l) => l.id).join(", ")}`);
  const pad = launchpad(lp);
  if (pad.status !== "ready") fail(`${pad.name} is coming soon. ${pad.note}`);
  const imgPath = flags.image as string | undefined;
  if (!imgPath) fail(LAUNCH_USAGE);
  const mode = ((flags.mode as string) ?? "standard") as LaunchMode;
  if (mode !== "standard" && mode !== "manual") fail("--mode is standard or manual.");
  const ext = extname(imgPath).slice(1).toLowerCase();
  const image = { bytes: new Uint8Array(await readFile(imgPath)), mime: `image/${ext === "jpg" ? "jpeg" : ext}`, filename: basename(imgPath) };
  const imgErr = validateLaunch({ name: "xx", symbol: "XX", image, devBuySol: 0 }).filter((e) => /Image|image/.test(e));
  if (imgErr.length) fail(imgErr.join(" "));

  const a = await agent({ config: flags.config as string | undefined });
  const nTeam = Number(flags["team-wallets"] ?? 0);
  let team: LaunchPlan["team"] = null;
  if (nTeam > 0) {
    const active = (await a.wallets()).filter((w) => !w.main && w.active);
    if (active.length < nTeam) fail(`You have ${active.length} active imported wallet${active.length === 1 ? "" : "s"}. Import more with \`vesk wallets import\`.`);
    team = { wallets: active.slice(0, nTeam).map((w) => w.address), solEach: Number(flags["team-sol"] ?? 0.1), disclosed: true };
  }
  const plan: LaunchPlan = {
    launchpad: lp, mode,
    token: {
      name: String(flags.name ?? ""), symbol: String(flags.ticker ?? "").replace(/^\$/, "").toUpperCase(), description: String(flags.desc ?? ""),
      twitter: flags.x as string | undefined, telegram: flags.tg as string | undefined, website: flags.web as string | undefined,
      quote: (findPair(String(flags.quote ?? "SOL"))?.id ?? String(flags.quote ?? "SOL")) as LaunchPlan["token"]["quote"],
      creatorFees: (["holders", "cashback", "split"].includes(String(flags["creator-fees"] ?? flags.fees)) ? (flags["creator-fees"] ?? flags.fees) : "creator") as LaunchPlan["token"]["creatorFees"],
      // v26: 0.05-1% on a custom pair; SOL's fee is fixed by pump.fun, so the flag is refused there
      ...(flags["creator-fee"] !== undefined ? { creatorFeePct: Number(flags["creator-fee"]) } : {}),
      ...(flags.split ? { feeSplit: parseSplit(String(flags.split)) } : {}),
    },
    devBuySol: mode === "manual" ? 0 : Number(flags["dev-buy"] ?? 0),
    // v22: the dev buy is in the create transaction, so no tip or priority fee is needed; both are optional
    jitoTipSol: Number(flags.jito ?? 0),
    priorityFeeSol: Number(flags.priority ?? 0),
    slippagePct: Number(flags.slippage ?? 10),
    team,
  };
  const range = feeRange(pad.caps, plan.token.quote);
  if (flags.quote && !findPair(String(flags.quote))) fail(`--quote: ${flags.quote} isn't in the pair list. \`vesk pairs\` lists them.`);
  const qp = findPair(plan.token.quote);
  if (qp && !pairSelectable(qp)) fail(`--quote: ${qp.id}'s mint isn't verified yet (${STATUS_LABEL[qp.status]}), so it can't be used.`);
  if (flags["creator-fee"] !== undefined && !range) fail(`--creator-fee: on a ${plan.token.quote} pair the creator fee is fixed by ${pad.name}. Pick a custom pair (--quote USDC, NVDAx…) to set it.`);
  const errors = validatePlan(plan);
  if (errors.length) fail(errors.map((e) => `${e.field}: ${e.message}`).join("\n"));
  const s = summarizePlan(plan);
  console.log(`\n  ${bold(plan.token.name)} ${ice("$" + plan.token.symbol)} on ${pad.name} · ${bold(mode === "standard" ? "Standard" : "Manual")}`);
  if (mode === "standard") {
    console.log(`  ${dim("dev buy")}   ${sol(plan.devBuySol)} ${dim(`(~${s.devPct.toFixed(1)}% of supply)`)}  ${dim("slippage")} ${plan.slippagePct}%${s.speedSol ? `  ${dim("tip + priority")} ${sol(s.speedSol)}` : ""}`);
    console.log(dim(launchRoute(plan) === "bundle" ? "  Create + dev buy and the team buys go out as one Jito bundle, in one block." : "  Create + dev buy are one transaction, so your dev buy lands with the create and can't be front-run."));
  } else console.log(dim("  Deploy only. No buying. Buy or sell yourself later."));
  if (range) console.log(`  ${dim("pair")}      ${plan.token.symbol}/${plan.token.quote}  ${dim("creator fee")} ${planFee(pad.caps, plan.token.quote, plan.token.creatorFeePct)}% ${dim(`(${range.min}-${range.max}%, paid in ${plan.token.quote})`)}`);
  if (plan.token.creatorFees === "cashback") console.log(`  ${dim("fees")}      Cashback: creator fees go back to traders`);
  if (plan.token.creatorFees === "split") console.log(`  ${dim("fees")}      split: ${(plan.token.feeSplit ?? []).map((r) => `${r.address.slice(0, 4)}…${r.address.slice(-4)} ${r.pct}%`).join(", ")}`);
  if (range && pad.caps?.feesLock) console.log(dim("  Fee settings lock once the coin is set up."));
  if (team) {
    console.log(`  ${dim("team")}      ${s.teamLine} ${dim(`(${team.solEach} SOL each)`)}`);
    console.log(warn("  Disclosure (added to the coin description and the treasury report):"));
    console.log(`  ${dim(finalDescription(plan).split("\n").pop() ?? "")}`);
  }
  const unv = unverifiedSettings(pad.caps, plan.token.quote, plan.token.creatorFees);
  if (unv.length) console.log(warn(`  Not yet verified on a live launch: ${unv.join(", ")}. If PumpPortal rejects it, nothing is signed or sent.`));
  console.log(`  ${dim("estimated total")} ${sol(s.totalSol)} ${dim(`(buys ${sol(s.buySol)} + launch fee ~${sol(s.launchFeeSol)}${s.speedSol ? ` + tip and priority ${sol(s.speedSol)}` : ""})`)}`);
  if (!flags.yes && !(await confirm("  Launch now?"))) return;
  const r = await a.launch(plan, image, (e) => console.log(`  ${dim(e.step.padEnd(9))} ${e.detail}`));
  console.log(`  ${up("launched")} ${ice(r.mint)}\n  https://pump.fun/coin/${r.mint}\n  ${dim(r.signature)}`);
}

/** v26: "--split <addr>:60,<addr>:40" → recipients and their shares (percent). */
function parseSplit(v: string): Array<{ address: string; pct: number }> {
  return v.split(",").map((x) => x.trim()).filter(Boolean).map((x) => { const [address, pct] = x.split(":"); return { address: address.trim(), pct: Number(pct) }; });
}

export const LAUNCH_USAGE = `Usage: vesk launch --name "Night Owl" --ticker OWL --image ./owl.png [--mode standard|manual] [--dev-buy 0.5]
       [--team-wallets N --team-sol 0.2] [--quote SOL|USDC|NVDAx|…] [--creator-fee 0.05-1] [--creator-fees creator|holders|cashback|split]
       [--split <address>:60,<address>:40]
       [--jito 0.001] [--priority 0.0005] [--slippage 10] [--desc ...] [--x url] [--tg url] [--web url]
       --jito and --priority are optional: the dev buy is part of the create transaction.
       --creator-fee (0.05 to 1, in 0.05 steps, paid in the quote asset) is for custom pairs only; on SOL pump.fun fixes the fee.
       Cashback and a split (up to 10 recipients) are custom-pair settings; all of these lock once the coin is set up.`;
