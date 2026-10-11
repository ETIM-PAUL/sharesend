"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { agent, groupApi, type GiftQuote } from "@/lib/agent";
import { countdown, usd } from "@/lib/format";
import { getSenderName, saveSenderName, saveSent } from "@/lib/sent";
import { useHydrated } from "@/lib/useHydrated";
import { Certificate } from "./Certificate";
import { StockPicker, type Stock } from "./StockPicker";
import { PayPanel, type PaidResult } from "./PayPanel";
import { GiftProgress, useGift } from "./GiftProgress";
import { ShareCard } from "./ShareCard";
import { Button, Field, Input, Notice, TextArea } from "./ui";
import { ReturnChoice, type ReturnAs } from "./ReturnChoice";
import { ChatPanel } from "./ChatPanel";
import { readWhen, toLocalInput, WHEN_NOW, WhenChoice, type When } from "./WhenChoice";
import type { GiftDraft } from "@/lib/agent";

const AMOUNTS = [5, 10, 20];

/** Price, payment and the sent screen stay one phone-width column, centred in the wider page. */
const Narrow = ({ children }: { children: React.ReactNode }) => <div className="mx-auto max-w-[460px]">{children}</div>;

type Stage = "details" | "quote" | "pay" | "sent" | "group";

/** How long a group gift collects before the agent buys it. */
const GROUP_DAYS = [1, 3, 7];

