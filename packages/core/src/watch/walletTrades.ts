/**
 * Wallet tracker: live trades of the wallets you track (address book entries marked "track"), from PumpPortal's
 * `subscribeAccountTrade`, and a PnL per wallet built from those trades. PnL only counts trades seen since the
 * tracker started (it can't see a wallet's history), so it's labelled that way in the panel.
 */
export interface WalletTradeMsg { txType?: string; mint?: string; traderPublicKey?: string; solAmount?: number; tokenAmount?: number; marketCapSol?: number; signature?: string; name?: string; symbol?: string }
export interface WalletTrade { at: number; wallet: string; mint: string; side: "buy" | "sell"; sol: number; tokens: number; mcapSol?: number; signature?: string; symbol?: string }
export interface WalletBook { trades: WalletTrade[]; pos: Record<string, Record<string, { tokens: number; costSol: number; realizedSol: number; inSol: number; outSol: number }>> }

export const emptyWalletBook = (): WalletBook => ({ trades: [], pos: {} });
export const accountSubscribe = (wallets: string[]) => ({ method: "subscribeAccountTrade", keys: wallets });
export const WALLET_TRADES_MAX = 500;

/** Apply one trade by a tracked wallet. Average-cost accounting: a sell realizes (proceeds − cost) for the tokens we saw it buy; selling older tokens realizes nothing. */
export function applyWalletTrade(b: WalletBook, m: WalletTradeMsg, now = Date.now()): WalletTrade | null {
  if (!m?.mint || !m.traderPublicKey || (m.txType !== "buy" && m.txType !== "sell")) return null;
  const t: WalletTrade = { at: now, wallet: m.traderPublicKey, mint: m.mint, side: m.txType, sol: Math.abs(m.solAmount ?? 0), tokens: Math.abs(m.tokenAmount ?? 0), mcapSol: m.marketCapSol, signature: m.signature, symbol: m.symbol };
  b.trades.unshift(t);
  if (b.trades.length > WALLET_TRADES_MAX) b.trades.length = WALLET_TRADES_MAX;
  const p = ((b.pos[t.wallet] ??= {})[t.mint] ??= { tokens: 0, costSol: 0, realizedSol: 0, inSol: 0, outSol: 0 });
  if (t.side === "buy") { p.tokens += t.tokens; p.costSol += t.sol; p.inSol += t.sol; }
  else {
    // Only the part of the sell that matches tokens we saw it buy is realized; the rest has an unknown cost.
    const matched = Math.min(t.tokens, p.tokens);
    const cost = p.tokens > 0 ? p.costSol * (matched / p.tokens) : 0;
    p.realizedSol += (t.tokens ? t.sol * (matched / t.tokens) : 0) - cost;
    p.costSol -= cost;
    p.tokens = Math.max(0, p.tokens - t.tokens);
    p.outSol += t.sol;
  }
  return t;
}

/** Per wallet: trades seen, SOL in and out, realized PnL, and how many coins it still holds (of those seen). */
export function walletPnl(b: WalletBook): Array<{ wallet: string; trades: number; inSol: number; outSol: number; realizedSol: number; open: number }> {
  return Object.entries(b.pos).map(([wallet, mints]) => {
    const v = Object.values(mints);
    return { wallet, trades: b.trades.filter((t) => t.wallet === wallet).length, inSol: v.reduce((s, x) => s + x.inSol, 0), outSol: v.reduce((s, x) => s + x.outSol, 0), realizedSol: +v.reduce((s, x) => s + x.realizedSol, 0).toFixed(6), open: v.filter((x) => x.tokens > 0).length };
  }).sort((a, b) => b.realizedSol - a.realizedSol);
}
