import { BRAND } from "./brand.js";
/**
 * $VESK holder access for the HOSTED panel and API. The open-source agent (CLI, Telegram, MCP) is free and
 * MIT, and is never gated. Ownership is proven by signing a one-time message with the wallet (Sign-In-With-
 * Solana style), verified server-side with ed25519. Vesk never asks for a private key to check access.
 */

/** Default threshold. Set VESK_GATE_MIN to change it (e.g. 1,000,000). */
export const VESK_GATE_MIN_DEFAULT = 500_000;
/** How often the server re-checks balances (minutes). */
export const GATE_RECHECK_MIN = 10;

export function signInMessage(p: { domain: string; address: string; nonce: string; issuedAt: string; accountId: string }): string {
  return [
    `${p.domain} wants you to sign in with your Solana account:`,
    p.address,
    "",
    `Link this wallet to your ${BRAND.name} panel to verify ${BRAND.token} holder access. This signature does not move funds or give access to your wallet.`,
    "",
    `URI: https://${p.domain}`,
    "Version: 1",
    "Chain ID: mainnet",
    `Nonce: ${p.nonce}`,
    `Issued At: ${p.issuedAt}`,
    `Resources:`,
    `- vesk:account:${p.accountId}`,
  ].join("\n");
}

export interface AccessState {
  enabled: boolean;
  /** Raw token units summed across linked wallets and the hosted vault. */
  held: number;
  min: number;
  ok: boolean;
  checkedAt?: string;
}

export function accessState(o: { mint?: string | null; min?: number; balances: number[]; checkedAt?: string }): AccessState {
  const min = o.min && o.min > 0 ? o.min : VESK_GATE_MIN_DEFAULT;
  if (!o.mint) return { enabled: false, held: 0, min, ok: true, checkedAt: o.checkedAt };
  const held = o.balances.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  return { enabled: true, held, min, ok: held >= min, checkedAt: o.checkedAt };
}

/** Actions that always work, gate or not: reading your data, access itself, and getting your funds out. */
export const GATE_EXEMPT = new Set([
  "me", "logout", "overview", "logs", "rules", "watchlist", "launches", "wallets", "connections", "limits", "chat-history", "launch-rules", "launch-pending",
  "presets", "tracker-feed", "tracker-groups", "access-status", "access-nonce", "access-verify", "access-unlink", "access-refresh",
  "hosted-withdraw", "hosted-export", "wallets-return", "kill-switch", "agent-pause", "agent-unpair", "set-mode",
  // v6: reading your address book and coin data, sending your tokens out, and recovering rent are "your data and your funds".
  "book", "book-save", "book-import", "workspace", "launch-archive", "send-tokens", "rent-plan", "rent-recover", "relay-status", "x-source-save",
  // v8: reading your own trading presets and Pulse settings.
  "trading", "pulse-settings", "panel-settings", "panel-settings-save", "blacklist", "blacklist-save", "migration-orders",
  // v10: reading your copy settings and feed, and saving them (so you can always switch copying off).
  "copy-config", "copy-config-save", "copy-feed",
]);

/** When access is checked. Shown in the panel next to "Re-check now". */
export const ACCESS_RECHECK_NOTE = `Checked when you sign in, on every session refresh, every ${GATE_RECHECK_MIN} minutes, and when you press Re-check now.`;

/** The one wording for access, used by the panel, the API errors and the docs. */
export function accessCopy(a: AccessState, fmt: (n: number) => string = (n) => n.toLocaleString("en-US")): { title: string; body: string; keeps: string[] } {
  const keeps = ["Your data and history", "Withdrawals (SOL and tokens)", "Exports", "The kill switch"];
  if (!a.enabled) return { title: "Open access", body: "Holder access isn't switched on for this panel.", keeps };
  if (a.ok) return { title: "Access active", body: `Your linked wallets hold ${fmt(a.held)} ${BRAND.token} (minimum ${fmt(a.min)}).`, keeps };
  return {
    title: "Access removed",
    body: `Your linked wallets hold ${fmt(a.held)} of the ${fmt(a.min)} ${BRAND.token} needed, so access is removed: hosted panel features, the API, your rules and your automations are stopped. It comes back on its own as soon as your balance is back to ${fmt(a.min)}.`,
    keeps,
  };
}

/** The error the gated API returns (same words as the panel). */
export const ACCESS_REMOVED_ERROR = `Access removed: hold the minimum ${BRAND.token} in a linked wallet to use hosted features and the API. Your data, withdrawals, exports and the kill switch still work. Access comes back automatically when your balance is restored.`;
