/**
 * v25: burn and lock supply of a coin you launched.
 *
 * Burn is an SPL Token `BurnChecked` from your own token account (the classic Token program or Token-2022, read from
 * the mint's owner), signed by your wallet or agent. It's permanent, so every path (panel, CLI, MCP, chat) shows a plan
 * first and needs an explicit confirmation; every burn goes into the treasury report and, when the coin is run by the
 * agent, into its next public update.
 *
 * Lock is not available yet. The intended venue is Streamflow's token-lock program, but its program ID, account
 * layout and SDK calls can't be verified in this offline build, so nothing here guesses them: `STREAMFLOW` carries
 * `programId: null` and `verified: false`, the adapter refuses to build a transaction, and every surface says "Soon".
 * `LockAdapter` is the typed seam a verified implementation plugs into (tests use a mock adapter).
 *
 * Pure: no network, no web3.js. Shared with the panel and the edge function (scripts/sync-core.mjs).
 */

/** The SPL Token programs (well-known IDs, the same ones the rent cleanup uses). */
export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SPL_TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/** SPL Token instruction index for BurnChecked (same in Token-2022). */
export const BURN_CHECKED = 15;

export const BURN_PCT_CHOICES = [10, 25, 50, 100] as const;
export const BURN_CONFIRM_TEXT = "Burned tokens are gone forever";

export interface BurnInput {
  /** what you hold of the coin, in tokens (UI amount) */
  holding: number;
  decimals: number;
  /** a token amount… */
  tokens?: number;
  /** …or a percentage of your holding (0 < pct ≤ 100) */
  pct?: number;
}
export interface BurnPlan {
  ok: boolean;
  error?: string;
  tokens: number;
  /** base units, as the instruction carries them */
  raw: bigint;
  decimals: number;
  pctOfHolding: number;
  remaining: number;
}

/** Turn "1,000,000" or "25%" into a burn plan against what you hold. Never rounds up past your holding. */
export function burnPlan(i: BurnInput): BurnPlan {
  const bad = (error: string): BurnPlan => ({ ok: false, error, tokens: 0, raw: 0n, decimals: i.decimals, pctOfHolding: 0, remaining: i.holding });
  if (!(i.holding > 0)) return bad("You don't hold any of this coin in this wallet.");
  if (!Number.isInteger(i.decimals) || i.decimals < 0 || i.decimals > 18) return bad("The mint's decimals are out of range.");
  let tokens: number;
  if (i.pct !== undefined) {
    if (!(i.pct > 0) || i.pct > 100) return bad("Pick a percentage above 0 and at most 100.");
    tokens = i.pct === 100 ? i.holding : i.holding * (i.pct / 100);
  } else if (i.tokens !== undefined) {
    if (!(i.tokens > 0)) return bad("Enter an amount above 0.");
    if (i.tokens > i.holding * (1 + 1e-12)) return bad(`That's more than you hold (${fmtTokens(i.holding)}).`);
    tokens = Math.min(i.tokens, i.holding);
  } else return bad("Enter an amount or a percentage.");
  const scale = 10n ** BigInt(i.decimals);
  const holdRaw = toRaw(i.holding, i.decimals);
  let raw = i.pct === 100 ? holdRaw : toRaw(tokens, i.decimals);
  if (raw > holdRaw) raw = holdRaw;
  if (raw <= 0n) return bad("That rounds to nothing at this coin's decimals.");
  const t = Number(raw) / Number(scale);
  return { ok: true, tokens: t, raw, decimals: i.decimals, pctOfHolding: +(100 * t / i.holding).toFixed(4), remaining: Math.max(0, i.holding - t) };
}