export function SendFlow() {
  const [stage, setStage] = useState<Stage>("details");
  const [stock, setStock] = useState<Stock | null>(null);
  const [amount, setAmount] = useState("10");
  const [recipient, setRecipient] = useState("");
  const [message, setMessage] = useState("");
  // null until the sender types; then the saved name from last time (only readable in the browser) fills in.
  const [senderInput, setSenderInput] = useState<string | null>(null);
  const hydrated = useHydrated();
  const sender = senderInput ?? (hydrated ? getSenderName() : "");
  const setSender = (v: string) => setSenderInput(v);
  const [returnAs, setReturnAs] = useState<ReturnAs>("stock");
  const [isGroup, setIsGroup] = useState(false);
  const [groupDays, setGroupDays] = useState(3);
  const [when, setWhen] = useState<When>(WHEN_NOW);
  const [orderText, setOrderText] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const [quote, setQuote] = useState<GiftQuote | null>(null);
  const [paid, setPaid] = useState<PaidResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usdNum = Number(amount);
  const whenRead = readWhen(when);

  /** What's still missing from the form, in the order the fields appear. */
  function missing(): { field: string; text: string }[] {
    const m: { field: string; text: string }[] = [];
    if (!stock) m.push({ field: "stock", text: "pick a stock" });
    if (!isGroup && !(usdNum >= 1)) m.push({ field: "amount", text: "enter an amount of at least $1" });
    if (!recipient.trim()) m.push({ field: "recipient-name", text: "say who it's for" });
    if (!sender.trim()) m.push({ field: "sender-name", text: "add your name" });
    return m;
  }

  const focusField = (id: string) => setTimeout(() => document.getElementById(id)?.focus(), 0);

  /** A chat draft fills in the form. Nothing is sent or bought until you've checked it and paid. */
  function applyDraft(d: GiftDraft, text: string) {
    setStock({ ticker: d.ticker, name: d.companyName });
    setIsGroup(!!d.group);
    if (d.group) setGroupDays(d.group.days);
    else setAmount(String(d.usd));
    setRecipient(d.recipientName);
    setMessage(d.message);
    setReturnAs(d.returnAs);
    setOrderText(d.order ? text : "");
    setWhen(d.order ? { mode: "drop", dropPct: String(d.order.dropPct), deadline: toLocalInput(new Date(d.order.deadline)) } : WHEN_NOW);
    setError(null);
    // The chat doesn't know the sender's name: if it's still empty, that's where to go next.
    if (!sender.trim()) focusField("sender-name");
    else formRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function getPrice() {
    if (!stock) return;
    const checked = readWhen(when, Date.now());
    if (!checked.ok) return setError(checked.error);
    saveSenderName(sender.trim());
    setLoading(true);
    setError(null);
    try {
      const r = await agent.quote(stock.ticker, usdNum);
      if (!r.ok) return setError(r.message);
      setQuote(r.quote);
      setStage("quote");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function onPaid(r: PaidResult) {
    setPaid(r);
    setStage("sent");
    saveSent({
      id: r.gift.id,
      ticker: quote!.ticker,
      companyName: quote!.name,
      usd: quote!.giftUsd,
      recipientName: recipient.trim(),
      message: message.trim(),
      senderAddress: r.senderAddress,
      sentAt: new Date().toISOString(),
    });
  }

  if (stage === "details")
    return (
      <div>
        <h1 className="numerals max-w-[34rem] text-[2.1rem] font-bold leading-[1.1] text-ink lg:text-5xl">Send someone a piece of a company they love.</h1>
        <p className="mt-3 max-w-[34rem] text-[1rem] text-ink-soft">They get a link on WhatsApp and claim real stock with just their email. You pay in dollar stablecoins.</p>

        {/* Chat on the left, the form it fills in on the right; stacked on a phone. */}
        <div className="mt-7 grid items-start gap-7 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-12">
          <div className="lg:sticky lg:top-6">
            <ChatPanel onDraft={applyDraft} />
          </div>

        <form
          ref={formRef}
          className="scroll-mt-4 space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            const m = missing();
            if (m.length) {
              setError(`Almost there: ${m.map((x) => x.text).join(", ")}.`);
              const first = m[0]!.field;
              if (first === "stock") document.getElementById("stock-picker")?.scrollIntoView({ block: "center" });
              else focusField(first === "amount" ? "custom-amount" : first);
              return;
            }
            if (isGroup) {
              saveSenderName(sender.trim());
              setError(null);
              return setStage("group");
            }
            getPrice();
          }}
        >
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-ink">Who&apos;s paying?</legend>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  [false, "Just me", "You pay, they get a link."],
                  [true, "Friends chip in", "Collect from a group, buy one gift."],
                ] as const
              ).map(([value, label, hint]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setIsGroup(value)}
                  aria-pressed={isGroup === value}
                  className={`rounded-[10px] border px-3.5 py-3 text-left ${isGroup === value ? "border-engrave bg-sheet" : "border-rule"}`}
                >
                  <span className="block text-[0.95rem] font-semibold text-ink">{label}</span>
                  <span className="block text-xs text-ink-soft">{hint}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <StockPicker value={stock} onChange={setStock} />

          {isGroup ? (
          <Field label="Collect for" hint="Then the agent buys the gift with everything raised (up to $20). You can close it sooner.">
            <div className="flex gap-2">
              {[...new Set([...GROUP_DAYS, groupDays])].sort((a, b) => a - b).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setGroupDays(d)}
                  className={`rounded-full border px-4 py-2 ${groupDays === d ? "border-engrave bg-engrave text-on-engrave" : "border-rule bg-sheet text-ink"}`}
                >
                  {d === 1 ? "1 day" : `${d} days`}
                </button>
              ))}
            </div>
          </Field>
          ) : (
          <Field label="Amount in US dollars" hint="From $1 to $20 per gift. Ondo stocks need more than $5.">
            <div className="flex gap-2">
              {AMOUNTS.map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setAmount(String(a))}
                  className={`numerals rounded-full border px-4 py-2 text-lg ${Number(amount) === a ? "border-engrave bg-engrave text-on-engrave" : "border-rule bg-sheet text-ink"}`}
                >
                  ${a}
                </button>
              ))}
              <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} aria-label="Custom amount" id="custom-amount" className="numerals !w-24 text-lg" />
            </div>
          </Field>
          )}

          <Field label="Who is it for?">
            <Input id="recipient-name" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="Ada" maxLength={60} />
          </Field>

          <Field label="A note for them" hint="Optional. They'll see it when they open the gift.">
            <TextArea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Happy birthday! Your first shares." maxLength={280} />
          </Field>

          <Field label="Your name">
            <Input id="sender-name" value={sender} onChange={(e) => setSender(e.target.value)} placeholder="Your first name" maxLength={60} autoComplete="given-name" />
          </Field>

          {isGroup ? null : <WhenChoice value={when} onChange={setWhen} />}

          {isGroup ? null : <ReturnChoice value={returnAs} onChange={setReturnAs} />}

          {error ? <Notice kind="error">{error}</Notice> : null}
          <Button type="submit" disabled={loading}>
            {isGroup ? "Start the group gift" : loading ? "Getting the price…" : "See the price"}
          </Button>
        </form>
        </div>
      </div>
    );

  if (stage === "group" && stock)
    return (
      <Narrow>
        <GroupStart ticker={stock.ticker} companyName={stock.name} recipient={recipient.trim()} sender={sender.trim()} message={message.trim()} days={groupDays} onBack={() => setStage("details")} />
      </Narrow>
    );

  if (stage === "quote" && quote)
    return (
      <Narrow>
        <QuoteStage order={whenRead.ok ? whenRead.order : null} quote={quote} recipient={recipient} sender={sender} message={message} onBack={() => setStage("details")} onRefresh={getPrice} onPay={() => setStage("pay")} loading={loading} error={error} />
      </Narrow>
    );

  if (stage === "pay" && quote)
    return (
      <Narrow>
      <div className="space-y-5">
        <Certificate ticker={quote.ticker} companyName={quote.name} sharesOut={quote.sharesOut} amountUsd={quote.giftUsd} issuerLabel={quote.issuerLabel} recipientName={recipient} senderName={sender} message={message} />
        <PayPanel
          ticker={quote.ticker}
          amountUsd={quote.giftUsd}
          senderName={sender.trim()}
          recipientName={recipient.trim()}
          message={message.trim()}
          returnAs={returnAs}
          order={whenRead.ok && whenRead.order ? { ...whenRead.order, text: orderText || undefined } : undefined}
          onPaid={onPaid}
          onExpired={() => {
            setError("The held price ran out. Here's a fresh one.");
            getPrice();
          }}
        />
        <Button variant="quiet" onClick={() => setStage("quote")}>
          Back
        </Button>
      </div>
      </Narrow>
    );

  if (stage === "sent" && quote && paid)
    return (
      <Narrow>
        <SentStage quote={quote} paid={paid} recipient={recipient} sender={sender} message={message} />
      </Narrow>
    );

  return null;
}

