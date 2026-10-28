import type { BasketSummary } from "@/lib/agent";
import { usd } from "@/lib/format";
import { GIFT_LABEL } from "@/lib/status";

const DONE = new Set(["READY", "CLAIMING", "CLAIMED"]);
const GONE = new Set(["REFUNDING", "REFUNDED", "FAILED", "EXPIRED", "RETURNING", "RETURNED"]);

/** Where each stock in a basket is, one row per stock. */
export function BasketProgress({ basket, recipientName }: { basket: BasketSummary; recipientName: string }) {
  const refunded = basket.items.filter((i) => i.status === "REFUNDING" || i.status === "REFUNDED" || i.status === "FAILED");
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-rule border-y border-rule">
        {basket.items.map((i) => (
          <li key={i.id} className="flex items-center justify-between gap-3 py-3">
            <span className="flex items-center gap-3">
              <span
                aria-hidden
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                  i.status === "CLAIMED" ? "bg-engrave text-on-engrave" : DONE.has(i.status) ? "border-2 border-engrave text-engrave" : GONE.has(i.status) ? "border border-rule text-ink-soft" : "border border-rule text-ink-soft"
                }`}
              >
                {i.status === "CLAIMED" ? "✓" : ""}
              </span>
              <span className="text-[0.95rem] text-ink">
                <span className="numerals font-bold">{i.ticker}</span> <span className="text-ink-soft">{usd(i.usd)}</span>
              </span>
            </span>
            <span className="text-sm text-ink-soft">{GIFT_LABEL[i.status] ?? i.status}</span>
          </li>
        ))}
      </ul>
      {refunded.length ? (
        <p className="text-sm text-ink-soft">
          {refunded.map((i) => i.ticker).join(", ")} couldn&apos;t be bought, so {refunded.length === 1 ? "that stock was" : "those stocks were"} refunded to you. {recipientName} gets the rest.
        </p>
      ) : null}
    </div>
  );
}
