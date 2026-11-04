/**
 * Known exchange hot wallets on Solana, for the "funded exchange" audit: when a dev's (or holder's) funding wallet
 * is one of these, Pulse shows the label instead of an address. Labels come from public explorer tags (Solscan,
 * Solana FM) as we know them; they can be wrong or go stale, so the UI says "labelled" and you can add or fix
 * entries here. Never used to accuse anyone; only to show where the SOL came from.
 */
export const EXCHANGE_WALLETS: Record<string, string> = {
  "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhJ8HjVk": "Binance",
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM": "Binance",
  H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS: "Coinbase",
  GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE: "Coinbase",
  FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5: "Kraken",
  "5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD": "OKX",
  AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2: "Bybit",
  ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ: "MEXC",
  BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6: "KuCoin",
  u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w: "Gate.io",
};

export const exchangeOf = (address?: string): string | undefined => (address ? EXCHANGE_WALLETS[address] : undefined);
