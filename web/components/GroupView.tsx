"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useWallets } from "@privy-io/react-auth";
import { createWalletClient, custom } from "viem";
import { bsc } from "viem/chains";
import { groupApi, groupMessage, type GroupActionName, type PublicGroup } from "@/lib/agent";
import { shortAddr, usd } from "@/lib/format";
import { getSenderName, saveSenderName, saveSent } from "@/lib/sent";
import { useHydrated } from "@/lib/useHydrated";
import { PayPanel } from "./PayPanel";
import { ShareCard } from "./ShareCard";
import { Button, Field, Input, Notice, TextArea } from "./ui";

const CHIP_IN = [1, 2, 5];

/** A group gift: who it's for, what's been raised, who chipped in, and a way to chip in or (organizer) close it. */
export function GroupView() {
  const { id } = useParams<{ id: string }>();
  const [group, setGroup] = useState<PublicGroup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claimUrl, setClaimUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setGroup(await groupApi.get(id));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await load();
      if (!stop) timer = setTimeout(tick, 10_000);
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [load]);

  if (error && !group) return <Notice kind="error">{error}</Notice>;
  if (!group) return <p className="text-sm text-ink-soft">Opening the group gift…</p>;

  const company = group.companyName ?? group.ticker;
  const open = group.status === "OPEN" && !group.closing;
  const pct = Math.min(100, Math.round((group.raisedUsd / group.maxUsd) * 100));

  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm text-ink-soft">A group gift for {group.recipientName}</p>
        <h1 className="numerals mt-1 text-[2rem] font-bold leading-tight text-ink">A piece of {company}</h1>
        <p className="mt-2 text-[0.95rem] text-ink">
          {group.organizerName} is collecting for {group.recipientName}. Everyone&apos;s money buys one gift of {group.ticker}, and {group.recipientName} gets it with a note from each of you.
        </p>
        {group.message ? <blockquote className="mt-3 border-l-2 border-engrave pl-3 text-[0.95rem] italic text-ink">{group.message}</blockquote> : null}
      </header>

      <section aria-label="Raised so far">
        <div className="flex items-end justify-between">
          <p className="numerals text-4xl font-bold text-ink">{usd(group.raisedUsd)}</p>
          <p className="text-sm text-ink-soft">
            from {group.contributors.length} {group.contributors.length === 1 ? "person" : "people"} · up to {usd(group.maxUsd)}
          </p>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-sheet" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-engrave" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-2 text-xs text-ink-soft">
          {group.status === "OPEN"
            ? group.closing
              ? "Closing now: the agent is buying the gift."
              : `Open until ${new Date(group.closesAt).toLocaleString(undefined, { weekday: "long", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}.`
            : null}
        </p>
      </section>

      <Outcome group={group} claimUrl={claimUrl} />

      {group.contributors.length ? (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-ink-soft">Who chipped in</h2>
          <ul className="space-y-2">
            {group.contributors.map((c, i) => (
              <li key={i} className="flex items-start justify-between gap-3 rounded-[10px] bg-sheet px-3.5 py-2.5">
                <span>
                  <span className="block text-[0.95rem] font-semibold text-ink">{c.name}</span>
                  {c.note ? <span className="block text-[0.95rem] italic text-ink">{c.note}</span> : null}
                </span>
                <span className="numerals text-[0.95rem] text-ink">{usd(c.usd)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {open ? <ChipIn group={group} onPaid={load} /> : null}
      {open ? <Invite group={group} /> : null}
      <OrganizerControls group={group} onDone={(g, url) => (setGroup(g), url ? setClaimUrl(url) : null)} />
      {group.dryRun ? <p className="text-xs text-ink-soft">Test mode: signatures are checked but nothing is charged.</p> : null}
    </div>
  );
}

function Outcome({ group, claimUrl }: { group: PublicGroup; claimUrl: string | null }) {
  if (group.status === "CANCELLED")
    return <Notice>This group gift was cancelled{group.closeReason ? ` (${group.closeReason})` : ""}. Everyone who chipped in gets their money back, fee included.</Notice>;
  if (group.status !== "POOLED" || !group.pooledGift) return null;
  return (
    <section className="space-y-3">
      <Notice>
        Bought together: {usd(group.pooledGift.usd)} of {group.ticker} for {group.recipientName}. {claimUrl ? "" : `${group.organizerName} has the link to send to ${group.recipientName}.`}
      </Notice>
      {claimUrl ? <ShareCard url={claimUrl} recipientName={group.recipientName} amountUsd={group.pooledGift.usd} companyName={group.companyName ?? group.ticker} message={group.message} /> : null}
    </section>
  );
}

function ChipIn({ group, onPaid }: { group: PublicGroup; onPaid: () => void }) {
  const hydrated = useHydrated();
  const [amount, setAmount] = useState("2");
  const [nameInput, setNameInput] = useState<string | null>(null);
  const name = nameInput ?? (hydrated ? getSenderName() : "");
  const [note, setNote] = useState("");
  const [paying, setPaying] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const usdNum = Math.round(Number(amount) * 100) / 100;

  if (done) return <Notice>Thank you, {done}. You&apos;re in: your note goes to {group.recipientName} with the gift.</Notice>;
  if (group.roomUsd < 1) return <Notice>This group gift is full.</Notice>;

  if (paying)
    return (
      <section className="space-y-4">
        <h2 className="numerals text-xl font-bold text-ink">Chip in {usd(usdNum)}</h2>
        <PayPanel
          ticker={group.ticker}
          amountUsd={usdNum}
          senderName={name.trim()}
          recipientName={group.recipientName}
          message={note.trim()}
          returnAs="stock"
          payLabel="Chip in"
          open={(senderAddress) => groupApi.contribute(group.id, { usd: usdNum, senderAddress, senderName: name.trim(), note: note.trim() })}
          onPaid={() => {
            setDone(name.trim());
            setPaying(false);
            onPaid();
          }}
          onExpired={() => {
            setPaying(false);
            setError("The held price ran out. Start again to chip in.");
          }}
        />
        <Button variant="quiet" onClick={() => setPaying(false)}>
          Back
        </Button>
      </section>
    );

  return (
    <form
      className="space-y-4 border-t border-rule pt-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!(usdNum >= 1)) return setError("Chip in at least $1.");
        if (usdNum > group.roomUsd) return setError(`This group gift can take ${usd(group.roomUsd)} more.`);
        if (!name.trim()) return setError("Add your name, so they know it's from you.");
        saveSenderName(name.trim());
        setError(null);
        setPaying(true);
      }}
    >
      <h2 className="numerals text-xl font-bold text-ink">Chip in</h2>
      <Field label="Amount in US dollars" hint={`Up to ${usd(group.roomUsd)} more. A $0.10 fee is added to each payment.`}>
        <div className="flex gap-2">
          {CHIP_IN.filter((a) => a <= group.roomUsd).map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => setAmount(String(a))}
              className={`numerals rounded-full border px-4 py-2 text-lg ${Number(amount) === a ? "border-engrave bg-engrave text-on-engrave" : "border-rule bg-sheet text-ink"}`}
            >
              ${a}
            </button>
          ))}
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} aria-label="Custom amount" className="numerals !w-24 text-lg" />
        </div>
      </Field>
      <Field label="Your name">
        <Input value={name} onChange={(e) => setNameInput(e.target.value)} placeholder="Your first name" maxLength={60} autoComplete="given-name" />
      </Field>
      <Field label={`A note for ${group.recipientName}`} hint="Optional. It goes with the gift.">
        <TextArea value={note} onChange={(e) => setNote(e.target.value)} placeholder="So proud of you!" maxLength={280} />
      </Field>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <Button type="submit">Chip in {usdNum >= 1 ? usd(usdNum) : ""}</Button>
      <p className="text-xs text-ink-soft">
        If the group is cancelled or the stock can&apos;t be bought, you get everything back. If {group.recipientName} doesn&apos;t claim it in 30 days, it goes back to {group.organizerName}.
      </p>
    </form>
  );
}

