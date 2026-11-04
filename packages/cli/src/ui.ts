/**
 * Terminal output. Quiet by design: dim timestamps and labels, one cold accent (cyan) for the agent,
 * green/red only for money. Columns are aligned on visible width (colour codes don't count).
 * Honours NO_COLOR and non-TTY output (FORCE_COLOR=1 keeps colour when piped). `--json` switches every command to machine output.
 */
import { createInterface } from "node:readline";

const on = process.env.FORCE_COLOR ? process.env.FORCE_COLOR !== "0" : !process.env.NO_COLOR && process.stdout.isTTY && process.env.TERM !== "dumb";
const c = (code: string) => (s: string | number) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const dim = c("2");
export const bold = c("1");
export const ice = c("38;5;159"); // the agent: cold cyan-white
export const up = c("38;5;114"); // money in
export const down = c("38;5;210"); // money out, errors
export const warn = c("38;5;222");
export const grey = c("38;5;245");
export const faint = c("38;5;240");

/** Visible width, ignoring ANSI colour codes. */
export const vw = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const pad = (s: string, n: number, right = false) => (right ? " ".repeat(Math.max(0, n - vw(s))) + s : s + " ".repeat(Math.max(0, n - vw(s))));

// ---------- --json ----------
let JSON_MODE = false;
export const setJson = (v: boolean) => void (JSON_MODE = v);
export const jsonMode = () => JSON_MODE;
/** In --json mode print `data` and return true; the caller skips its human output. */
export function json(data: unknown): boolean {
  if (!JSON_MODE) return false;
  process.stdout.write(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  return true;
}

export const BANNER = [
  "",
  `   ${ice("\\\\")}        ${ice("//")}`,
  `    ${ice("\\\\")}      ${ice("//")}     ${bold("V E S K")}`,
  `     ${ice("\\\\")}    ${grey("//")}      ${dim("moves before you see it")}`,
  `      ${ice("\\\\")}  ${grey("//")}`,
  `       ${ice("\\\\")}${grey("//")}       ${dim("open-source memecoin agent · MIT")}`,
  "",
].join("\n");
/** The banner, unless output is JSON or not a terminal. */
export const banner = () => (!JSON_MODE && process.stdout.isTTY ? console.log(BANNER) : undefined);

/** Local wall-clock time, `14:02:11.204`. */
export const clock = (at = Date.now()) => {
  const d = new Date(at);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

/** One activity line: `14:02:11.204  buy       Bought 0.25 SOL of OWL …`. Tags are 9 wide; the time is local. */
export function line(tag: string, msg: string, color: (s: string) => string = grey, at = Date.now()) {
  if (JSON_MODE) return void process.stdout.write(JSON.stringify({ at: new Date(at).toISOString(), kind: tag, message: msg.replace(/\x1b\[[0-9;]*m/g, "") }) + "\n");
  const t = clock(at);
  console.log(`${dim(t)}  ${color(tag.padEnd(9))} ${msg}`);
}

/**
 * A table. Numbers (and columns named in `right`) are right-aligned. Headers are tiny and dim.
 * Values may contain colour codes; widths use the visible text.
 */
export function table(rows: Array<Record<string, string | number>>, cols?: string[], right: string[] = []) {
  if (!rows.length) return console.log(dim("  (none)"));
  const keys = cols ?? Object.keys(rows[0]);
  const cell = (r: Record<string, string | number>, k: string) => String(r[k] ?? "");
  const isNum = (k: string) => right.includes(k) || rows.every((r) => /^[\s+\-−$]*[\d.,]+\s?(%|ms|SOL|k|M|B|x)?$/.test(vw(cell(r, k)) ? cell(r, k).replace(/\x1b\[[0-9;]*m/g, "") : "0"));
  const w = keys.map((k) => Math.max(k.length, ...rows.map((r) => vw(cell(r, k)))));
  const align = keys.map(isNum);
  console.log("  " + keys.map((k, i) => dim(pad(k.toUpperCase(), w[i], align[i]))).join("  "));
  for (const r of rows) console.log("  " + keys.map((k, i) => pad(cell(r, k), w[i], align[i])).join("  "));
}

/** Label/value pairs, labels dim and aligned. */
export function kv(pairs: Array<[string, string]>, indent = 2) {
  const w = Math.max(...pairs.map(([k]) => k.length));
  for (const [k, v] of pairs) console.log(`${" ".repeat(indent)}${dim(k.padEnd(w))}  ${v}`);
}

/** A spinner for work that takes a moment. Non-TTY or --json: no animation, one line at the end. */
export function spinner(text: string) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const tty = on && !JSON_MODE;
  let i = 0;
  const t = tty ? setInterval(() => process.stdout.write(`\r  ${ice(frames[i++ % frames.length])} ${text}`), 80) : null;
  const end = (mark: string, msg: string) => {
    if (t) clearInterval(t);
    if (JSON_MODE) return;
    if (tty) process.stdout.write(`\r\x1b[2K`);
    console.log(`  ${mark} ${msg}`);
  };
  return {
    ok: (msg = text) => end(up("ok"), msg),
    fail: (msg = text) => end(down("✕ "), msg),
    warn: (msg = text) => end(warn("!!"), msg),
    stop: () => { if (t) { clearInterval(t); process.stdout.write("\r\x1b[2K"); } },
  };
}

export function fail(msg: string): never {
  if (JSON_MODE) process.stdout.write(JSON.stringify({ error: msg }) + "\n");
  else console.error(`${down("error")}  ${msg}`);
  process.exit(1);
}

export function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => (rl.close(), res(a.trim()))));
}

/** Prompt without echo (passphrases). */
export function askHidden(q: string): Promise<string> {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let shown = false;
    out._writeToOutput = (s: string) => {
      if (!shown) {
        out.output.write(s);
        shown = true;
      }
    };
    rl.question(q, (a) => {
      rl.close();
      process.stdout.write("\n");
      res(a);
    });
  });
}

export async function confirm(q: string): Promise<boolean> {
  return /^y(es)?$/i.test(await ask(`${q} ${dim("[y/N]")} `));
}

export const sol = (n: number) => `${n.toFixed(n >= 1 ? 3 : 4)} SOL`;
export const signed = (n: number, suffix = "") => (n >= 0 ? up(`+${n.toFixed(4)}${suffix}`) : down(`${n.toFixed(4)}${suffix}`));
export const short = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
