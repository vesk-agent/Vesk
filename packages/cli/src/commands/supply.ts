/**
 * vesk burn / vesk lock (v25): supply of a coin this agent launched.
 *
 *   vesk burn <mint|$TICKER> <amount|N%|all> [--yes] [--json]
 *       Shows the plan (what you hold, what burns, what's left), asks "Burned tokens are gone forever. Burn …?", then
 *       sends one SPL BurnChecked from your wallet through the guardrails. The burn goes into the treasury report and,
 *       when the agent runs the coin, into its next public update.
 *   vesk lock <mint|$TICKER> <amount|N%> --days 90 [--json]
 *       Shows what a lock would hold and until when. Locking isn't available yet (Soon): Streamflow's program and SDK
 *       call aren't verified for this build, so nothing is sent (exit code 2).
 */
import { BURN_CONFIRM_TEXT, fmtTokens, parseSupplyAmount, type Agent } from "@vesk-agent/core";
import { agent } from "../context.js";
import { bold, confirm, dim, down, fail, ice, json, up, warn } from "../ui.js";

type Flags = Record<string, string | boolean | undefined>;

export async function burn(args: string[], f: Flags, existing?: Agent) {
  const [coin, amount] = args;
  if (!coin || !amount) fail("Usage: vesk burn <mint|$TICKER> <amount|N%|all> [--yes]");
  const sel = parseSupplyAmount(amount);
  if (!sel) fail(`"${amount}" isn't an amount. Use 1000000, 1.5M, 25% or all.`);
  const a = existing ?? (await agent({ config: f.config as string | undefined, paper: !!f.paper }));
  const pick = coin.startsWith("$") || coin.length < 20 ? { symbol: coin } : { mint: coin };
  const p = await a.burnSupply({ ...pick, ...sel, confirm: false, planOnly: true });
  if (!p.ok || !p.plan || !p.coin) fail(p.error ?? "Can't plan this burn.");
  const { plan, coin: c } = p;
  if (!f.json) {
    console.log(bold(`\n  Burn $${c.symbol}`));
    console.log(`  ${dim("you hold")}   ${fmtTokens(plan.tokens + plan.remaining)}`);
    console.log(`  ${dim("burn")}       ${ice(fmtTokens(plan.tokens))} ${dim(`(${plan.pctOfHolding.toFixed(2)}% of your holding)`)}`);
    console.log(`  ${dim("left")}       ${fmtTokens(plan.remaining)}`);
    console.log(`  ${dim("from")}       ${a.address.slice(0, 4)}…${a.address.slice(-4)} ${dim("· one BurnChecked · disclosed in the treasury report")}`);
  }
  if (!f.yes) {
    if (f.json) fail("--json needs --yes for a burn (it's permanent).");
    if (!(await confirm(`\n  ${warn(BURN_CONFIRM_TEXT + ".")} Burn ${fmtTokens(plan.tokens)} $${c.symbol}?`))) return console.log(dim("  Nothing was burned."));
  }
  const r = await a.burnSupply({ mint: c.mint, ...(sel.pct === 100 ? { pct: 100 } : { tokens: plan.tokens }), confirm: true });
  if (f.json) return void json(r.ok ? { ok: true, mint: c.mint, symbol: c.symbol, tokens: r.plan?.tokens, signature: r.signature, disclosure: r.disclosure } : { ok: false, error: r.error });
  if (!r.ok) return console.log(`  ${down("not burned")} ${r.error}`);
  console.log(`  ${up("burned")} ${fmtTokens(r.plan!.tokens)} $${c.symbol} ${dim(r.signature ?? "")}`);
  console.log(dim(`  In your treasury report${r.disclosure ? " and the coin's next update" : ""}: ${r.disclosure}`));
}

export async function lock(args: string[], f: Flags, existing?: Agent) {
  const [coin, amount] = args;
  if (!coin || !amount) fail("Usage: vesk lock <mint|$TICKER> <amount|N%> --days 90");
  const sel = parseSupplyAmount(amount);
  if (!sel) fail(`"${amount}" isn't an amount. Use 1000000, 1.5M or 25%.`);
  const days = Number(f.days ?? 90);
  const a = existing ?? (await agent({ config: f.config as string | undefined, paper: true }));
  const pick = coin.startsWith("$") || coin.length < 20 ? { symbol: coin } : { mint: coin };
  const r = await a.lockSupply({ ...pick, ...sel, days });
  if (f.json) { json({ ok: false, soon: true, error: r.error, plan: r.plan ? { tokens: r.plan.tokens, days: r.plan.days, unlockAt: new Date(r.plan.unlockAt).toISOString() } : null }); process.exitCode = 2; return; }
  if (r.plan?.ok && r.coin) {
    console.log(bold(`\n  Lock $${r.coin.symbol}`) + dim("  (Soon)"));
    console.log(`  ${dim("lock")}       ${fmtTokens(r.plan.tokens)} ${dim(`(${r.plan.pctOfHolding.toFixed(2)}% of your holding)`)}`);
    console.log(`  ${dim("until")}      ${new Date(r.plan.unlockAt).toISOString().slice(0, 10)} ${dim(`(${r.plan.days} days, all at the end)`)}`);
  }
  console.log(`  ${warn("not available yet")} ${r.error}`);
  process.exitCode = 2;
}
