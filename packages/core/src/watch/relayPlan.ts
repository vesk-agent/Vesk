/**
 * Vesk Relay, the pure parts shared by the agent, the panel and the edge function:
 * per-user caps, dedupe across users, the rule budget of the X API tier, and packing accounts into
 * filtered-stream rules. Costs and limits are real and documented in docs/03-tracker.md.
 */
export const RELAY_MAX_PER_USER = 25;
export const RELAY_TOPIC = "relay";
/**
 * X API filtered stream limits depend on the plan (and change). Defaults match the Pro tier at the time
 * of writing: 1,000 rules of up to 1,024 characters. Set RELAY_RULE_BUDGET / RELAY_RULE_LENGTH on the worker.
 */
export const RELAY_DEFAULT_LIMITS = { rules: 1000, ruleLength: 1024 } as const;

export interface RelayTicket {
  /** Short-lived JWT for Realtime (claim vesk_relay = true). */
  token: string;
  /** e.g. wss://<project>.supabase.co/realtime/v1/websocket */
  wsUrl: string;
  /** Supabase anon key (public; Realtime needs it as `apikey`). */
  apikey: string;
  expiresAt: number;
  /** Accounts the relay carries right now (curated + requested). */
  carried: string[];
}

export interface RelaySubscribeResult {
  carried: string[];
  /** Asked for, but not carried (cap reached, or the relay is full). */
  notCarried: Array<{ handle: string; reason: string }>;
  perUserMax: number;
}

const H = /^[a-z0-9_]{1,15}$/;
export const normHandle = (h: string) => h.trim().replace(/^@/, "").toLowerCase();

/**
 * Decide what one user's request adds. `everyone` is the set of handles the relay already carries
 * (curated + all users' requests). Curated and already-carried handles are free (deduped) and don't count
 * toward the user's cap; new handles count, up to `perUser`, and only while the stream has rule room left.
 */
export function planRelaySubscription(p: {
  requested: string[];
  curated: string[];
  everyone: string[];
  mine: string[];
  perUser?: number;
  /** Max distinct handles the stream can carry with the current rule budget. */
  capacity: number;
}): RelaySubscribeResult & { add: string[]; remove: string[] } {
  const perUser = p.perUser ?? RELAY_MAX_PER_USER;
  const want = [...new Set(p.requested.map(normHandle))];
  const curated = new Set(p.curated.map(normHandle));
  const everyone = new Set(p.everyone.map(normHandle));
  const notCarried: RelaySubscribeResult["notCarried"] = [];
  const carried: string[] = [];
  const own: string[] = [];
  let total = everyone.size;
  for (const h of want) {
    if (!H.test(h)) { notCarried.push({ handle: h, reason: "not a valid X handle" }); continue; }
    if (curated.has(h)) { carried.push(h); continue; }
    if (own.length >= perUser) { notCarried.push({ handle: h, reason: `over your ${perUser}-account relay limit` }); continue; }
    if (!everyone.has(h)) {
      if (total >= p.capacity) { notCarried.push({ handle: h, reason: "the relay is full" }); continue; }
      total++;
    }
    own.push(h);
    carried.push(h);
  }
  const mine = new Set(p.mine.map(normHandle));
  return { carried, notCarried, perUserMax: perUser, add: own.filter((h) => !mine.has(h)), remove: [...mine].filter((h) => !own.includes(h)) };
}

/** Pack handles into as few filtered-stream rules as fit: `(from:a OR from:b …) -is:retweet`. */
export function packStreamRules(handles: string[], ruleLength: number = RELAY_DEFAULT_LIMITS.ruleLength): string[] {
  const suffix = ") -is:retweet";
  const rules: string[] = [];
  let cur: string[] = [];
  const len = (xs: string[]) => 1 + xs.map((h) => `from:${h}`).join(" OR ").length + suffix.length;
  for (const h of [...new Set(handles.map(normHandle))].filter((x) => H.test(x)).sort()) {
    if (cur.length && len([...cur, h]) > ruleLength) {
      rules.push(`(${cur.map((x) => `from:${x}`).join(" OR ")}${suffix}`);
      cur = [];
    }
    cur.push(h);
  }
  if (cur.length) rules.push(`(${cur.map((x) => `from:${x}`).join(" OR ")}${suffix}`);
  return rules;
}

/** How many distinct handles a rule budget can carry (approximate, using the longest handle length). */
export function relayCapacity(limits: { rules: number; ruleLength: number } = RELAY_DEFAULT_LIMITS): number {
  const per = Math.floor((limits.ruleLength - 14) / "from:xxxxxxxxxxxxxxx OR ".length);
  return Math.max(0, per * limits.rules);
}
