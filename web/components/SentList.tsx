"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { agent } from "@/lib/agent";
import { usd } from "@/lib/format";
import { listSent } from "@/lib/sent";
import { GIFT_LABEL as LABEL } from "@/lib/status";
import { useHydrated } from "@/lib/useHydrated";
import { Button } from "./ui";

export function SentList() {
  const hydrated = useHydrated();
  const gifts = hydrated ? listSent() : null;
  const [status, setStatus] = useState<Record<string, string>>({});
  const [thanked, setThanked] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!hydrated) return;
    listSent().forEach((g) =>
      agent
        .gift(g.id)
        .then((x) => {
          setStatus((s) => ({ ...s, [g.id]: x.basket?.status ?? (x.status === "PAID" && x.order && !x.order.triggered ? "WAITING_PRICE" : x.status) }));
          if (x.thanks) setThanked((t) => ({ ...t, [g.id]: true }));
        })
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
                {thanked[g.id] ? <p className="text-sm text-engrave">{g.recipientName} left you a note</p> : null}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
