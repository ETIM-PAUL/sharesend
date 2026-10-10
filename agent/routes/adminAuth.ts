import { timingSafeEqual } from "node:crypto";
import type { Context } from "hono";

/** True when the request carries the operator's ADMIN_TOKEN (24+ characters) as a Bearer token. */
export function authorized(c: Context): boolean {
  const token = process.env.ADMIN_TOKEN;
  if (!token || token.length < 24) return false;
  const given = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
