"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { agent } from "@/lib/agent";
import { usd } from "@/lib/format";
import { listSent } from "@/lib/sent";
import { useHydrated } from "@/lib/useHydrated";
import { Button } from "./ui";

const LABEL: Record<string, string> = {
  WAITING_PRICE: "Waiting for the price",
  AWAITING_PAYMENT: "Not paid",
  PAID: "Queued",
  BUYING: "Buying",
  READY: "Waiting to be claimed",
  CLAIMING: "Being claimed",
  CLAIMED: "Claimed",
  RETURNING: "Coming back to you",
  RETURNED: "Returned to you",
  REFUNDING: "Refunding",
  REFUNDED: "Refunded",
  FAILED: "Refunding",
  EXPIRED: "Not paid",
};

export function SentList() {
  const hydrated = useHydrated();
  const gifts = hydrated ? listSent() : null;
  const [status, setStatus] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!hydrated) return;
    listSent().forEach((g) =>
      agent
        .gift(g.id)
        .then((x) => setStatus((s) => ({ ...s, [g.id]: x.status === "PAID" && x.order && !x.order.triggered ? "WAITING_PRICE" : x.status })))
        .catch(() => {}),
    );
  }, [hydrated]);

  if (gifts === null) return null;

  if (!gifts.length)
    return (
      <div className="space-y-4">
        <h1 className="numerals text-3xl font-bold text-ink">Gifts you sent</h1>
        <p className="text-ink-soft">Gifts you send from this device show up here, so you can follow them and cancel if you need to.</p>
        <Link href="/send">
          <Button>Send a gift</Button>
        </Link>
      </div>
    );

  return (
    <div>
      <h1 className="numerals text-3xl font-bold text-ink">Gifts you sent</h1>
      <ul className="mt-5 divide-y divide-rule border-y border-rule">
        {gifts.map((g) => (
          <li key={g.id}>
            <Link href={`/sent/${g.id}`} className="flex items-center justify-between gap-3 py-4 hover:bg-sheet">
              <div>
                <p className="text-ink">
                  <span className="numerals font-bold">{g.ticker}</span> for {g.recipientName}
                </p>
                <p className="text-sm text-ink-soft">{new Date(g.sentAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</p>
              </div>
              <div className="text-right">
                <p className="numerals text-ink">{usd(g.usd)}</p>
                <p className="text-sm text-ink-soft">{status[g.id] ? LABEL[status[g.id]!] ?? status[g.id] : "…"}</p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
