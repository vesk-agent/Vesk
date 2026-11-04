/**
 * New pump.fun launches via PumpPortal's public data websocket (subscribeNewToken).
 * Docs: https://pumpportal.fun/data-api/real-time
 */
import { solUsd, PUMP_SUPPLY } from "../market.js";
import type { LaunchEvent } from "../types.js";
import { endpoints } from "../endpoints.js";

export const PUMPPORTAL_WS = "wss://pumpportal.fun/api/data";
/** pump.fun curves start with 30 virtual SOL. */
const VIRTUAL_SOL_START = 30;

export interface CreateMessage {
  signature: string; mint: string; traderPublicKey: string; txType: "create";
  initialBuy: number; solAmount: number; vTokensInBondingCurve: number; vSolInBondingCurve: number; marketCapSol: number;
  name: string; symbol: string; uri: string; pool?: string;
}

async function socials(uri: string): Promise<LaunchEvent["socials"]> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const r = await fetch(uri, { signal: ctl.signal });
    clearTimeout(t);
    const j = (await r.json()) as { twitter?: string; telegram?: string; website?: string };
    const clean = (s?: string) => (s && /^https?:\/\//.test(s) ? s : undefined);
    return { x: clean(j.twitter), telegram: clean(j.telegram), website: clean(j.website) };
  } catch {
    return {};
  }
}

export async function toLaunchEvent(m: CreateMessage): Promise<LaunchEvent> {
  const usd = await solUsd().catch(() => 0);
  return {
    mint: m.mint, name: m.name, symbol: m.symbol, creator: m.traderPublicKey,
    devTokens: m.initialBuy, totalSupply: PUMP_SUPPLY,
    liquiditySol: Math.max(0, m.vSolInBondingCurve - VIRTUAL_SOL_START),
    mcapUsd: m.marketCapSol * usd,
    socials: await socials(m.uri),
    // pump.fun mints are created with mint and freeze authority revoked.
    mintAuthorityRevoked: true, freezeAuthorityRevoked: true,
    at: new Date().toISOString(),
  };
}

export class PumpLaunchWatcher {
  private ws?: WebSocket;
  private stopped = false;

  start(onLaunch: (e: LaunchEvent) => void, onError?: (e: Error) => void) {
    this.stopped = false;
    let backoff = 1000;
    const connect = () => {
      const ws = new WebSocket(endpoints.pumpData());
      this.ws = ws;
      ws.onopen = () => {
        backoff = 1000;
        ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      };
      ws.onmessage = (ev: MessageEvent) => {
        try {
          const m = JSON.parse(String(ev.data)) as CreateMessage;
          if (m.txType === "create" && m.mint) void toLaunchEvent(m).then(onLaunch, (e: Error) => onError?.(e));
        } catch {
          /* subscription acks and other frames */
        }
      };
      ws.onerror = () => onError?.(new Error("pump.fun stream error"));
      ws.onclose = () => {
        if (this.stopped) return;
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      };
    };
    connect();
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }
}
