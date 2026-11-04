/**
 * The honeypot / can-sell check (v19), pure part: what a mint account says about selling, and the verdict.
 * On Solana a token can stop you selling in a few concrete ways, all visible on the mint account:
 *  - a freeze authority (classic SPL or Token-2022): the issuer can freeze your token account;
 *  - Token-2022 extensions: a transfer hook (the issuer's program runs on every transfer and can fail it), a permanent
 *    delegate (can move or burn anyone's tokens), non-transferable, default account state frozen, a paused mint;
 *  - a transfer fee (Token-2022): a tax on every transfer, buys and sells included.
 * The I/O part (strategy/canSell.ts) reads the mint and simulates a real sell from a current holder.
 */
import type { HoneypotSettings } from "./settings.js";

export interface MintRisks {
  program: "spl-token" | "spl-token-2022" | "other";
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** Transfer fee in basis points (0 = none). */
  transferFeeBps: number;
  transferHook: string | null;
  permanentDelegate: string | null;
  nonTransferable: boolean;
  defaultFrozen: boolean;
  /** Pausable mint: true when paused, false when it can be paused but isn't, null without the extension. */
  paused: boolean | null;
}

type Ext = { extension?: string; state?: Record<string, unknown> };
const s = (v: unknown) => (typeof v === "string" && v ? v : null);

/** Parse a jsonParsed getAccountInfo result (or its `value`) for a mint. null when it isn't a mint. */
export function mintRisks(acc: unknown): MintRisks | null {
  const v = ((acc as { value?: unknown })?.value ?? acc) as { owner?: string; data?: { program?: string; parsed?: { type?: string; info?: Record<string, unknown> } } } | null;
  const info = v?.data?.parsed?.info;
  if (!v || !info || (v.data?.parsed?.type && v.data.parsed.type !== "mint")) return null;
  const prog = v.data?.program === "spl-token-2022" || v.owner === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" ? "spl-token-2022" : v.data?.program === "spl-token" || v.owner === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" ? "spl-token" : "other";
  const ext = (Array.isArray(info.extensions) ? info.extensions : []) as Ext[];
  const find = (n: string) => ext.find((e) => e.extension === n);
  const fee = find("transferFeeConfig")?.state as { newerTransferFee?: { transferFeeBasisPoints?: number }; olderTransferFee?: { transferFeeBasisPoints?: number } } | undefined;
  const das = find("defaultAccountState")?.state as { accountState?: string } | undefined;
  const pause = find("pausableConfig")?.state as { paused?: boolean } | undefined;
  return {
    program: prog,
    mintAuthority: s(info.mintAuthority), freezeAuthority: s(info.freezeAuthority),
    transferFeeBps: Math.max(Number(fee?.newerTransferFee?.transferFeeBasisPoints ?? 0), Number(fee?.olderTransferFee?.transferFeeBasisPoints ?? 0)) || 0,
    transferHook: s((find("transferHook")?.state as { programId?: unknown } | undefined)?.programId),
    permanentDelegate: s((find("permanentDelegate")?.state as { delegate?: unknown } | undefined)?.delegate),
    nonTransferable: !!find("nonTransferable"),
    defaultFrozen: das?.accountState === "frozen",
    paused: find("pausableConfig") ? !!pause?.paused : null,
  };
}

export interface SellSim {
  /** A sell route exists (Jupiter quote for token → SOL). */
  route: boolean;
  /** A holder's sell was simulated. */
  simulated: boolean;
  ok?: boolean;
  error?: string;
  holder?: string;
}
export interface HoneypotVerdict { ok: boolean; reason?: string; notes: string[] }

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** The verdict from the mint's risks and (optionally) a simulated sell. The first refusal wins. */
export function honeypotVerdict(c: HoneypotSettings, r: MintRisks, sell?: SellSim): HoneypotVerdict {
  const notes: string[] = [];
  const no = (reason: string): HoneypotVerdict => ({ ok: false, reason, notes });
  if (c.refuseNonTransferable && r.nonTransferable) return no("can't sell: the token is non-transferable");
  if (r.paused === true) return no("can't sell: transfers are paused by the issuer");
  if (c.refuseDefaultFrozen && r.defaultFrozen) return no("can't sell: new token accounts start frozen");
  if (c.refuseTransferHook && r.transferHook) return no(`transfer hook (program ${short(r.transferHook)}) can block sells`);
  if (c.refusePermanentDelegate && r.permanentDelegate) return no(`permanent delegate ${short(r.permanentDelegate)} can take tokens from any wallet`);
  if (c.refuseFreezeAuthority && r.freezeAuthority) return no("freeze authority set: the issuer can freeze your tokens");
  const tax = r.transferFeeBps / 100;
  if (tax > c.maxTaxPct) return no(`transfer tax ${tax % 1 ? tax.toFixed(2) : tax}% (max ${c.maxTaxPct}%)`);
  if (tax > 0) notes.push(`transfer tax ${tax}%`);
  if (r.paused === false) notes.push("pausable mint (not paused)");
  if (sell) {
    if (!sell.route) return no("can't sell: no sell route (Jupiter has no quote back to SOL)");
    if (sell.simulated && sell.ok === false) return no(`can't sell: a holder's sell failed in simulation${sell.error ? ` (${sell.error})` : ""}`);
    if (!sell.simulated) notes.push("sell not simulated: no holder wallet to simulate from yet");
    else notes.push("a holder's sell simulated fine");
  }
  return { ok: true, notes };
}

/** pump.fun coins are minted by the pump.fun program with no freeze authority and no extensions: the check skips them. */
export const isPumpMint = (mint: string, protocol?: string) => protocol === "pumpfun" || (protocol === undefined && mint.endsWith("pump"));
