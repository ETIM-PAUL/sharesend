// Moves a gift one step forward from wherever it is. Shared by the CLI (`resume`) and the HTTP routes.
import type { Db } from "../db/pool.js";
import { getGift } from "../gifts/ledger.js";
import { runBuy, type ExecOutcome } from "./buy.js";
import { payoutClaim, refundGift, returnGift } from "./payouts.js";
import { execDeps } from "./live.js";

export async function advance(db: Db, id: string): Promise<ExecOutcome> {
  const d = execDeps(db);
  const g = await getGift(db, id);
  if (!g) throw new Error(`Gift ${id} not found`);
  switch (g.status) {
    case "PAID":
    case "BUYING":
      return runBuy(d, id);
    case "CLAIMING":
      return payoutClaim(d, id);
    case "RETURNING":
      return returnGift(d, id);
    case "FAILED":
    case "REFUNDING":
      return refundGift(d, id);
    default:
      return { status: "NOOP", gift: g };
  }
}

const running = new Set<string>();

/**
 * Fire-and-forget advance for HTTP handlers: one run per gift at a time in this process, errors logged
 * (gift id and message only), never thrown. The ledger's compare-and-set protects against other processes.
 */
export function advanceInBackground(db: Db, id: string): void {
  if (running.has(id)) return;
  running.add(id);
  advance(db, id)
    .then((r) => console.log(`gift ${id}: ${r.status}${"reason" in r ? ` (${r.reason})` : ""}`))
    .catch((e) => console.error(`gift ${id}: advance failed: ${(e as Error).message}`))
    .finally(() => running.delete(id));
}
