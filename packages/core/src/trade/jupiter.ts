/**
 * Jupiter swaps (Metis v1 via lite-api; set JUPITER_API_URL for a paid endpoint).
 * Docs: https://dev.jup.ag/docs/swap-api
 */
export const WSOL = "So11111111111111111111111111111111111111112";
const base = () => (process.env.JUPITER_API_URL || "https://lite-api.jup.ag/swap/v1").replace(/\/$/, "");

export interface JupQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  routePlan: unknown[];
  [k: string]: unknown;
}

export async function jupQuote(p: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number }): Promise<JupQuote> {
  const q = new URLSearchParams({ inputMint: p.inputMint, outputMint: p.outputMint, amount: p.amount.toString(), slippageBps: String(p.slippageBps), restrictIntermediateTokens: "true" });
  const r = await fetch(`${base()}/quote?${q}`);
  if (!r.ok) throw new Error(`Jupiter quote failed (${r.status})`);
  return (await r.json()) as JupQuote;
}

/** Returns a base64 VersionedTransaction to sign locally. */
export async function jupSwapTx(p: { quote: JupQuote; userPublicKey: string; priorityFeeSol?: number }): Promise<string> {
  const r = await fetch(`${base()}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: p.quote,
      userPublicKey: p.userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: p.priorityFeeSol ? { priorityLevelWithMaxLamports: { maxLamports: Math.round(p.priorityFeeSol * 1e9), priorityLevel: "veryHigh" } } : "auto",
    }),
  });
  if (!r.ok) throw new Error(`Jupiter swap build failed (${r.status})`);
  const j = (await r.json()) as { swapTransaction?: string };
  if (!j.swapTransaction) throw new Error("Jupiter returned no transaction");
  return j.swapTransaction;
}
