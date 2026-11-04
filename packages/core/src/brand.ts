/**
 * The brand, in one place, for the agent (CLI banner and messages, Telegram replies, MCP descriptions, model prompts)
 * and, synced by the site's scripts/sync-core.mjs, for the hosted edge function. The site has the same fields in
 * src/brand.ts. Renaming the CLI binary (`vesk`), the npm package, env names (VESK_*) or the ~/.vesk folder is a
 * breaking change for existing installs and isn't driven from here: see the site's START-HERE "Renaming".
 */
export const BRAND = {
  name: "Vesk",
  /** The product's full name, for titles and the app manifest. */
  product: "Vesk Agent",
  ticker: "VESK",
  token: "$VESK",
  tagline: "Moves before you see it.",
  /** The site's domain (registered): the install command, social tags, sitemap, sign-in message. */
  domain: "veskagent.com",
  xHandle: "vesk_agent",
  /** Backup handle if the main one is taken. */
  xHandleBackup: "veskagent",
  github: "https://github.com/vesk-agent/vesk",
  npmPackage: "vesk-agent",
  cli: "vesk",
  telegramBot: "vesk_agent_bot",
} as const;
