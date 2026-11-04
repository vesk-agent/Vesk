/**
 * Recover rent: close your empty token accounts (balance 0) and get their rent deposit back
 * (about 0.00204 SOL each for a classic SPL account). Only empty accounts, only your own wallet,
 * shown to you before anything is signed.
 */
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/** Close instructions per transaction (keeps each transaction well under the size limit). */
export const CLOSE_PER_TX = 20;

export interface EmptyAccount {
  account: string;
  mint: string;
  program: string;
  lamports: number;
}

export interface RentPlan {
  accounts: EmptyAccount[];
  batches: EmptyAccount[][];
  totalSol: number;
}

export function planRentRecovery(accounts: EmptyAccount[], opts: { keepMints?: string[] } = {}): RentPlan {
  const keep = new Set(opts.keepMints ?? []);
  const list = accounts.filter((a) => !keep.has(a.mint));
  const batches: EmptyAccount[][] = [];
  for (let i = 0; i < list.length; i += CLOSE_PER_TX) batches.push(list.slice(i, i + CLOSE_PER_TX));
  return { accounts: list, batches, totalSol: +(list.reduce((s, a) => s + a.lamports, 0) / 1e9).toFixed(6) };
}

/** SPL Token CloseAccount instruction data (index 9, no arguments). Same for Token-2022. */
export const CLOSE_ACCOUNT_DATA = Uint8Array.of(9);
