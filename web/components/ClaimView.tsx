"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { AgentError, claimApi, type ClaimViewData } from "@/lib/agent";
import { shortAddr, usd } from "@/lib/format";
import { useHydrated } from "@/lib/useHydrated";
import { Certificate } from "./Certificate";
import { Sparkline } from "./Sparkline";
import { Button, Input, Notice } from "./ui";

const codeKey = (id: string) => `sharesend:claim:${id}`;

/** The claim code lives in the link's #fragment. Read it without side effects; the effect below moves it to sessionStorage. */
function readCode(id: string): string | null {
  const fromHash = window.location.hash.slice(1);
  if (fromHash) return decodeURIComponent(fromHash);
  try {
    return sessionStorage.getItem(codeKey(id));
  } catch {
    return null;
  }
}

export function ClaimView() {
  const { id } = useParams<{ id: string }>();
  const hydrated = useHydrated();
  const code = hydrated ? readCode(id) : null;
  const [data, setData] = useState<ClaimViewData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Keep the code for this tab only and take it out of the address bar (so it isn't in screenshots or history).
  useEffect(() => {
    if (!hydrated || !window.location.hash) return;
    try {
      sessionStorage.setItem(codeKey(id), decodeURIComponent(window.location.hash.slice(1)));
      history.replaceState(null, "", window.location.pathname);
    } catch {
      // Storage blocked: keep the fragment so a refresh still works.
    }
  }, [hydrated, id]);

  // Load the gift, and keep it fresh while it's being bought or claimed.
  const status = data?.gift.status;
  useEffect(() => {
    if (!code) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const v = await claimApi.view(id, code);
        if (stop) return;
        setData(v);
        setError(null);
        const s = v.gift.status;
        if (s === "PAID" || s === "BUYING") timer = setTimeout(load, 10_000);
        if (s === "CLAIMING") timer = setTimeout(load, 3_000);
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
    };
    load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [id, code, status]);

  if (hydrated && !code) return <Notice kind="error">This link is missing its code. Open the full link you were sent, or ask the sender for a new one.</Notice>;
  if (error && !data) return <Notice kind="error">{error}</Notice>;
  if (!data) return <p className="text-sm text-ink-soft">Opening your gift…</p>;

  const g = data.gift;
  const s = data.stock;
  const sealed = !["AWAITING_PAYMENT", "EXPIRED"].includes(g.status);

  return (
    <div className="space-y-6">
      <p className="text-[1.05rem] text-ink">
        {g.contributors.length > 1
          ? `${names(g.contributors.map((c) => c.name))} chipped in to send you a piece of ${s?.companyName ?? g.ticker}.`
          : `${g.senderName} sent you a piece of ${s?.companyName ?? g.ticker}.`}
      </p>

      <Certificate
        ticker={g.ticker}
        companyName={s?.companyName ?? g.ticker}
        sharesOut={g.shares ?? 0}
        amountUsd={g.valueNowUsd ?? g.usdSent}
        issuerLabel={s?.issuerLabel ?? "tokenized"}
        recipientName={g.recipientName}
        senderName={g.senderName}
        message={g.message}
        sealed={sealed}
      />

      {g.contributors.length > 1 ? <FromEveryone contributors={g.contributors} /> : null}

      <ValueNow data={data} />

      <ClaimPanel id={id} code={code!} data={data} onClaimed={(st) => setData({ ...data, gift: { ...g, status: st } })} />

      <Explainer data={data} />
      {g.dryRun ? <p className="text-xs text-ink-soft">Test gift: no real money or stock moves.</p> : null}
    </div>
  );
}

/** "Ada", "Ada and Bisi", "Ada, Bisi and Chi" */
function names(list: string[]): string {
  const u = [...new Set(list)];
  return u.length <= 1 ? (u[0] ?? "") : `${u.slice(0, -1).join(", ")} and ${u.at(-1)}`;
}

function FromEveryone({ contributors }: { contributors: ClaimViewData["gift"]["contributors"] }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-ink-soft">From everyone who chipped in</h2>
      <ul className="space-y-2">
        {contributors.map((c, i) => (
          <li key={i} className="rounded-[10px] bg-sheet px-3.5 py-2.5">
            <p className="text-[0.95rem] font-semibold text-ink">{c.name}</p>
            {c.note ? <p className="text-[0.95rem] italic text-ink">{c.note}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ValueNow({ data }: { data: ClaimViewData }) {
  const g = data.gift;
  if (g.valueNowUsd === null) return null;
  const diff = g.valueNowUsd - g.usdSent;
  return (
    <section>
      <p className="text-sm text-ink-soft">Worth about</p>
      <p className="numerals text-4xl font-bold text-ink">{usd(g.valueNowUsd)}</p>
      <p className="mt-1 text-sm text-ink-soft">
        {usd(g.usdSent)} when {g.senderName} sent it
        {Math.abs(diff) >= 0.01 ? `, ${diff > 0 ? "up" : "down"} ${usd(Math.abs(diff))} since` : ""}. The value moves with {data.stock?.companyName ?? g.ticker}&apos;s share price.
      </p>
      <div className="mt-3">
        <Sparkline points={data.series} label="Value since it was sent" />
      </div>
    </section>
  );
}

function ClaimPanel({ id, code, data, onClaimed }: { id: string; code: string; data: ClaimViewData; onClaimed: (s: ClaimViewData["gift"]["status"]) => void }) {
  const g = data.gift;
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const emailWallet = wallets.find((w) => w.walletClientType.startsWith("privy")) ?? wallets[0];
  const [mode, setMode] = useState<"email" | "paste">("email");
  const [claimAs, setClaimAs] = useState<"stock" | "usdt">("stock");
  const [pasted, setPasted] = useState("");
  const [eligible, setEligible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (g.status === "CLAIMED" && g.cashedOutUsdt !== null)
    return (
      <section className="space-y-3 rounded-[10px] bg-sheet p-4">
        <p className="numerals text-2xl font-bold text-ink">You got {usd(g.cashedOutUsdt)}.</p>
        <p className="text-[0.95rem] text-ink">The shares were sold and the dollars (USDT) are in your wallet, {g.claimAddress ? shortAddr(g.claimAddress) : "on BNB Chain"}.</p>
        <Link href="/wallet">
          <Button>Open your wallet</Button>
        </Link>
        {g.claimTx ? (
          <a className="block text-center text-sm text-engrave underline underline-offset-4" href={`https://bscscan.com/tx/${g.claimTx}`} target="_blank" rel="noopener noreferrer">
            The payment on BscScan
          </a>
        ) : null}
      </section>
    );

  if (g.status === "CLAIMED")
    return (
      <section className="space-y-3 rounded-[10px] bg-sheet p-4">
        <p className="numerals text-2xl font-bold text-ink">It&apos;s yours.</p>
        <p className="text-[0.95rem] text-ink">The shares are in your wallet. You can see them, and what they&apos;re worth, any time.</p>
        {g.payoutNote ? <p className="text-sm text-ink-soft">{g.payoutNote}</p> : null}
        <Link href={g.claimAddress ? `/you?address=${g.claimAddress}` : "/you"}>
          <Button>See your stock</Button>
        </Link>
        {g.claimTx ? (
          <a className="block text-center text-sm text-engrave underline underline-offset-4" href={`https://bscscan.com/tx/${g.claimTx}`} target="_blank" rel="noopener noreferrer">
            The transfer on BscScan
          </a>
        ) : null}
      </section>
    );

  if (g.status === "CLAIMING")
    return (
      <Notice>
        {g.claimAs === "usdt" ? "Selling the shares and sending you the dollars. This can take a few minutes; this page updates by itself." : "Sending your shares to your wallet. This usually takes under a minute."}
      </Notice>
    );
  if (g.status === "PAID" || g.status === "BUYING") return <Notice>Your stock hasn&apos;t been bought yet. This page updates by itself, and you can claim it as soon as it&apos;s ready.</Notice>;
  if (g.status === "AWAITING_PAYMENT") return <Notice>This gift hasn&apos;t been paid for yet.</Notice>;
  if (g.status === "READY" && g.expired) return <Notice kind="error">This gift wasn&apos;t claimed in time, so it&apos;s going back to {g.senderName}.</Notice>;
  if (g.status !== "READY")
    return (
      <Notice kind="error">
        {g.status === "RETURNED" || g.status === "RETURNING" ? "The sender cancelled this gift." : g.status === "EXPIRED" ? "This gift is no longer available." : "This gift was refunded to the sender."}
      </Notice>
    );

  const address = mode === "email" ? (authenticated ? emailWallet?.address : undefined) : pasted.trim();
  const addressOk = !!address && /^0x[0-9a-fA-F]{40}$/.test(address);

  async function claim() {
    if (!addressOk || !eligible) return;
    setBusy(true);
    setError(null);
    try {
      const r = await claimApi.claim(id, code, address!, claimAs);
      onClaimed(r.status);
    } catch (e) {
      setError(e instanceof AgentError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4">
      <h2 className="numerals text-2xl font-bold text-ink">Claim your shares</h2>

      {mode === "email" ? (
        authenticated && emailWallet ? (
          <p className="text-[0.95rem] text-ink">
            They&apos;ll go to your ShareSend wallet, {shortAddr(emailWallet.address)}. Sign in with the same email any time to see them.
          </p>
        ) : (
          <>
            <p className="text-[0.95rem] text-ink">Use your email to get a wallet for your shares. No app to install and no passwords to remember.</p>
            <Button onClick={() => login({ loginMethods: ["email"] })} disabled={!ready}>
              Continue with email
            </Button>
          </>
        )
      ) : (
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink">Your BNB Chain wallet address</span>
          <Input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} className="font-mono text-sm" />
          {pasted && !addressOk ? <span className="mt-1 block text-xs text-error-ink">That doesn&apos;t look like a wallet address (0x followed by 40 characters).</span> : null}
        </label>
      )}

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-ink">How do you want it?</legend>
        <div className="space-y-2">
          {(
            [
              ["stock", "The shares", `Keep your piece of ${data.stock?.companyName ?? g.ticker}. Its value moves with the share price.`],
              ["usdt", "Dollars (USDT)", `We sell the shares and send you about ${g.valueNowUsd !== null ? usd(g.valueNowUsd) : "their value"} in USDT on BNB Chain: what they sell for, a little more or less. If they can't be sold right now, you get the shares instead.`],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value} className={`flex cursor-pointer items-start gap-3 rounded-[10px] border px-3.5 py-3 ${claimAs === value ? "border-engrave bg-sheet" : "border-rule"}`}>
              <input type="radio" name="claim-as" className="mt-1 accent-[var(--engrave)]" checked={claimAs === value} onChange={() => setClaimAs(value)} />
              <span>
                <span className="block text-[0.95rem] text-ink">{label}</span>
                <span className="block text-xs text-ink-soft">{hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="flex items-start gap-3 text-sm text-ink">
        <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--engrave)]" checked={eligible} onChange={(e) => setEligible(e.target.checked)} />
        <span>
          I&apos;m allowed to own tokenized US stocks where I live. They aren&apos;t offered to people in the United States and some other countries.
        </span>
      </label>

      {(mode === "paste" || (authenticated && emailWallet)) && (
        <Button onClick={claim} disabled={!addressOk || !eligible || busy}>
          {busy ? "Claiming…" : claimAs === "usdt" ? "Claim as dollars" : "Claim my shares"}
        </Button>
      )}

      {error ? <Notice kind="error">{error}</Notice> : null}
      {!error && g.claimError ? (
        <Notice kind="error">
          The last try couldn&apos;t send the shares to that wallet, so nothing moved. Try a different address, or use your email.
          <span className="mt-1 block text-xs opacity-80">Details: {g.claimError}</span>
        </Notice>
      ) : null}

      <button className="w-full text-sm text-engrave underline underline-offset-4" onClick={() => setMode(mode === "email" ? "paste" : "email")}>
        {mode === "email" ? "I already have a BNB Chain wallet" : "Use my email instead"}
      </button>
      {g.claimExpiresAt ? (
        <p className="text-xs text-ink-soft">
          Claim by {new Date(g.claimExpiresAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}, or it goes back to {g.senderName}.
        </p>
      ) : null}
    </section>
  );
}

function Explainer({ data }: { data: ClaimViewData }) {
  const s = data.stock;
  const g = data.gift;
  if (!s) return null;
  return (
    <section className="space-y-4 border-t border-rule pt-5">
      <details className="group">
        <summary className="cursor-pointer text-[0.95rem] font-semibold text-ink">What is this?</summary>
        <div className="mt-2 space-y-2 text-[0.95rem] text-ink">
          <p>
            It&apos;s a token on BNB Chain that follows the price of {s.companyName} shares: {g.shares ? `about ${g.shares.toFixed(4)} of a share` : "a slice of a share"}. When the share price goes up or down, so does your gift.
          </p>
          <p>
            It&apos;s issued by {s.issuerLabel}, which says each token is backed by real shares it holds.{" "}
            {s.attestationUrl ? (
              <a className="text-engrave underline underline-offset-4" href={s.attestationUrl} target="_blank" rel="noopener noreferrer">
                Read the backing report
              </a>
            ) : s.issuerWebsite ? (
              <a className="text-engrave underline underline-offset-4" href={s.issuerWebsite} target="_blank" rel="noopener noreferrer">
                About {s.issuerLabel}
              </a>
            ) : null}
          </p>
          <p>
            You can keep it, or later move it to another wallet. Once it&apos;s in your wallet, ShareSend can&apos;t move it. Like any stock issuer, {s.issuerLabel} can pause or restrict its
            tokens to follow the law.
          </p>
        </div>
      </details>

      {s.profile.description ? (
        <details>
          <summary className="cursor-pointer text-[0.95rem] font-semibold text-ink">About {s.companyName}</summary>
          <div className="mt-2 space-y-2 text-[0.95rem] text-ink">
            <p className="line-clamp-6">{s.profile.description}</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              {s.profile.industry ? (
                <>
                  <dt className="text-ink-soft">Industry</dt>
                  <dd>{s.profile.industry}</dd>
                </>
              ) : null}
              {s.profile.ceo ? (
                <>
                  <dt className="text-ink-soft">CEO</dt>
                  <dd>{s.profile.ceo}</dd>
                </>
              ) : null}
              <dt className="text-ink-soft">Share price</dt>
              <dd>
                {usd(s.pricePerShare)}
                {s.marketOpen ? "" : " (market closed)"}
              </dd>
            </dl>
            {s.profile.website ? (
              <a className="text-sm text-engrave underline underline-offset-4" href={s.profile.website} target="_blank" rel="noopener noreferrer">
                {s.profile.website.replace(/^https?:\/\/(www\.)?/, "")}
              </a>
            ) : null}
          </div>
        </details>
      ) : null}
    </section>
  );
}
