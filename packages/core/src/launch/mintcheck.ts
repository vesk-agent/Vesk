/**
 * v26: runtime safety for custom pairs. Before any create on a non-SOL pair, the quote mint is read on chain through
 * your RPC: the account must exist, be owned by the SPL Token or Token-2022 program, be an initialized mint with
 * readable decimals, and match the decimals the registry expects when it knows them. Any failure refuses the create
 * before anything is built or signed, with the reason. A passing check is cached (10 minutes) and makes the pair show
 * "Verified on-chain". The freeze authority is read and reported ("the issuer can freeze"): regulated issuers
 * (stablecoins, stocks) usually keep one, so it is disclosed in the plan rather than refused.
 * Shared by the agent and the hosted backend (both pass their own RPC).
 */
import { SPL_TOKEN_2022_PROGRAM, SPL_TOKEN_PROGRAM } from "../coin/supply.js";

export interface MintReader { getAccountInfo(address: string, encoding: "base64" | "jsonParsed"): Promise<unknown> }
export interface MintFacts { program: "spl-token" | "spl-token-2022"; decimals: number; supply?: string; name?: string; /** v26: null = none */ freezeAuthority?: string | null; mintAuthority?: string | null }
export type MintCheck = ({ ok: true } & MintFacts) | { ok: false; reason: string };

type Parsed = { owner?: string; data?: { program?: string; parsed?: { type?: string; info?: { decimals?: number; isInitialized?: boolean; supply?: string; freezeAuthority?: string | null; mintAuthority?: string | null; extensions?: Array<{ extension?: string; state?: { name?: string; symbol?: string } }> } } } } | null;

/** Read a getAccountInfo(jsonParsed) value as a mint. Pure, for tests and the hosted backend. */
export function mintFactsOf(v: unknown): MintCheck {
  const a = v as Parsed;
  if (!a) return { ok: false, reason: "no account at that address" };
  if (a.owner !== SPL_TOKEN_PROGRAM && a.owner !== SPL_TOKEN_2022_PROGRAM) return { ok: false, reason: "not owned by the SPL Token or Token-2022 program" };
  const p = a.data?.parsed;
  if (!p || p.type !== "mint") return { ok: false, reason: "the account isn't a token mint" };
  if (p.info?.isInitialized === false) return { ok: false, reason: "the mint isn't initialized" };
  if (typeof p.info?.decimals !== "number") return { ok: false, reason: "the mint's decimals couldn't be read" };
  const meta = p.info.extensions?.find((e) => e.extension === "tokenMetadata")?.state;
  return {
    ok: true, program: a.owner === SPL_TOKEN_2022_PROGRAM ? "spl-token-2022" : "spl-token", decimals: p.info.decimals, supply: p.info.supply,
    freezeAuthority: p.info.freezeAuthority ?? null, mintAuthority: p.info.mintAuthority ?? null, ...(meta?.name ? { name: meta.name } : {}),
  };
}

const cache = new Map<string, { at: number; r: MintCheck }>();
const TTL = 10 * 60_000;

/** Check a quote mint on chain. `expect.decimals` (when the registry knows them) must match. Cached 10 minutes when the read succeeds. */
export async function verifyQuoteMint(rpc: MintReader, mint: string, expect: { decimals?: number; symbol?: string } = {}): Promise<MintCheck> {
  const hit = cache.get(mint);
  let r: MintCheck;
  if (hit && Date.now() - hit.at < TTL) r = hit.r;
  else {
    try {
      const v = await rpc.getAccountInfo(mint, "jsonParsed");
      r = mintFactsOf((v as { value?: unknown })?.value !== undefined ? (v as { value?: unknown }).value : v);
    } catch (e) {
      return { ok: false, reason: `couldn't read the mint through your RPC (${(e as Error).message})` };
    }
    if (r.ok) cache.set(mint, { at: Date.now(), r });
  }
  return judgeMint(r, expect);
}

/** Apply the registry's expectations to a read mint (pure; also used by the hosted backend and the tests). */
export function judgeMint(r: MintCheck, expect: { decimals?: number } = {}): MintCheck {
  if (!r.ok) return r;
  if (expect.decimals !== undefined && r.decimals !== expect.decimals) return { ok: false, reason: `decimals are ${r.decimals}, expected ${expect.decimals}` };
  return r;
}

export const clearMintCache = () => cache.clear();

/** One line for logs and refusals: "NVDAx quote mint checked on chain: Token-2022, 8 decimals". */
export const mintLine = (symbol: string, c: MintCheck) => (c.ok ? `${symbol} quote mint checked on chain: ${c.program === "spl-token-2022" ? "Token-2022" : "SPL Token"}, ${c.decimals} decimals${c.freezeAuthority ? ", the issuer can freeze it" : ""}` : `${symbol} quote mint refused: ${c.reason}`);

/** v26: the picker's status line for a pair: what the last on-chain check said, or that it runs before launch. */
export interface PairCheck { mint: string; ok: boolean; reason?: string; program?: MintFacts["program"]; decimals?: number; freezeAuthority?: string | null; at: number }
export const pairCheckOf = (mint: string, c: MintCheck, at = Date.now()): PairCheck =>
  c.ok ? { mint, ok: true, program: c.program, decimals: c.decimals, freezeAuthority: c.freezeAuthority ?? null, at } : { mint, ok: false, reason: c.reason, at };