/** UI amount → base units, rounding down (a burn never takes more than you asked for). */
export function toRaw(ui: number, decimals: number): bigint {
  // more digits than the mint has, then cut: toFixed alone would round 3.3333339 up to 3.333334
  const [w, f = ""] = ui.toFixed(Math.min(decimals + 4, 20)).split(".");
  return BigInt(w) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/** The BurnChecked instruction data: [15, amount u64 little-endian, decimals u8]. */
export function burnCheckedData(raw: bigint, decimals: number): Uint8Array {
  if (raw <= 0n || raw > 0xffff_ffff_ffff_ffffn) throw new Error("burn amount out of range");
  const d = new Uint8Array(10);
  d[0] = BURN_CHECKED;
  new DataView(d.buffer).setBigUint64(1, raw, true);
  d[9] = decimals;
  return d;
}

/** Accounts for BurnChecked, in the program's order: the token account (w), the mint (w), the owner (signer). */
export function burnCheckedKeys(tokenAccount: string, mint: string, owner: string) {
  return [
    { pubkey: tokenAccount, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: true, isWritable: false },
  ];
}

/** The token program that owns a mint, or an error for anything that isn't an SPL mint. */
export function tokenProgramOf(mintOwner: string): string {
  if (mintOwner === SPL_TOKEN_PROGRAM || mintOwner === SPL_TOKEN_2022_PROGRAM) return mintOwner;
  throw new Error("This mint isn't owned by the SPL Token program or Token-2022.");
}

/** One line for the treasury report and the coin's public updates. */
export function burnDisclosure(symbol: string, tokens: number, signature?: string, pctOfSupply?: number): string {
  return `Burned ${fmtTokens(tokens)} $${symbol.replace(/^\$/, "")}${pctOfSupply !== undefined ? ` (${pctOfSupply.toFixed(2)}% of supply)` : ""} from the dev wallet. Burned tokens are gone for good.${signature && signature !== "paper" ? ` Tx: https://solscan.io/tx/${signature}` : ""}`;
}

export const fmtTokens = (n: number) => (n >= 1e9 ? `${+(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(2)}K` : `${+n.toFixed(4)}`);

// ------------------------------------------------------------------------------------------------------------- lock

export const LOCK_DURATIONS_DAYS = [30, 90, 180, 365] as const;

/**
 * Streamflow's token lock, as far as this build knows it. Nothing is filled in from memory: the program ID and the
 * SDK's create call must be checked against Streamflow's published docs and a devnet run before `verified` flips.
 */
export const STREAMFLOW = {
  name: "Streamflow",
  /** TODO(verify): Streamflow's mainnet program ID, from their docs / SDK constants. Never guessed. */
  programId: null as string | null,
  verified: false,
  docs: "https://docs.streamflow.finance",
} as const;

export interface LockInput { holding: number; decimals: number; tokens?: number; pct?: number; days: number; now?: number }
export interface LockPlan { ok: boolean; error?: string; tokens: number; raw: bigint; days: number; unlockAt: number; pctOfHolding: number }

/** What a lock would hold and until when. Same amount rules as a burn; 1 to 3,650 days, unlocking all at the end. */
export function lockPlan(i: LockInput): LockPlan {
  const b = burnPlan(i);
  const now = i.now ?? Date.now();
  const days = Math.floor(i.days);
  if (!b.ok) return { ok: false, error: b.error, tokens: 0, raw: 0n, days, unlockAt: now, pctOfHolding: 0 };
  if (!(days >= 1 && days <= 3650)) return { ok: false, error: "Pick a lock between 1 day and 10 years.", tokens: 0, raw: 0n, days, unlockAt: now, pctOfHolding: 0 };
  return { ok: true, tokens: b.tokens, raw: b.raw, days, unlockAt: now + days * 86_400_000, pctOfHolding: b.pctOfHolding };
}

/** The seam a verified lock venue implements. `build` returns a base64 transaction for the owner to sign. */
export interface LockAdapter {
  readonly venue: string;
  readonly available: boolean;
  /** why it isn't available, in one sentence */
  readonly reason?: string;
  build(p: { owner: string; mint: string; tokenProgram: string; plan: LockPlan }): Promise<{ txBase64: string; lockId: string }>;
}

export class LockUnavailable extends Error {
  constructor(public readonly venue: string, reason: string) { super(reason); this.name = "LockUnavailable"; }
}

/** The Streamflow adapter scaffold: refuses until its program ID and SDK call are verified. */
export const streamflowLock: LockAdapter = {
  venue: STREAMFLOW.name,
  available: STREAMFLOW.verified && !!STREAMFLOW.programId,
  reason: "Locking isn't available yet: Streamflow's program and SDK call haven't been verified for this build.",
  async build() {
    throw new LockUnavailable(STREAMFLOW.name, "Locking isn't available yet: Streamflow's program and SDK call haven't been verified for this build.");
  },
};

/** One line for the treasury report once a verified lock lands. */
export function lockDisclosure(symbol: string, tokens: number, unlockAt: number, venue: string, signature?: string): string {
  return `Locked ${fmtTokens(tokens)} $${symbol.replace(/^\$/, "")} with ${venue} until ${new Date(unlockAt).toISOString().slice(0, 10)}.${signature ? ` Tx: https://solscan.io/tx/${signature}` : ""}`;
}

/** "25%", "1,000,000", "1.5M" → { pct } or { tokens }. */
export function parseSupplyAmount(s: string): { tokens?: number; pct?: number } | null {
  const t = s.trim().replace(/,/g, "").toLowerCase();
  let m = /^(\d+(?:\.\d+)?)\s*%$/.exec(t);
  if (m) return { pct: +m[1] };
  m = /^(\d+(?:\.\d+)?)\s*([kmb])?$/.exec(t);
  if (m) return { tokens: +m[1] * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : m[2] === "b" ? 1e9 : 1) };
  if (t === "all") return { pct: 100 };
  return null;
}

