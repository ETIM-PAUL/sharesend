"use client";

import { useEffect, useState } from "react";
import { agentStatus, type AgentStatus } from "@/lib/agent";
import { ago, shortAddr } from "@/lib/format";

const LABEL: Record<string, string> = {
  "expire-unpaid": "Close unpaid gifts",
  "expiry-returns": "Return unclaimed gifts",
  "resume-payouts": "Finish interrupted payouts",
  "price-watch": "Watch prices for waiting orders",
  "buy-queue": "Buy stock for paid gifts",
  reconcile: "Check the vault's holdings",
  keepalive: "Keep the trading wallet signed in",
};

/** The agent's work as it happens: its on-chain identity and the last run of every job, from the live server. */
export function LiveLedger() {
  const [s, setS] = useState<AgentStatus | null>(null);
  const [failed, setFailed] = useState(false);
  // The clock is read only after data arrives (never during prerender).
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    let stop = false;
    const load = () =>
      agentStatus()
        .then((x) => !stop && (setS(x), setNow(Date.now()), setFailed(false)))
        .catch(() => !stop && setFailed(true));
    load();
    const t = setInterval(load, 30_000);
    const c = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      stop = true;
      clearInterval(t);
      clearInterval(c);
    };
  }, []);

  const id = s?.identity;
  const running = !!s?.agent.schedulerRunning;

  return (
    <section aria-label="Live from the agent" className="overflow-hidden rounded-[10px] border border-rule bg-sheet">
      <div className="flex items-center justify-between gap-3 border-b border-rule px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className={`beat ${failed || !running ? "off" : ""}`} aria-hidden />
          <p className="numerals text-[0.95rem] font-semibold text-ink">{failed ? "Agent unreachable" : !s ? "Connecting to the agent…" : running ? "Agent running" : "Agent paused"}</p>
        </div>
        {s && !s.agent.liveTrading ? <span className="rounded-full border border-rule px-2.5 py-0.5 text-xs text-ink-soft">Test mode</span> : null}
      </div>

      {id ? (
        <a
          href={id.links.token}
          target="_blank"
          rel="noopener noreferrer"
          className="block border-b border-rule px-4 py-3 transition hover:bg-raise"
        >
          <p className="text-xs text-ink-soft">On-chain identity</p>
          <p className="numerals text-lg font-semibold text-ink">
            Agent #{id.agentId} <span className="font-normal text-ink-soft">on {id.network === "bsc-mainnet" ? "BNB Chain" : "BNB testnet"}</span>
          </p>
          <p className="ledger-mono mt-0.5 text-xs text-ink-soft">owner {shortAddr(id.owner)}</p>
        </a>
      ) : null}

      <ol aria-live="polite">
        {(s?.jobs ?? []).map((j, i) => {
          const r = j.lastRun;
          const state = !j.enabled ? "off" : r && !r.ok ? "warn" : "ok";
          return (
            <li key={j.name} className="write-in flex items-start gap-3 border-b border-rule px-4 py-3 last:border-b-0" style={{ ["--i" as string]: i }}>
              <span className={`beat mt-1.5 shrink-0 ${state === "ok" ? "" : state === "warn" ? "warn" : "off"}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-[0.95rem] text-ink">{LABEL[j.name] ?? j.title}</p>
                <p className={`ledger-mono break-words text-xs leading-relaxed ${state === "warn" ? "text-error-ink" : "text-ink-soft"}`}>
                  {!j.enabled ? "off on this server" : r ? r.summary : "waiting for first run"}
                </p>
              </div>
              <p className="ledger-mono shrink-0 pt-0.5 text-xs text-ink-soft">{r && now !== null ? ago(r.at, now) : ""}</p>
            </li>
          );
        })}
        {!s && !failed ? <li className="px-4 py-6 text-sm text-ink-soft">Reading the ledger…</li> : null}
        {failed && !s ? <li className="px-4 py-6 text-sm text-ink-soft">The live feed isn&apos;t reachable right now. Try again in a moment.</li> : null}
      </ol>

      {s?.proof ? (
        <div className="border-t border-rule bg-raise px-4 py-3">
          <p className="text-xs text-ink-soft">Proof of holdings</p>
          <p className={`text-[0.95rem] ${s.proof.ok ? "text-signal" : "text-error-ink"}`}>{s.proof.summary.charAt(0).toUpperCase() + s.proof.summary.slice(1)}.</p>
        </div>
      ) : null}
    </section>
  );
}
