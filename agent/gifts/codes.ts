// Claim codes: 128-bit random, only the SHA-256 hash is stored, and the code travels in the URL
// fragment (#...) so it never reaches server logs or Referer headers. Never log a code.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const CODE_BYTES = 16; // 128 bits
const CODE_RE = /^[A-Za-z0-9_-]{22}$/; // base64url of 16 bytes, no padding

export function generateClaimCode(): string {
  return randomBytes(CODE_BYTES).toString("base64url");
}

export function isWellFormedCode(code: string): boolean {
  return CODE_RE.test(code);
}

export function hashClaimCode(code: string): Buffer {
  return createHash("sha256").update(code, "utf8").digest();
}

/** Constant-time check of a presented code against the stored hash. */
export function codeMatches(code: string, storedHash: Buffer): boolean {
  if (!isWellFormedCode(code) || storedHash.length !== 32) return false;
  return timingSafeEqual(hashClaimCode(code), storedHash);
}

/** Link for the sender to share. The gift id is in the path (for per-gift rate limits); the code only in the fragment. */
export function claimLink(baseUrl: string, giftId: string, code: string): string {
  return `${baseUrl.replace(/\/$/, "")}/c/${giftId}#${code}`;
}
