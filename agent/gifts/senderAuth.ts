// Sender-only actions (cancel, new claim link) are authorized by a signed message from the gift's sender
// address. The message names the action, the gift and the time; it expires after 5 minutes and works once.
import { createHash } from "node:crypto";
import type { Queryable } from "../db/pool.js";
import type { Gift } from "./ledger.js";

export type SenderAction = "cancel" | "link";
const ACTION_TEXT: Record<SenderAction, string> = { cancel: "Cancel this gift", link: "Get a new claim link" };
export const SENDER_MESSAGE_TTL_MS = 5 * 60_000;

/** The exact text the sender's wallet signs (personal_sign). */
export function senderMessage(action: SenderAction, giftId: string, isoTime: string): string {
  return `ShareSend\n${ACTION_TEXT[action]}\nGift: ${giftId}\nTime: ${isoTime}`;
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
  if (typeof message !== "string" || typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) return { ok: false, error: "message and signature required" };
  const time = /\nTime: (\S+)$/.exec(message)?.[1];
  if (!time || message !== senderMessage(action, gift.id, time)) return { ok: false, error: "message doesn't match this action and gift" };
  const at = Date.parse(time);
  if (!Number.isFinite(at) || Math.abs(now - at) > SENDER_MESSAGE_TTL_MS) return { ok: false, error: "signed message expired; sign again" };
  if (!(await verify(gift.senderAddress, message, signature))) return { ok: false, error: "signature is not from this gift's sender" };
  const hash = createHash("sha256").update(`${message}\n${signature.toLowerCase()}`).digest("hex");
  const r = await db.query("INSERT INTO used_signatures (hash) VALUES ($1) ON CONFLICT DO NOTHING", [hash]);
  if (!r.rowCount) return { ok: false, error: "this signature was already used; sign again" };
  return { ok: true };
}
