/** Shared CLI plumbing: load config, unlock the keystore, build an Agent. */
import { existsSync } from "node:fs";
import { Agent, Keystore, loadConfig, type VeskConfig } from "@vesk-agent/core";
import { askHidden, fail, warn, jsonMode } from "./ui.js";

export async function config(path?: string): Promise<VeskConfig> {
  const { config, errors, path: p } = await loadConfig(path);
  // stderr in --json mode, so stdout stays machine-readable
  if (!p) (jsonMode() ? console.error : console.log)(warn("No vesk.config.yaml found. Using defaults (run `vesk init`)."));
  if (errors.length) fail("Config problems:\n" + errors.map((e) => `  ${e.field}: ${e.message}`).join("\n"));
  return config;
}

export async function unlock(c: VeskConfig): Promise<Keystore> {
  if (!existsSync(c.wallet.keystore)) fail(`No keystore at ${c.wallet.keystore}. Run \`vesk init\` first.`);
  const pass = process.env.VESK_PASSPHRASE ?? (await askHidden("Keystore passphrase: "));
  try {
    return await Keystore.open(c.wallet.keystore, pass);
  } catch (e) {
    return fail((e as Error).message);
  }
}

export async function agent(opts: { config?: string; paper?: boolean; stream?: boolean } = {}): Promise<Agent> {
  const c = await config(opts.config);
  const ks = await unlock(c);
  return new Agent({ config: c, keystore: ks, paper: opts.paper, xMode: opts.stream ? "stream" : "poll" }).init();
}
