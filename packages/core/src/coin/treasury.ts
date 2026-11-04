/**
 * The treasury report: every team buy, dev sell, fee claim, buyback and burn for coins this agent launched,
 * each with its transaction. Pure function, so the CLI (`vesk treasury`), the panel and the coin manager
 * print the same lines.
 */
/** Same shape as state.ts TreasuryEntry (kept local so the panel can share this file). */
export interface TreasuryRecord {
  at: number;
  kind: "claim" | "buyback" | "burn" | "team" | "dev-sell";
  mint: string;
  wallets?: string[];
  sol?: number;
  tokens?: number;
  signature?: string;
  disclosedAt?: string;
  /** v23, claims: the asset the fees were paid in and the amount in it (older entries: SOL, in `sol`). */
  asset?: string;
  amount?: number;
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const tx = (s?: string) => (s && s !== "paper" ? ` Tx: https://solscan.io/tx/${s}` : "");
const k = (n: number) => (n >= 1e9 ? `${+(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : `${+n.toFixed(2)}`);

export interface TreasurySummary {
  mint: string;
  symbol: string;
  lines: string[];
  totals: { teamSol: number; devSoldSol: number; devSoldTokens: number; claimedSol: number; buybackSol: number; burnedTokens: number };
}

/**
 * `names` (local display only, e.g. the CLI): your private wallet names, shown after each team address as
 * "Wallet 2 · Team". Reports that get posted are built without it, so they carry addresses only.
 */
export function treasuryReport(entries: TreasuryRecord[], symbols: Record<string, string> = {}, mint?: string, names?: Map<string, string>): TreasurySummary[] {
  const mints = [...new Set(entries.filter((e) => !mint || e.mint === mint).map((e) => e.mint))];
  return mints.map((m) => {
    const es = entries.filter((e) => e.mint === m).sort((a, b) => a.at - b.at);
    const sym = symbols[m] ?? short(m);
    const sum = (kind: TreasuryRecord["kind"], f: "sol" | "tokens") => es.filter((e) => e.kind === kind).reduce((s, e) => s + (e[f] ?? 0), 0);
    const lines = es.map((e) => {
      const at = new Date(e.at).toISOString().replace("T", " ").slice(0, 19) + " UTC";
      switch (e.kind) {
        case "team": return `${at}  Team wallets bought ${(e.sol ?? 0).toFixed(4)} SOL in the launch bundle (disclosed): ${(e.wallets ?? []).map((a) => (names?.get(a) ? `${a} (${names.get(a)} · Team)` : a)).join(", ")}.${tx(e.signature)}`;
        case "dev-sell": return `${at}  Dev wallet sold ${e.tokens ? `${k(e.tokens)} tokens ` : ""}for ${(e.sol ?? 0).toFixed(4)} SOL.${tx(e.signature)}`;
        case "claim": return e.asset && e.asset !== "SOL" ? `${at}  Claimed ${(e.amount ?? 0).toFixed(2)} ${e.asset} in creator fees.${tx(e.signature)}` : `${at}  Claimed ${(e.sol ?? 0).toFixed(4)} SOL in creator fees.${tx(e.signature)}`;
        case "buyback": return `${at}  Bought back ${(e.sol ?? 0).toFixed(4)} SOL of $${sym} from the disclosed project wallet.${tx(e.signature)}`;
        case "burn": return `${at}  Burned ${k(e.tokens ?? 0)} tokens.${tx(e.signature)}`;
      }
    });
    return {
      mint: m, symbol: sym, lines,
      totals: { teamSol: sum("team", "sol"), devSoldSol: sum("dev-sell", "sol"), devSoldTokens: sum("dev-sell", "tokens"), claimedSol: sum("claim", "sol"), buybackSol: sum("buyback", "sol"), burnedTokens: sum("burn", "tokens") },
    };
  });
}
