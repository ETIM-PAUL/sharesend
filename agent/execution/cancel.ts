// Sender cancels a gift. Unpaid → EXPIRED. Paid but not bought → refund. Ready → stock returned to sender.
import type { Db } from "../db/pool.js";
import { basketMembers, getGift, setReturnAs, StaleStateError, transition, type Gift, type ReturnAs } from "../gifts/ledger.js";
import { advanceInBackground } from "./advance.js";

export type CancelResult = { ok: true; gift: Gift } | { ok: false; status: 404 | 409; error: string };

/** `returnAs` is the sender's choice for this cancel; without it the gift's saved choice applies. */
export async function cancelGift(db: Db, id: string, runInBackground = advanceInBackground, returnAs?: ReturnAs): Promise<CancelResult> {
  const g = await getGift(db, id);
  if (!g) return { ok: false, status: 404, error: "gift not found" };
  if (returnAs && g.status === "READY" && !(await setReturnAs(db, id, returnAs))) return { ok: false, status: 409, error: "the gift changed just now; refresh and try again" };
  try {
    switch (g.status) {
      case "AWAITING_PAYMENT":
        return { ok: true, gift: await transition(db, id, "AWAITING_PAYMENT", "EXPIRED", { failureReason: "cancelled by sender" }) };
      case "PAID": {
        const next = await transition(db, id, "PAID", "REFUNDING", { failureReason: "cancelled by sender" });
        runInBackground(db, id);
        return { ok: true, gift: next };
      }
      case "READY": {
        const next = await transition(db, id, "READY", "RETURNING");
        runInBackground(db, id);
        return { ok: true, gift: next };
      }
      case "BUYING":
        return { ok: false, status: 409, error: "the stock is being bought right now; you can cancel once it's ready" };
      default:
        return { ok: false, status: 409, error: `this gift is ${g.status.toLowerCase()} and can't be cancelled` };
    }
  } catch (e) {
    if (e instanceof StaleStateError) return { ok: false, status: 409, error: "the gift changed just now; refresh and try again" };
    throw e;
  }
}

/**
 * Cancels every stock in a basket (the sender signed once, for the lead). Each stock follows the usual rules: unpaid ones
 * expire, paid ones are refunded, ready ones go back to the sender. One that can't be cancelled right now (it is being
 * bought) is left alone and reported; the rest still go ahead.
 */
export async function cancelBasket(db: Db, leadId: string, runInBackground = advanceInBackground, returnAs?: ReturnAs): Promise<CancelResult & { skipped?: string[] }> {
  const members = await basketMembers(db, leadId);
  if (!members.length) return { ok: false, status: 404, error: "gift not found" };
  const skipped: string[] = [];
  let first: CancelResult | null = null;
  let any = false;
  for (const m of members) {
    const r = await cancelGift(db, m.id, runInBackground, returnAs);
    if (r.ok) any = true;
    else {
      first ??= r;
      skipped.push(m.ticker);
    }
  }
  if (!any) return first!;
  return { ok: true, gift: (await getGift(db, leadId))!, skipped };
}
