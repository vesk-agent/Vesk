/**
 * Third-party endpoints in one place. Each one can be overridden by an environment variable,
 * for a self-hosted proxy or for the end-to-end test, which points them at local mock servers.
 * Overrides are read at call time, never cached.
 */
const env = (k: string): string | undefined => {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const v = p?.env?.[k];
  return v ? v.replace(/\/$/, "") : undefined;
};

export const ENDPOINT_ENV = {
  xApi: "VESK_X_API_BASE",
  pumpPortal: "VESK_PUMPPORTAL_URL",
  pumpIpfs: "VESK_PUMP_IPFS_URL",
  jupPrice: "VESK_JUP_PRICE_URL",
  dexScreener: "VESK_DEXSCREENER_URL",
  anthropic: "VESK_ANTHROPIC_URL",
  openaiImages: "VESK_OPENAI_IMAGES_URL",
  telegram: "VESK_TELEGRAM_API",
  relay: "VESK_RELAY_URL",
  pumpData: "VESK_PUMPPORTAL_DATA_WS",
} as const;

export const endpoints = {
  xApi: () => env(ENDPOINT_ENV.xApi) ?? "https://api.x.com/2",
  pumpPortal: () => env(ENDPOINT_ENV.pumpPortal) ?? "https://pumpportal.fun/api/trade-local",
  pumpIpfs: () => env(ENDPOINT_ENV.pumpIpfs) ?? "https://pump.fun/api/ipfs",
  jupPrice: () => env(ENDPOINT_ENV.jupPrice) ?? "https://lite-api.jup.ag/price/v3",
  dexScreener: () => env(ENDPOINT_ENV.dexScreener) ?? "https://api.dexscreener.com",
  anthropic: () => env(ENDPOINT_ENV.anthropic) ?? "https://api.anthropic.com/v1/messages",
  openaiImages: () => env(ENDPOINT_ENV.openaiImages) ?? "https://api.openai.com/v1/images/generations",
  telegram: () => env(ENDPOINT_ENV.telegram) ?? "https://api.telegram.org",
  pumpData: () => env(ENDPOINT_ENV.pumpData) ?? "wss://pumpportal.fun/api/data",
};
