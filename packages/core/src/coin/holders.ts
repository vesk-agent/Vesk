/**
 * Holder breakdown for a coin's Workspace: Dev, Team (disclosed), Pool and Others, top 10.
 * Input is the RPC's getTokenLargestAccounts resolved to owners. Classification only uses what is
 * public and what you disclosed: your creator wallet, your disclosed team wallets and known pool/curve accounts.
 */
export type HolderKind = "dev" | "team" | "pool" | "other";

export interface HolderRow {
  owner: string;
  tokens: number;
  pct: number;
  kind: HolderKind;
  label?: string;
}

export interface HolderBreakdown {
  top: HolderRow[];
  byKind: Record<HolderKind, { tokens: number; pct: number; count: number }>;
  /** Share of supply held by the 10 largest non-pool holders. */
  top10Pct: number;
}

export function classifyHolders(rows: Array<{ owner: string; tokens: number }>, ctx: { supply: number; dev?: string; team?: string[]; pools?: string[]; labels?: Record<string, string>; limit?: number }): HolderBreakdown {
  const team = new Set(ctx.team ?? []);
  const pools = new Set(ctx.pools ?? []);
  const kindOf = (o: string): HolderKind => (o === ctx.dev ? "dev" : team.has(o) ? "team" : pools.has(o) ? "pool" : "other");
  const merged = new Map<string, number>();
  for (const r of rows) merged.set(r.owner, (merged.get(r.owner) ?? 0) + r.tokens);
  const all = [...merged.entries()].map(([owner, tokens]) => ({ owner, tokens, pct: ctx.supply > 0 ? (tokens / ctx.supply) * 100 : 0, kind: kindOf(owner), label: ctx.labels?.[owner] }))
    .sort((a, b) => b.tokens - a.tokens);
  const byKind = { dev: { tokens: 0, pct: 0, count: 0 }, team: { tokens: 0, pct: 0, count: 0 }, pool: { tokens: 0, pct: 0, count: 0 }, other: { tokens: 0, pct: 0, count: 0 } };
  for (const r of all) {
    byKind[r.kind].tokens += r.tokens;
    byKind[r.kind].pct += r.pct;
    byKind[r.kind].count++;
  }
  const top10Pct = all.filter((r) => r.kind !== "pool").slice(0, 10).reduce((s, r) => s + r.pct, 0);
  return { top: all.slice(0, ctx.limit ?? 10), byKind, top10Pct };
}
