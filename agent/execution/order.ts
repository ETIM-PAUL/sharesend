// Conditional orders: "buy when the price has dropped X% by <deadline>". The gift is paid and waiting in PAID.
// Pure decision first (tested branch by branch), then the part that records what the watcher saw.
import type { Db } from "../db/pool.js";
import type { Gift, GiftOrder } from "../gifts/ledger.js";

export type OrderDecision =
  | { action: "buy"; why: "already triggered" | "price reached" }
  | { action: "wait"; reason: string }
  | { action: "expire"; reason: string };

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * - Once the condition has been met, the order is a normal buy (never refunded for a late wallet, say).
 * - Past the deadline without it being met: refund. Not met "by 2PM" means not met, even if the price is low at 2:01.
 * - Otherwise buy if the price is at or below the trigger. If the price can't be read right now, just wait.
 */
export function decideOrder(order: GiftOrder, price: number | null, nowMs: number): OrderDecision {
  if (order.triggeredAt) return { action: "buy", why: "already triggered" };
  if (nowMs >= order.deadline.getTime()) return { action: "expire", reason: `the price didn't reach ${usd(order.trigger)} by the deadline` };
  if (price === null) return { action: "wait", reason: "the price can't be read right now" };
  if (price <= order.trigger) return { action: "buy", why: "price reached" };
  return { action: "wait", reason: `waiting for ${usd(order.trigger)} (now ${usd(price)})` };
}

/** Remembers the latest price the watcher saw, for the sender to read. */
export async function recordPrice(db: Db, giftId: string, price: number | null) {
  if (price === null) return;
  await db.query("UPDATE gifts SET order_last_price = $2, order_checked_at = now() WHERE id = $1", [giftId, price]);
}

/** Marks the condition as met, once. After this the gift is bought like any other. */
export async function markTriggered(db: Db, giftId: string) {
  await db.query("UPDATE gifts SET order_triggered_at = coalesce(order_triggered_at, now()), updated_at = now() WHERE id = $1", [giftId]);
}

export const hasWaitingOrder = (g: Gift) => !!g.order && !g.order.triggeredAt;