function Invite({ group }: { group: PublicGroup }) {
  const [copied, setCopied] = useState(false);
  const url = typeof window === "undefined" ? "" : window.location.href.split("#")[0]!;
  const text = `Chip in for ${group.recipientName}'s gift: a piece of ${group.companyName ?? group.ticker} 🎁\n\n${url}`;
  return (
    <section className="space-y-2 border-t border-rule pt-5">
      <h2 className="text-sm font-medium text-ink-soft">Invite friends to chip in</h2>
      <Button variant="whatsapp" onClick={() => window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener")}>
        Share on WhatsApp
      </Button>
      <Button
        variant="quiet"
        onClick={async () => {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        {copied ? "Link copied" : "Copy the group link"}
      </Button>
      <p className="text-xs text-ink-soft">This link is for chipping in. It can&apos;t be used to claim the gift.</p>
    </section>
  );
}

function OrganizerControls({ group, onDone }: { group: PublicGroup; onDone: (g: PublicGroup, claimUrl: string | null) => void }) {
  const { wallets } = useWallets();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const wallet = wallets.find((w) => w.address.toLowerCase() === group.organizerAddress.toLowerCase());

  if (group.status !== "OPEN" || group.closing) {
    if (group.status === "POOLED" && group.pooledGift && wallet)
      return (
        <Link href={`/sent/${group.pooledGift.id}`} className="block text-center text-sm text-engrave underline underline-offset-4">
          Open the gift&apos;s page (status, new claim link, cancel)
        </Link>
      );
    return null;
  }
  if (!wallet)
    return <p className="text-xs text-ink-soft">Organized by {group.organizerName} ({shortAddr(group.organizerAddress)}). Only they can close it early or cancel it.</p>;

  async function run(action: GroupActionName) {
    setError(null);
    setBusy(action === "close" ? "Confirm in your wallet to close and buy…" : "Confirm in your wallet to cancel…");
    try {
      await wallet!.switchChain(56);
      const client = createWalletClient({ chain: bsc, transport: custom(await wallet!.getEthereumProvider()) });
      const message = groupMessage(action, group.id, new Date().toISOString());
      const signature = await client.signMessage({ account: wallet!.address as `0x${string}`, message });
      setBusy(action === "close" ? "Buying the gift…" : "Cancelling…");
      const r = await groupApi.action(group.id, action, message, signature);
      if (r.group.pooledGift)
        saveSent({
          id: r.group.pooledGift.id,
          ticker: r.group.ticker,
          companyName: r.group.companyName ?? r.group.ticker,
          usd: r.group.pooledGift.usd,
          recipientName: r.group.recipientName,
          message: r.group.message,
          senderAddress: r.group.organizerAddress,
          sentAt: new Date().toISOString(),
        });
      onDone(r.group, r.claimUrl ?? null);
    } catch (e) {
      const m = (e as Error).message;
      setError(/user rejected|denied|4001/i.test(m) ? "You cancelled in your wallet. Nothing changed." : m);
    } finally {
      setBusy(null);
      setConfirmCancel(false);
    }
  }

  return (
    <section className="space-y-3 border-t border-rule pt-5">
      <h2 className="text-sm font-medium text-ink-soft">You&apos;re the organizer</h2>
      <p className="text-sm text-ink-soft">
        At the closing time the agent buys the gift by itself. Close it now to buy {group.raisedUsd > 0 ? usd(group.raisedUsd) : "it"} of {group.ticker} right away; you&apos;ll get the link to send to {group.recipientName}.
      </p>
      <Button onClick={() => run("close")} disabled={!!busy || group.raisedUsd <= 0}>
        Close and buy now
      </Button>
      {confirmCancel ? (
        <Button variant="quiet" onClick={() => run("cancel")} disabled={!!busy}>
          Yes, cancel and refund everyone
        </Button>
      ) : (
        <Button variant="quiet" onClick={() => setConfirmCancel(true)} disabled={!!busy}>
          Cancel the group gift
        </Button>
      )}
      {busy ? <p className="text-sm text-ink-soft" aria-live="polite">{busy}</p> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
    </section>
  );
}