function QuoteStage(p: { order: { dropPct: number; deadline: string } | null; quote: GiftQuote; recipient: string; sender: string; message: string; onBack: () => void; onRefresh: () => void; onPay: () => void; loading: boolean; error: string | null }) {
  const q = p.quote;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = q.expiresAt - now;
  return (
    <div className="space-y-5">
      <Certificate ticker={q.ticker} companyName={q.name} sharesOut={q.sharesOut} amountUsd={q.giftUsd} issuerLabel={q.issuerLabel} recipientName={p.recipient} senderName={p.sender} message={p.message} />

      <div className="space-y-1.5 text-[0.95rem]">
        <Row label={`${q.name} at`} value={`${usd(q.pricePerShare)} a share`} />
        <Row label="Gift" value={usd(q.giftUsd)} />
        <Row label="ShareSend fee" value={usd(q.feeUsd)} />
        <div className="flex justify-between border-t border-rule pt-2 font-semibold">
          <span>You pay</span>
          <span className="numerals text-lg">{usd(q.totalUsd)}</span>
        </div>
      </div>

      <p className="text-sm text-ink-soft">{q.reason}.</p>
      {p.order ? (
        <Notice>
          <span className="font-semibold">Waits for the price.</span> You pay {usd(q.totalUsd)} now. The agent buys only if {q.ticker} falls to about {usd(q.pricePerShare * (1 - p.order.dropPct / 100))} ({p.order.dropPct}% below today&apos;s {usd(q.pricePerShare)}) before{" "}
          {new Date(p.order.deadline).toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" })}. If it doesn&apos;t, you&apos;re refunded in full. You can cancel any time before it buys.
        </Notice>
      ) : null}
      {q.warnings
        .filter((w) => w.code === "WEEKEND_PREMIUM")
        .map((w) => (
          <Notice key={w.code}>
            The US stock market is closed, so this price is above the last close.
            {w.nextOpenTime ? ` It reopens ${new Date(w.nextOpenTime).toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" })}.` : ""} You can still send now, or wait for a closer price.
          </Notice>
        ))}

      {p.error ? <Notice kind="error">{p.error}</Notice> : null}
      {left > 0 ? (
        <>
          <Button onClick={p.onPay}>{p.order ? `Pay ${usd(q.totalUsd)} and wait for the price` : `Pay ${usd(q.totalUsd)}`}</Button>
          <p className="text-center text-xs text-ink-soft">Price good for {countdown(left)}</p>
        </>
      ) : (
        <Button onClick={p.onRefresh} disabled={p.loading}>
          {p.loading ? "Getting a new price…" : "Get a new price"}
        </Button>
      )}
      <Button variant="quiet" onClick={p.onBack}>
        Change details
      </Button>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-ink">
      <span className="text-ink-soft">{label}</span>
      <span>{value}</span>
    </div>
  );
}

function SentStage({ quote, paid, recipient, sender, message }: { quote: GiftQuote; paid: PaidResult; recipient: string; sender: string; message: string }) {
  const { gift } = useGift(paid.gift.id, paid.gift);
  return (
    <div className="space-y-6">
      <Certificate ticker={quote.ticker} companyName={quote.name} sharesOut={quote.sharesOut} amountUsd={quote.giftUsd} issuerLabel={quote.issuerLabel} recipientName={recipient} senderName={sender} message={message} sealed />
      {paid.claimUrl ? (
        <ShareCard url={paid.claimUrl} recipientName={recipient.trim()} amountUsd={quote.giftUsd} companyName={quote.name} message={message.trim()} />
      ) : (
        <Notice>This gift was already paid. You can get a new claim link from the gift&apos;s page.</Notice>
      )}
      {gift ? (
        <section>
          <h2 className="mb-3 text-sm font-medium text-ink-soft">Where it is now</h2>
          <GiftProgress gift={gift} />
        </section>
      ) : null}
      <Link href={`/sent/${paid.gift.id}`} className="block text-center text-sm text-engrave underline underline-offset-4">
        Open this gift&apos;s page
      </Link>
    </div>
  );
}

/** Signs the organizer in (their wallet gets any unclaimed gift back), creates the group and opens its page. */
function GroupStart(p: { ticker: string; companyName: string; recipient: string; sender: string; message: string; days: number; onBack: () => void }) {
  const { ready, authenticated, login } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wallet = wallets.find((w) => !w.walletClientType.startsWith("privy")) ?? wallets[0];

  async function start() {
    if (!wallet) return;
    setBusy(true);
    setError(null);
    try {
      const g = await groupApi.create({
        ticker: p.ticker,
        organizerAddress: wallet.address,
        organizerName: p.sender,
        recipientName: p.recipient,
        message: p.message,
        closesAt: new Date(Date.now() + p.days * 86_400_000).toISOString(),
      });
      router.push(`/g/${g.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <h1 className="numerals text-[1.8rem] font-bold leading-tight text-ink">A group gift of {p.companyName} for {p.recipient}</h1>
      <p className="text-[0.95rem] text-ink">
        You&apos;ll get a link to share with friends. Each of you chips in what you like (you too) and adds a note. In {p.days === 1 ? "1 day" : `${p.days} days`}, or sooner if you close it, the agent buys one gift with everything raised, and you send {p.recipient} the claim link.
      </p>
      {!ready ? (
        <p className="text-sm text-ink-soft">Loading…</p>
      ) : !authenticated ? (
        <Button onClick={login}>Sign in to start</Button>
      ) : !walletsReady || !wallet ? (
        <p className="text-sm text-ink-soft">Connecting your wallet…</p>
      ) : (
        <>
          <p className="text-sm text-ink-soft">Organizing from {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}. If {p.recipient} doesn&apos;t claim the gift in 30 days, it comes back to this wallet.</p>
          <Button onClick={start} disabled={busy}>
            {busy ? "Starting…" : "Start the group gift"}
          </Button>
        </>
      )}
      {error ? <Notice kind="error">{error}</Notice> : null}
      <Button variant="quiet" onClick={p.onBack}>
        Back
      </Button>
    </div>
  );
}
