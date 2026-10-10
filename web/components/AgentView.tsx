"use client";

import { useEffect, useState } from "react";
import { agentStatus, type AgentStatus } from "@/lib/agent";
import { shortAddr, usd } from "@/lib/format";
import { Notice } from "./ui";

function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** The agent's public page: on-chain identity, what it does on its own, its wallet session, holdings and economics. */
export function AgentView() {
  const [s, setS] = useState<AgentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () =>
      agentStatus()
        .then((x) => !stop && (setS(x), setError(null)))
        .catch((e) => !stop && setError((e as Error).message));
    load();
    const t = setInterval(load, 30_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  if (error && !s) return <Notice kind="error">{error}</Notice>;
  if (!s) return <p className="text-sm text-ink-soft">Loading the agent…</p>;
  const id = s.identity;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="numerals text-3xl font-bold text-ink">The ShareSend agent</h1>
        <p className="mt-2 text-ink-soft">It runs on its own: it buys the stock for paid gifts, returns unclaimed ones, finishes interrupted payouts and checks it holds every gift it owes.</p>
      </div>

      {id ? (
        <section className="certificate" aria-label="On-chain identity">
          <div className="certificate-inner space-y-3 px-5 py-5">
            <p className="text-sm text-ink-soft">Registered on-chain as</p>
            <p className="numerals text-4xl font-bold leading-none text-ink">Agent #{id.agentId}</p>
            <p className="text-sm text-ink">
              ERC-8004 identity on {id.network === "bsc-mainnet" ? "BNB Chain" : "BNB Chain testnet"}, owned by {shortAddr(id.owner)}
              {id.verifiedOnChain ? ", read back from the registry just now." : "."}
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <a className="text-engrave underline underline-offset-4" href={id.links.token} target="_blank" rel="noopener noreferrer">
                Identity on BscScan
              </a>
              {id.links.tx ? (
                <a className="text-engrave underline underline-offset-4" href={id.links.tx} target="_blank" rel="noopener noreferrer">
                  Registration
                </a>
              ) : null}
              <a className="text-engrave underline underline-offset-4" href={id.links.scan} target="_blank" rel="noopener noreferrer">
                8004scan
              </a>
            </div>
          </div>
        </section>
      ) : (
        <Notice>This agent hasn&apos;t registered its on-chain identity yet.</Notice>
      )}

      <section>
        <h2 className="numerals mb-3 text-xl font-bold text-ink">What it does on its own</h2>
        {!s.agent.schedulerRunning ? <Notice>The job scheduler isn&apos;t running on this server.</Notice> : null}
        <ul className="divide-y divide-rule border-y border-rule">
          {s.jobs.map((j) => (
            <li key={j.name} className="py-3">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[0.95rem] text-ink">{j.title}</p>
                <span className="shrink-0 text-xs text-ink-soft">every {j.everyMinutes} min</span>
              </div>
              <p className={`mt-0.5 text-sm ${!j.enabled ? "text-ink-soft" : j.lastRun && !j.lastRun.ok ? "text-error-ink" : "text-ink-soft"}`}>
                {!j.enabled ? `Off here: ${j.reason}` : j.lastRun ? `${j.lastRun.summary} (${ago(j.lastRun.at)})` : "Waiting for its first run"}
                {j.enabled && j.runsLastDay ? `; ran ${j.runsLastDay} time${j.runsLastDay === 1 ? "" : "s"} today` : ""}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="numerals mb-2 text-xl font-bold text-ink">Trading wallet</h2>
        <p className="text-[0.95rem] text-ink">
          {!s.session
            ? "Not checked on this server yet."
            : s.session.connected && s.session.sessionExpireTime
              ? `Signed in until ${when(s.session.sessionExpireTime)}. Gifts are bought as soon as they're paid.`
              : "Signed out. Paid gifts wait safely in the vault and are bought after the next sign-in."}
        </p>
        {s.session ? <p className="mt-1 text-xs text-ink-soft">Checked {ago(s.session.checkedAt)}</p> : null}
      </section>

      <section>
        <h2 className="numerals mb-2 text-xl font-bold text-ink">Proof of holdings</h2>
        <p className={`text-[0.95rem] ${s.proof && !s.proof.ok ? "text-error-ink" : "text-ink"}`}>{s.proof ? s.proof.summary.charAt(0).toUpperCase() + s.proof.summary.slice(1) + "." : "Not checked yet."}</p>
        {s.agent.vault ? (
          <a className="mt-1 inline-block text-sm text-engrave underline underline-offset-4" href={`https://bscscan.com/address/${s.agent.vault}`} target="_blank" rel="noopener noreferrer">
            The gift vault on BscScan
          </a>
        ) : null}
      </section>

      <section>
        <h2 className="numerals mb-2 text-xl font-bold text-ink">Pays its own way</h2>
        <div className="space-y-1 text-[0.95rem]">
          <div className="flex justify-between">
            <span className="text-ink-soft">Fees earned ({s.economics.giftsWithFees} gifts)</span>
            <span className="numerals">{usd(s.economics.feesEarnedUsd)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-ink-soft">Spent on hosting and services</span>
            <span className="numerals">{usd(s.economics.spentUsd)}</span>
          </div>
          <div className="flex justify-between border-t border-rule pt-1 font-semibold">
            <span>Net</span>
            <span className="numerals">{usd(s.economics.netUsd)}</span>
          </div>
        </div>
        <p className="mt-1 text-xs text-ink-soft">Each gift carries a small fee, paid through B402 into the vault.</p>
      </section>

      {!s.agent.liveTrading ? <p className="text-xs text-ink-soft">Test mode: no real money or stock moves on this server.</p> : null}
    </div>
  );
}
