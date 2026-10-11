// Sender-only actions (cancel, new claim link) are authorized by a signed message from the gift's sender
// address. The message names the action, the gift and the time; it expires after 5 minutes and works once.
import { createHash } from "node:crypto";
import type { Queryable } from "../db/pool.js";
import type { Gift } from "./ledger.js";

export type SenderAction = "cancel" | "cancel-stock" | "cancel-usdt" | "link" | "return-stock" | "return-usdt";
// The choice is part of the signed text, so a signature for one choice can't be replayed as the other.
const ACTION_TEXT: Record<SenderAction, string> = {
  cancel: "Cancel this gift",
  "cancel-stock": "Cancel this gift and get the stock back",
  "cancel-usdt": "Cancel this gift and get USDT back",
  link: "Get a new claim link",
  "return-stock": "If this gift is not claimed, return the stock to me",
  "return-usdt": "If this gift is not claimed, sell it and return USDT to me",
};
export const SENDER_MESSAGE_TTL_MS = 5 * 60_000;

/** The exact text the sender's wallet signs (personal_sign). */
export function senderMessage(action: SenderAction, giftId: string, isoTime: string): string {
  return `ShareSend\n${ACTION_TEXT[action]}\nGift: ${giftId}\nTime: ${isoTime}`;
}

/** Which of `candidates` a signed message is for, judged by its text (the signature is checked separately). */
export function actionOf(message: unknown, giftId: string, candidates: SenderAction[]): SenderAction | null {
  if (typeof message !== "string") return null;
  const time = /\nTime: (\S+)$/.exec(message)?.[1];
  if (!time) return null;
  return candidates.find((a) => message === senderMessage(a, giftId, time)) ?? null;
}

export type SignatureVerifier = (address: string, message: string, signature: string) => Promise<boolean>;

export async function verifySender(
  db: Queryable,
  gift: Gift,
  action: SenderAction,
  message: unknown,
  signature: unknown,
  verify: SignatureVerifier,
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; error: string }> {
  return verifySigned(db, gift.senderAddress, (time) => senderMessage(action, gift.id, time), message, signature, verify, now, "this gift's sender");
}

/**
 * Checks a signed action message: it must equal `expected(time)` for its own `Time:` line, be under 5 minutes old,
 * be signed by `signer`, and not have been used before.
 */
export async function verifySigned(
  db: Queryable,
  signer: string,
  expected: (isoTime: string) => string,
  message: unknown,
  signature: unknown,
  verify: SignatureVerifier,
  now: number,
  who: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (typeof message !== "string" || typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) return { ok: false, error: "message and signature required" };
  const time = /\nTime: (\S+)$/.exec(message)?.[1];
  if (!time || message !== expected(time)) return { ok: false, error: "message doesn't match this action" };
  const at = Date.parse(time);
  if (!Number.isFinite(at) || Math.abs(now - at) > SENDER_MESSAGE_TTL_MS) return { ok: false, error: "signed message expired; sign again" };
  if (!(await verify(signer, message, signature))) return { ok: false, error: `signature is not from ${who}` };
  const hash = createHash("sha256").update(`${message}\n${signature.toLowerCase()}`).digest("hex");
  const r = await db.query("INSERT INTO used_signatures (hash) VALUES ($1) ON CONFLICT DO NOTHING", [hash]);
  if (!r.rowCount) return { ok: false, error: "this signature was already used; sign again" };
  return { ok: true };
}
