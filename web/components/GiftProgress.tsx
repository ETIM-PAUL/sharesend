"use client";

import { useEffect, useState } from "react";
import { agent, type PublicGift } from "@/lib/agent";
import { usd } from "@/lib/format";

const TERMINAL = new Set(["CLAIMED", "EXPIRED", "REFUNDED", "RETURNED"]);

/** Polls the gift and shows where it is: paid → buying → ready (→ claimed). */
export function useGift(id: string, initial?: PublicGift) {
  const [gift, setGift] = useState<PublicGift | undefined>(initial);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const g = await agent.gift(id);
        if (stop) return;
        setGift(g);
        setError(null);
        if (TERMINAL.has(g.status)) return;
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
      if (!stop) timer = setTimeout(tick, 4000);
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [id]);
  return { gift, setGift, error };
}

type StepState = "done" | "now" | "later";

function steps(g: PublicGift): { label: string; detail?: string; state: StepState }[] {
  const s = g.status;
  const paid: StepState = s === "AWAITING_PAYMENT" ? "now" : "done";
  const buying: StepState = s === "PAID" || s === "BUYING" ? "now" : ["READY", "CLAIMING", "CLAIMED", "RETURNING", "RETURNED"].includes(s) ? "done" : "later";
  const ready: StepState = s === "READY" ? "now" : ["CLAIMING", "CLAIMED"].includes(s) ? "done" : "later";
  const claimed: StepState = s === "CLAIMED" ? "done" : s === "CLAIMING" ? "now" : "later";
  const o = g.order;
  const waitingForPrice = s === "PAID" && !!o && !o.triggered;
  const buyDetail = waitingForPrice
    ? `Waiting for ${g.ticker} to fall to $${o.trigger.toFixed(2)} (${o.dropPct}% below $${o.baseline.toFixed(2)}). Buys automatically if it does by ${new Date(o.deadline).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}; otherwise you're refunded in full.${o.lastPrice ? ` Last seen $${o.lastPrice.toFixed(2)}.` : ""}`
    : s === "PAID"
      ? o?.triggered
        ? "The price was reached. Buying as soon as the trading desk is online."
        : "Queued. The purchase starts as soon as the trading desk is online."
      : g.step === "forwarded"
        ? "Buying the stock now"
        : g.step === "swapped"
          ? `Bought. Moving it into safekeeping for ${g.recipientName}`
          : s === "BUYING"
            ? "Starting the purchase"
            : undefined;
  return [
    { label: s === "AWAITING_PAYMENT" ? "Waiting for payment" : "Paid", state: paid },
    { label: buying === "done" ? `Bought ${g.ticker}` : waitingForPrice ? `Waiting to buy ${g.ticker}` : `Buying ${g.ticker}`, detail: buyDetail, state: buying },
    { label: `Ready for ${g.recipientName} to claim`, detail: s === "READY" && g.claimExpiresAt ? `Unclaimed gifts come back to you on ${new Date(g.claimExpiresAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}` : undefined, state: ready },
    { label: "Claimed", detail: s === "CLAIMING" ? "Sending it to their wallet" : undefined, state: claimed },
  ];
}

function outcome(g: PublicGift): string | null {
  switch (g.status) {
    case "RETURNING":
      return g.returnAs === "usdt" ? "Cancelled. The stock is being sold and the USDT will be sent to your wallet." : "Cancelled. The stock is on its way back to your wallet.";
    case "RETURNED":
      return [
        g.returnedUsdt != null ? `The stock was sold and ${usd(g.returnedUsdt)} in USDT is back in your wallet.` : "The stock is back in your wallet.",
        g.failureReason && /instead/.test(g.failureReason) ? g.failureReason : null,
      ]
        .filter(Boolean)
        .join(" ");
    case "FAILED":
    case "REFUNDING":
      // A reason that already says it's being refunded (an order whose price wasn't reached) stands on its own.
      if (g.failureReason?.startsWith("Not bought:")) return g.failureReason;
      return `The purchase didn't go through${g.failureReason ? ` (${g.failureReason})` : ""}. Your payment is being refunded.`;
    case "REFUNDED":
      return g.group?.role === "pool" ? "Not bought, so everyone who chipped in was refunded in full." : "Refunded in full to the wallet you paid from.";
    case "EXPIRED":
      return "This gift was never paid, so nothing was charged.";
    case "POOLED":
      return "Your contribution is part of the group gift, bought together with everyone else's.";
    default:
      return null;
  }
}

export function GiftProgress({ gift }: { gift: PublicGift }) {
  const end = outcome(gift);
  return (
    <div>
      {end ? <p className="mb-3 text-[0.95rem] text-ink">{end}</p> : null}
      {!end || gift.status === "RETURNING" || gift.status === "RETURNED" ? (
        <ol className="space-y-3">
          {steps(gift).map((st, i) => (
            <li key={st.label} className="flex gap-3">
              <span
                aria-hidden
                className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                  st.state === "done" ? "bg-engrave text-on-engrave" : st.state === "now" ? "border-2 border-engrave text-engrave" : "border border-rule text-ink-soft"
                }`}
              >
                {st.state === "done" ? "✓" : i + 1}
              </span>
              <div>
                <p className={`text-[0.95rem] ${st.state === "later" ? "text-ink-soft" : "text-ink"} ${st.state === "now" ? "font-semibold" : ""}`}>{st.label}</p>
                {st.detail && st.state !== "later" ? <p className="text-sm text-ink-soft">{st.detail}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      <TxLinks gift={gift} />
      {gift.dryRun ? <p className="mt-3 text-xs text-ink-soft">Test mode: no real money or stock moved.</p> : null}
    </div>
  );
}

const TX_LABEL: Record<string, string> = { payment: "Your payment", buy: "Stock purchase", vault: "Moved to safekeeping", claim: "Sent to recipient", return: "Returned to you", refund: "Refund" };

function TxLinks({ gift }: { gift: PublicGift }) {
  const entries = Object.entries(gift.txs);
  if (!entries.length) return null;
  return (
    <ul className="mt-4 space-y-1 text-sm">
      {entries.map(([k, h]) => (
        <li key={k}>
          <a className="text-engrave underline underline-offset-4" href={`https://bscscan.com/tx/${h}`} target="_blank" rel="noopener noreferrer">
            {TX_LABEL[k] ?? k} on BscScan
          </a>
        </li>
      ))}
    </ul>
  );
}
