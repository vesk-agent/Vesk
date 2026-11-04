/** Dependency-free base58 (Bitcoin alphabet, as used by Solana). */
export const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAP: Record<string, number> = Object.fromEntries([...B58_ALPHABET].map((c, i) => [c, i]));

/** Decode base58 to bytes. Returns null on any invalid character. */
export function b58decode(s: string): Uint8Array | null {
  const bytes: number[] = []; // little-endian accumulator
  for (const ch of s) {
    const v = MAP[ch];
    if (v === undefined) return null;
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + bytes.length - 1 - i] = bytes[i];
  return out;
}

export function b58encode(b: Uint8Array): string {
  const digits: number[] = [0];
  for (const byte of b) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (let i = 0; i < b.length && b[i] === 0; i++) out += "1";
  if (b.every((x) => x === 0)) return out;
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
  return out;
}

/** True if `s` is a syntactically valid Solana public key (base58 that decodes to exactly 32 bytes). */
export function isPubkey(s: string): boolean {
  if (s.length < 32 || s.length > 44) return false;
  const d = b58decode(s);
  return !!d && d.length === 32;
}
