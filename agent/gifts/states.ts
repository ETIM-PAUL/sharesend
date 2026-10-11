// Gift lifecycle (BUILD_PLAN.md section 6). Only these moves are legal.
//
// AWAITING_PAYMENT ──► PAID ──► BUYING ──► READY ──► CLAIMING ──► CLAIMED
//        │              │          │          │          │
//        ▼              ▼          ▼          ▼          ▼ (claim transfer not sent: back to READY)
//     EXPIRED       REFUNDING   FAILED    RETURNING ──► RETURNED
//                       │          │
//                       ▼          ▼
//                   REFUNDED   REFUNDING
//
// Group gifts: a paid contribution moves PAID ──► POOLED when its group closes (its money now pays for the group's
// gift). If that gift is never bought, each contribution goes POOLED ──► REFUNDING ──► REFUNDED, back to its payer.

export const STATUSES = [
  "AWAITING_PAYMENT",
  "PAID",
  "BUYING",
  "READY",
  "CLAIMING",
  "CLAIMED",
  "EXPIRED",
  "REFUNDING",
  "REFUNDED",
  "FAILED",
  "RETURNING",
  "RETURNED",
  "POOLED",
] as const;
export type GiftStatus = (typeof STATUSES)[number];

export const STEPS = ["forwarded", "swapped", "in_vault"] as const;
export type BuyStep = (typeof STEPS)[number];

export const TRANSITIONS: Record<GiftStatus, readonly GiftStatus[]> = {
  AWAITING_PAYMENT: ["PAID", "EXPIRED"],
  PAID: ["BUYING", "REFUNDING", "POOLED"],
  BUYING: ["READY", "FAILED"],
  // RETURNING: sender cancels, or the claim window ends.
  READY: ["CLAIMING", "RETURNING"],
  // Back to READY only when the claim transfer was never broadcast (e.g. simulation failed). Not in the plan's diagram.
  CLAIMING: ["CLAIMED", "READY"],
  FAILED: ["REFUNDING"],
  REFUNDING: ["REFUNDED"],
  RETURNING: ["RETURNED"],
  POOLED: ["REFUNDING"],
  CLAIMED: [],
  EXPIRED: [],
  REFUNDED: [],
  RETURNED: [],
};

export const TERMINAL: readonly GiftStatus[] = STATUSES.filter((s) => TRANSITIONS[s].length === 0);

export function canTransition(from: GiftStatus, to: GiftStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Steps only move forward, one at a time: (none) → forwarded → swapped → in_vault. */
export function canAdvanceStep(from: BuyStep | null, to: BuyStep): boolean {
  return STEPS.indexOf(to) === (from === null ? 0 : STEPS.indexOf(from) + 1);
}

/** Statuses where the vault holds (or is about to hold) the gift's tokens, i.e. a liability. */
export const VAULT_LIABILITY_STATUSES: readonly GiftStatus[] = ["READY", "CLAIMING", "RETURNING"];