// ------------------------------------------------------------------------------------------------------------- chat

/** v25: "burn 10% of $DIAL", "burn 5M $DIAL", "lock 20% of $DIAL for 90 days". Nothing runs until you confirm. */
export interface SupplyChat { kind: "burn" | "lock"; symbol?: string; mint?: string; tokens?: number; pct?: number; days?: number; summary: string[] }

export function parseSupplyRequest(text: string): SupplyChat | null {
  const t = text.trim();
  if (t.length > 160) return null;
  const m = /\b(burn|lock)\b\s+(?:(all|everything)|(\d[\d,]*(?:\.\d+)?\s*%|\d[\d,]*(?:\.\d+)?\s*[kmb]?))(?:\s+(?:of|from))?(?:\s+(?:my|the|our))?(?:\s+(?:supply|tokens?|holding|bag))?(?:\s+(?:of|from))?\s*(\$[A-Za-z][A-Za-z0-9]{1,9}|[1-9A-HJ-NP-Za-km-z]{32,44})?/i.exec(t);
  if (!m) return null;
  if (/\b(?:snipe|buy|sell|when\s+@|if\s+@)\b/i.test(t)) return null;
  const kind = m[1].toLowerCase() as "burn" | "lock";
  const amt = m[2] ? { pct: 100 } : parseSupplyAmount(m[3].replace(/\s+/g, ""));
  if (!amt) return null;
  const coin = m[4];
  const sym = coin?.startsWith("$") ? coin.slice(1).toUpperCase() : undefined;
  const mint = coin && !coin.startsWith("$") ? coin : undefined;
  if (!sym && !mint) return null; // "burn" alone is ambiguous: name the coin
  const days = kind === "lock" ? Number(/\bfor\s+(\d{1,4})\s*(?:d|days?)\b/i.exec(t)?.[1] ?? (/\bfor\s+(\d{1,2})\s*(?:mo|months?)\b/i.exec(t)?.[1] ? Number(/\bfor\s+(\d{1,2})\s*(?:mo|months?)\b/i.exec(t)![1]) * 30 : 90)) : undefined;
  const what = amt.pct !== undefined ? `${amt.pct}% of what you hold` : fmtTokens(amt.tokens!);
  const who = sym ? `$${sym}` : `${mint!.slice(0, 4)}…${mint!.slice(-4)}`;
  const summary = kind === "burn"
    ? [`Burn: ${what} of ${who}, from your wallet`, `${BURN_CONFIRM_TEXT}. Disclosed in the treasury report.`]
    : [`Lock: ${what} of ${who} for ${days} days`, "Locking isn't available yet (Soon). Nothing will be sent."];
  return { kind, symbol: sym, mint, ...amt, days, summary };
}
