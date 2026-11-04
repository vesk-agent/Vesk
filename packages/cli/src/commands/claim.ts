/**
 * vesk claim (v23): creator fees from coins this agent launched.
 *
 *   vesk claim [--json]                     what you launched, by pair, and what you've claimed; then asks to claim
 *   vesk claim --all [--yes]                claim everything: one claim per asset (SOL and each custom pair) and wallet
 *   vesk claim <mint|$TICKER>               one coin (and whatever else the same claim collects)
 *
 * SOL-pair claims are PumpPortal's collectCreatorFee (tested). Custom-pair claims add the quote field ("verify on first
 * live launch", capabilities.ts); v26: fees arrive in the quote asset and stay in it. Every claim goes through the
 * executor's guardrails. Coins whose creator rewards go to holders have nothing to claim and are listed as such.
 */
import { claimGroups, claimVerified, launchpad, PUMPFUN_CAPS, type Agent, type QuoteAsset } from "@vesk-agent/core";
import { agent } from "../context.js";
import { bold, confirm, dim, down, fail, ice, json, table, up, warn } from "../ui.js";

type Flags = Record<string, string | boolean | undefined>;
const amt = (n: number, asset: string) => (asset === "SOL" ? `${n.toFixed(n >= 1 ? 3 : 4)} SOL` : `${n.toFixed(2)} ${asset}`);

/** `existing`: chat ("claim my fees") passes the agent it already unlocked. */
export async function claim(args: string[], f: Flags, existing?: Agent) {
  const a = existing ?? (await agent({ config: f.config as string | undefined, paper: false }));
  const rows = a.creatorFeeRows();
  const target = args[0];
  const pick = target ? rows.filter((r) => r.mint === target || `$${r.symbol}`.toUpperCase() === target.toUpperCase() || r.symbol.toUpperCase() === target.toUpperCase()) : rows;
  const groups = claimGroups(pick);

  if (!f.all && !target && !f.yes && json({ rows, groups })) return;
  if (!rows.length) return console.log(dim("  No coins launched from this agent yet. Coins you launch with `vesk launch` (or from the panel through this agent) show here."));
  if (target && !pick.length) fail(`${target} isn't one of the coins this agent launched. \`vesk claim\` lists them.`);

  table(pick.map((r) => ({
    coin: `$${r.symbol}`, pair: `${r.symbol}/${r.quote}`, launchpad: launchpad(r.launchpad as never).name,
    fees: r.mode === "holders" ? "to holders" : "to you",
    claimed: r.claimedTotal ? amt(r.claimedTotal, r.quote) : "–", last: r.lastClaimedAt ? r.lastClaimedAt.slice(0, 16).replace("T", " ") : "never",
  })), undefined, ["claimed"]);
  if (pick.some((r) => r.mode === "holders")) console.log(dim("  Coins with rewards to holders have nothing to claim."));
  if (!groups.length) return console.log(dim("  Nothing to claim here."));

  console.log(bold(`\n  ${groups.length} claim${groups.length === 1 ? "" : "s"}, by asset:`));
  for (const g of groups) {
    const unv = !claimVerified(g.asset as QuoteAsset, PUMPFUN_CAPS);
    console.log(`  ${ice("·")} ${g.asset.padEnd(5)} ${g.symbols.map((s) => `$${s}`).join(", ")} ${dim(`from ${g.creator.slice(0, 4)}…${g.creator.slice(-4)}`)}${unv ? warn("  verify on first live claim") : ""}`);
  }
  console.log(dim("  Unclaimed amounts aren't reported to the agent: each claim collects what's there and says how much arrived."));
  if (f.json && !f.yes) return void json({ rows, groups });
  if (!(f.yes || (await confirm("\n  Claim now?")))) return;

  const done = await a.claimFees({ mint: target && pick.length === 1 ? pick[0].mint : undefined, symbol: target && pick.length !== 1 ? target : undefined });
  for (const r of done) {
    if (!r.ok) { console.log(`  ${down("failed")} ${r.group.asset}: ${r.error}`); continue; }
    console.log(`  ${up("claimed")} ${amt(r.amount, r.asset)}${r.asset !== "SOL" && r.sol ? dim(` (≈ ${r.sol.toFixed(4)} SOL)`) : ""} ${dim(r.signature ?? "")}`);
  }
  await a.state.save();
  if (f.json) json({ claims: done });
}
