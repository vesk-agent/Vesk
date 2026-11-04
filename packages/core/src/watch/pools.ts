/**
 * New-pool detection from program logs (logsSubscribe on your RPC). Pure, so it's tested against log fixtures.
 * 1. `detectNewPool(logs)`: which watched program created a pool/curve in this transaction, from its log lines.
 * 2. `newPoolMint(tx)`: the new coin's mint from the parsed transaction (getTransaction, jsonParsed): the mint in
 *    the post-token balances that isn't a quote (SOL, USDC, USDT, USD1).
 */
import { POOL_PROGRAMS, QUOTE_MINTS, type PoolProgram } from "../data/programs.js";

export interface PoolHit { program: PoolProgram; instruction: string }

const INVOKE = /^Program (\w{32,44}) invoke \[(\d+)\]$/;

/** Walk the log lines, tracking which program is executing, and match its create log line. */
export function detectNewPool(logs: string[], programs: PoolProgram[] = POOL_PROGRAMS): PoolHit | null {
  const byId = new Map(programs.map((p) => [p.id, p]));
  const stack: string[] = [];
  for (const line of logs ?? []) {
    const inv = INVOKE.exec(line);
    if (inv) { stack.length = Number(inv[2]) - 1; stack.push(inv[1]); continue; }
    const done = /^Program (\w{32,44}) (success|failed)/.exec(line);
    if (done) { if (stack[stack.length - 1] === done[1]) stack.pop(); continue; }
    const cur = stack[stack.length - 1];
    const p = cur ? byId.get(cur) : undefined;
    if (!p || !line.startsWith("Program log: ")) continue;
    const msg = line.slice("Program log: ".length);
    const hit = p.create.find((c) => (c.startsWith("Instruction: ") ? msg === c || msg.startsWith(c + " ") : msg.startsWith(c)));
    if (hit) return { program: p, instruction: hit };
  }
  return null;
}

/** The coin in a new pool: a mint in the post-token balances that isn't a quote mint. Null if unclear. */
export function newPoolMint(tx: unknown): { mint: string; quote?: string } | null {
  const t = tx as { meta?: { postTokenBalances?: Array<{ mint?: string }> } } | null;
  const mints = [...new Set((t?.meta?.postTokenBalances ?? []).map((b) => b.mint).filter((m): m is string => !!m))];
  const base = mints.filter((m) => !QUOTE_MINTS[m]);
  const quote = mints.find((m) => QUOTE_MINTS[m]);
  if (base.length !== 1) return null;
  return { mint: base[0], quote: quote ? QUOTE_MINTS[quote] : undefined };
}

/** logsSubscribe request for one program (one subscription per program). */
export const logsSubscribe = (id: number, programId: string) => ({ jsonrpc: "2.0", id, method: "logsSubscribe", params: [{ mentions: [programId] }, { commitment: "confirmed" }] });
