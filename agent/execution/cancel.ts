// Sender cancels a gift. Unpaid → EXPIRED. Paid but not bought → refund. Ready → stock returned to sender.
import type { Db } from "../db/pool.js";
import { getGift, setReturnAs, StaleStateError, transition, type Gift, type ReturnAs } from "../gifts/ledger.js";
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
