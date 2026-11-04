/** The self-hosted agent's address book file (<dataDir>/book.json): entries (incl. your own wallets' names) and folders. */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BookEntry, WalletFolder } from "./book.js";

export async function loadBookFile(dataDir: string): Promise<{ entries: BookEntry[]; folders: WalletFolder[] }> {
  const f = join(dataDir, "book.json");
  if (!existsSync(f)) return { entries: [], folders: [] };
  const j = JSON.parse(await readFile(f, "utf8")) as { entries?: BookEntry[]; folders?: WalletFolder[] };
  return { entries: j.entries ?? [], folders: j.folders ?? [] };
}

export async function saveBookFile(dataDir: string, b: { entries: BookEntry[]; folders: WalletFolder[] }): Promise<void> {
  await writeFile(join(dataDir, "book.json"), JSON.stringify(b, null, 2), { mode: 0o600 });
}
