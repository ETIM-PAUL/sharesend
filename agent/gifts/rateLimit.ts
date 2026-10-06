// Claim-attempt rate limits, stored in Postgres so they survive restarts and work across replicas.
// Only failed attempts count. Claim codes are 128-bit, so this is defence in depth, not the main protection.
import { createHash } from "node:crypto";
import type { Queryable } from "../db/pool.js";

export interface ClaimRateLimits {
  windowSeconds: number;
  maxFailuresPerIp: number;
  /** Per gift, so a leaked gift id can't be brute-forced from many IPs. Lockout lasts one window. */
  maxFailuresPerGift: number;
}

export const DEFAULT_CLAIM_LIMITS: ClaimRateLimits = { windowSeconds: 15 * 60, maxFailuresPerIp: 20, maxFailuresPerGift: 10 };

export function hashIp(ip: string): string {
  return createHash("sha256").update(`sharesend-ip:${ip}`).digest("hex").slice(0, 32);
}

export async function isRateLimited(db: Queryable, ipHash: string, giftId: string | null, l: ClaimRateLimits): Promise<boolean> {
  const { rows } = await db.query<{ by_ip: string; by_gift: string }>(
    `SELECT
       count(*) FILTER (WHERE ip_hash = $1)                        AS by_ip,
       count(*) FILTER (WHERE $2::uuid IS NOT NULL AND gift_id = $2::uuid) AS by_gift
     FROM claim_attempts
     WHERE NOT success AND at > now() - make_interval(secs => $3) AND (ip_hash = $1 OR gift_id = $2::uuid)`,
    [ipHash, giftId, l.windowSeconds],
  );
  const r = rows[0]!;
  return Number(r.by_ip) >= l.maxFailuresPerIp || Number(r.by_gift) >= l.maxFailuresPerGift;
}

export async function recordAttempt(db: Queryable, ipHash: string, giftId: string | null, success: boolean): Promise<void> {
  await db.query("INSERT INTO claim_attempts (gift_id, ip_hash, success) VALUES ($1, $2, $3)", [giftId, ipHash, success]);
}
