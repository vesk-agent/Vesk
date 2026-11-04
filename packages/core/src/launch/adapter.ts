/**
 * Launchpad adapters (v19): one interface for every place Vesk can create a coin.
 *
 * An adapter says what it can do (dev buy, a Jito bundle with disclosed team buys, quote assets), validates a plan
 * and runs the launch: metadata, the unsigned create transaction(s), local signing with your keys, sending, and the
 * result. The guardrails (launch/plan.ts checkLaunch: disclosure of team wallets, limits, the never-list) run before
 * any adapter is called, the same for all of them.
 *
 *   pump.fun   ready: PumpPortal local transactions + Jito bundle (launch/pumpfun.ts), tested end to end against mocks.
 *   StonkFun   scaffold only (launch/stonkfun.ts): its program ID and create interface aren't confirmed, so it stays
 *              "soon" and refuses to run. What's needed to enable it is in docs/38-launchpads.md.
 */
import type { Keypair } from "@solana/web3.js";
import type { Rpc } from "../rpc.js";
import type { Launchpad } from "../types.js";
import { launchpad } from "./launchpads.js";
import { validatePlan, type LaunchPlan } from "./plan.js";
import { launchPlanOnPump, type LaunchInput, type LaunchPlanResult, type LaunchProgress } from "./pumpfun.js";

export interface AdapterLaunchArgs {
  rpc: Rpc;
  plan: LaunchPlan;
  creator: Keypair;
  signerOf: (address: string) => Keypair;
  image: LaunchInput["image"];
  jitoEngine: string;
  onProgress?: (e: LaunchProgress) => void;
}

export interface LaunchpadAdapter {
  readonly id: Launchpad;
  readonly name: string;
  /** "ready" only when there is a working, tested create path. */
  readonly status: "ready" | "soon";
  /** What's missing before it can be "ready" (shown in the panel, the CLI and the docs). */
  readonly needs: string[];
  readonly can: { devBuy: boolean; teamBundle: boolean };
  /** Problems with a plan for this launchpad (empty = fine). */
  validate(plan: LaunchPlan): string[];
  launch(a: AdapterLaunchArgs): Promise<LaunchPlanResult>;
  coinUrl(mint: string): string;
}

/** An adapter that can't run yet says so, plainly, instead of guessing. */
export class LaunchpadNotReady extends Error {
  constructor(public readonly launchpadId: Launchpad, public readonly needs: string[]) {
    super(`${launchpad(launchpadId).name} isn't enabled yet: ${needs.join("; ")}.`);
  }
}

export const pumpFunAdapter: LaunchpadAdapter = {
  id: "pumpfun", name: "pump.fun", status: "ready", needs: [],
  can: { devBuy: true, teamBundle: true },
  validate: (plan) => validatePlan({ ...plan, launchpad: "pumpfun" }).map((e) => e.message),
  launch: (a) => launchPlanOnPump(a),
  coinUrl: (mint) => `https://pump.fun/coin/${mint}`,
};

const registry = new Map<Launchpad, LaunchpadAdapter>([["pumpfun", pumpFunAdapter]]);
/** Register an adapter (the scaffolds register themselves below; tests register mocks). */
export function registerAdapter(a: LaunchpadAdapter): void { registry.set(a.id, a); }
export function adapterFor(id: Launchpad): LaunchpadAdapter | undefined { return registry.get(id); }
export const adapters = (): LaunchpadAdapter[] => [...registry.values()];

/** Launch through the plan's launchpad adapter. Refuses anything that isn't ready. */
export async function launchVia(a: AdapterLaunchArgs): Promise<LaunchPlanResult> {
  const ad = adapterFor(a.plan.launchpad);
  if (!ad) throw new LaunchpadNotReady(a.plan.launchpad, ["no adapter"]);
  if (ad.status !== "ready") throw new LaunchpadNotReady(ad.id, ad.needs);
  const errs = ad.validate(a.plan);
  if (errs.length) throw new Error(errs.join(" "));
  return ad.launch(a);
}
