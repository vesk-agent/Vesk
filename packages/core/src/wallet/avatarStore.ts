/**
 * The self-hosted agent's local store for address-book images: ~/.vesk/avatars/ (the config's dataDir). The agent
 * has no image codec, so it doesn't resize or re-encode; it checks the real type from the bytes, refuses SVG and
 * anything over 512 KB, and strips metadata from PNG (text, EXIF, time, ICC chunks) and JPEG (APPn and comment
 * segments) before writing. WebP and GIF are refused here: upload those in the panel, which re-encodes every image
 * through a canvas into 64 and 128 px squares.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkUpload, isAvatarId, stripJpeg, stripPng, type AvatarRef } from "./avatar.js";

export const avatarDir = (dataDir: string) => join(dataDir, "avatars");

export async function saveLocalAvatar(dataDir: string, bytes: Uint8Array): Promise<{ ref: AvatarRef; file: string; removedBytes: number }> {
  const c = checkUpload(bytes);
  if (!c.ok) throw new Error(c.reason);
  if (c.type !== "png" && c.type !== "jpeg") throw new Error("The agent stores PNG and JPG images (it can't re-encode WebP or GIF). Upload those in the panel, or convert to PNG.");
  const clean = c.type === "png" ? stripPng(bytes) : stripJpeg(bytes);
  const id = randomBytes(8).toString("hex");
  await mkdir(avatarDir(dataDir), { recursive: true, mode: 0o700 });
  const file = join(avatarDir(dataDir), `${id}.${c.type === "png" ? "png" : "jpg"}`);
  await writeFile(file, clean, { mode: 0o600 });
  return { ref: { kind: "upload", id }, file, removedBytes: bytes.length - clean.length };
}

export async function localAvatarFile(dataDir: string, id: string): Promise<string | null> {
  if (!isAvatarId(id)) return null;
  for (const ext of ["png", "jpg", "webp"]) { const f = join(avatarDir(dataDir), `${id}.${ext}`); if (existsSync(f)) return f; }
  return null;
}

export async function readLocalAvatar(dataDir: string, id: string): Promise<Uint8Array | null> {
  const f = await localAvatarFile(dataDir, id);
  return f ? new Uint8Array(await readFile(f)) : null;
}

/** Delete images no book entry points at any more. */
export async function pruneLocalAvatars(dataDir: string, keep: Set<string>): Promise<number> {
  if (!existsSync(avatarDir(dataDir))) return 0;
  let n = 0;
  for (const f of await readdir(avatarDir(dataDir))) {
    const id = f.split(".")[0];
    if (isAvatarId(id) && !keep.has(id)) { await unlink(join(avatarDir(dataDir), f)); n++; }
  }
  return n;
}
