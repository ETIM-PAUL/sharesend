"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AGENT_URL, agentStatus, type AgentStatus } from "@/lib/agent";

/** How another agent sends a stock gift through ShareSend: one URL, x402 over B402, a claim link back. */
export function ForAgentsView() {
  const [s, setS] = useState<AgentStatus | null>(null);
  useEffect(() => {
    agentStatus()
      .then(setS)
      .catch(() => {});
  }, []);

  const body = `{
  "ticker": "NVDA",
  "usd": 5,
  "senderAddress": "0xYourPayingAddress",
  "senderName": "Payroll bot",
  "recipientName": "Ada",
  "message": "Your first share, from the team"
}`;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="numerals text-3xl font-bold text-ink">Send gifts from your agent</h1>
        <p className="mt-2 text-[0.95rem] text-ink">
          Any agent with a wallet can send a person a slice of a US stock: a payroll bot paying a bonus in shares, a rewards system, or another Binance Agentic Wallet. It pays ShareSend over
          x402 (Binance&apos;s B402, on BNB Chain) and gets a claim link to pass on. The person claims it with their email, as shares or as dollars.
        </p>
        {s?.forAgents ? (
          <p className="mt-3 text-sm text-ink-soft">
            {s.forAgents.giftsFromAgents} {s.forAgents.giftsFromAgents === 1 ? "gift has" : "gifts have"} been sent by other agents so far.
          </p>
        ) : null}
      </div>

      <Step n={1} title="Open the gift">
        <p>Send this to the gift endpoint. The answer is <span className="font-mono text-sm">402 Payment Required</span>, with a <span className="font-mono text-sm">PAYMENT-REQUIRED</span> header listing one payment option per stablecoin.</p>
        <Code text={`POST ${AGENT_URL}/gifts\ncontent-type: application/json\n\n${body}`} />
      </Step>

      <Step n={2} title="Sign one option">
        <p>Any x402 v2 client works. With a Binance Agentic Wallet:</p>
        <Code text={`baw x402-payment preview --paymentRequirements "<PAYMENT-REQUIRED header>" --json\nbaw x402-payment sign --paymentId <paymentId> --selectedIndex <index> --json`} />
      </Step>

      <Step n={3} title="Send the same request again, paid">
        <p>
          Repeat step 1 with the header <span className="font-mono text-sm">PAYMENT-SIGNATURE: &lt;paymentHeaderValue&gt;</span>. The answer is <span className="font-mono text-sm">200</span> with the{" "}
          <span className="font-mono text-sm">claimUrl</span> (shown once: deliver it to the person) and the settlement transaction.
        </p>
      </Step>

      <Step n={4} title="Follow it">
        <p>
          <span className="font-mono text-sm">GET {AGENT_URL}/gifts/&lt;id&gt;</span> shows it go from paid to bought to claimed. If it can&apos;t be bought, the payment is refunded to the paying address; unclaimed gifts go back to it after 30 days.
        </p>
      </Step>

      <section className="space-y-2 border-t border-rule pt-5 text-[0.95rem] text-ink">
        <h2 className="numerals text-xl font-bold">Good to know</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>Gifts are $1 to $20 each, plus a $0.10 fee.</li>
          <li>The paying address is the sender: <span className="font-mono text-sm">senderAddress</span> must be the address that signs.</li>
          <li>The claim link is a secret. Anyone with it can claim the gift.</li>
          <li>This endpoint is listed in ShareSend&apos;s on-chain identity (ERC-8004 agent #{s?.identity?.agentId ?? 370811}).</li>
        </ul>
        <div className="flex flex-wrap gap-x-5 gap-y-1 pt-1 text-sm">
          <a className="text-engrave underline underline-offset-4" href={`${AGENT_URL}/skill.md`} target="_blank" rel="noopener noreferrer">
            Skill file for agents
          </a>
          <a className="text-engrave underline underline-offset-4" href={`${AGENT_URL}/.well-known/agent-card.json`} target="_blank" rel="noopener noreferrer">
            Agent card (JSON)
          </a>
          <Link className="text-engrave underline underline-offset-4" href="/agent">
            The ShareSend agent
          </Link>
        </div>
      </section>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="flex gap-3">
      <span aria-hidden className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-engrave text-sm font-bold text-on-engrave">
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-2 text-[0.95rem] text-ink">
        <h2 className="font-semibold">{title}</h2>
        {children}
      </div>
    </section>
  );
}

function Code({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-[10px] border border-rule bg-sheet p-3 pr-16 font-mono text-xs leading-relaxed text-ink">{text}</pre>
      <button
        type="button"
        className="absolute right-2 top-2 rounded-full border border-rule bg-paper px-2.5 py-1 text-xs text-ink-soft hover:text-ink"
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
