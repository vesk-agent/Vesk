import { defineConfig } from "@vesk-agent/core";

export default defineConfig({
  rpc: { url: process.env.HELIUS_RPC_URL ?? "https://api.mainnet-beta.solana.com", priorityFeeSol: 0.0005 },
  model: { provider: "anthropic", model: "" },
  x: { source: "official-api", bearerTokenEnv: "X_BEARER_TOKEN", pollIntervalSec: 15 },
  launches: { enabled: true },
  limits: { perTradeMaxSol: 0.25, dailySpendCapSol: 1, maxOpenPositions: 6, maxBuysPerDay: 10 },
  watchlist: [
    { handle: "alpha_calls", enabled: true, mode: "ca-in-post", amountSol: 0.25, maxMcapUsd: 50_000, slippageBps: 1500, takeProfit: [{ atMultiple: 3, sellPct: 50 }], stopLossPct: 30, maxBuysPerDay: 3 },
  ],
});
