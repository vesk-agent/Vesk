/**
 * Module resolution for the e2e run:
 *  - @vesk-agent/* always resolves to the TypeScript sources (no build step needed).
 *  - @solana/web3.js and other packages resolve normally; only if they are missing (offline, no install)
 *    do they fall back: web3.js to ./web3-shim.mjs, others to directories in VESK_E2E_NODE_PATH.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = new URL("..", import.meta.url);
const PKG = { "@vesk-agent/core": "core", "@vesk-agent/mcp": "mcp", "@vesk-agent/telegram": "telegram", "vesk-agent": "cli" };
const extra = (process.env.VESK_E2E_NODE_PATH ?? "").split(":").filter(Boolean);

export async function resolve(specifier, context, next) {
  if (PKG[specifier]) return { url: new URL(`packages/${PKG[specifier]}/src/index.ts`, ROOT).href, shortCircuit: true };
  try {
    return await next(specifier, context);
  } catch (e) {
    if (specifier === "@solana/web3.js") {
      process.env.VESK_E2E_WEB3 = "shim";
      return { url: new URL("./web3-shim.mjs", import.meta.url).href, shortCircuit: true };
    }
    const bare = !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.includes(":");
    if (bare) {
      for (const dir of extra) {
        const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
        if (existsSync(join(dir, name))) return next(pathToFileURL(join(dir, specifier)).href.replace(/\/?$/, existsSync(join(dir, specifier, "package.json")) ? "/" : ""), context).catch(() => next(specifier, { ...context, parentURL: pathToFileURL(join(dir, "_")).href }));
      }
    }
    throw e;
  }
}
