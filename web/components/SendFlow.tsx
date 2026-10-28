"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { agent, groupApi, type GiftQuote } from "@/lib/agent";
import { countdown, splitUsd, usd } from "@/lib/format";
import { getSenderName, saveSenderName, saveSent } from "@/lib/sent";
import { useHydrated } from "@/lib/useHydrated";
import { Certificate } from "./Certificate";
import { StockPicker, type Stock } from "./StockPicker";
import { PayPanel, type PaidResult } from "./PayPanel";
import { GiftProgress, useGift } from "./GiftProgress";
import { ShareCard } from "./ShareCard";
import { BasketProgress } from "./BasketProgress";
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
const GROUP_MINUTES = [5, 1440, 3 * 1440, 7 * 1440];

/** "5 minutes", "2 hours", "3 days" */
function duration(minutes: number): string {
  const [n, unit] = minutes % 1440 === 0 ? [minutes / 1440, "day"] : minutes % 60 === 0 ? [minutes / 60, "hour"] : [minutes, "minute"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

export function SendFlow() {
  const [stage, setStage] = useState<Stage>("details");
  const [stock, setStock] = useState<Stock | null>(null);
  // A basket: 2 to 5 stocks, one payment, one claim link. The total is split evenly between the stocks.
  const [isBasket, setIsBasket] = useState(false);
  const [basketStocks, setBasketStocks] = useState<Stock[]>([]);
  const [basketQuotes, setBasketQuotes] = useState<GiftQuote[]>([]);
  const [amount, setAmount] = useState("10");
  const [recipient, setRecipient] = useState("");
  const [message, setMessage] = useState("");
  // null until the sender types; then the saved name from last time (only readable in the browser) fills in.
  const [senderInput, setSenderInput] = useState<string | null>(null);
  const hydrated = useHydrated();
  const sender = senderInput ?? (hydrated ? getSenderName() : "");
  const setSender = (v: string) => setSenderInput(v);
  const [returnAs, setReturnAs] = useState<ReturnAs>("stock");
  // null until the sender picks; /send?group=1 (from the landing page) starts on "Friends chip in".
  const [isGroupInput, setIsGroup] = useState<boolean | null>(null);
  const isGroup = isGroupInput ?? (hydrated ? new URLSearchParams(window.location.search).has("group") : false);
  const [groupMinutes, setGroupMinutes] = useState(3 * 1440);
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
    if (isBasket && !isGroup) {
      if (basketStocks.length < MIN_BASKET) m.push({ field: "stock", text: `pick at least ${MIN_BASKET} stocks` });
      if (!(usdNum >= Math.max(MIN_BASKET, basketStocks.length))) m.push({ field: "amount", text: `enter a total of at least $${Math.max(MIN_BASKET, basketStocks.length)}, so each stock gets $1 or more` });
    } else {
      if (!stock) m.push({ field: "stock", text: "pick a stock" });
      if (!isGroup && !(usdNum >= 1)) m.push({ field: "amount", text: "enter an amount of at least $1" });
    }
    if (!recipient.trim()) m.push({ field: "recipient-name", text: "say who it's for" });
    if (!sender.trim()) m.push({ field: "sender-name", text: "add your name" });
    return m;
  }

  const focusField = (id: string) => setTimeout(() => document.getElementById(id)?.focus(), 0);

  /** A chat draft fills in the form. Nothing is sent or bought until you've checked it and paid. */
  function applyDraft(d: GiftDraft, text: string) {
    setStock({ ticker: d.ticker, name: d.companyName });
    setIsBasket(false);
    setIsGroup(!!d.group);
    if (d.group) setGroupMinutes(d.group.minutes);
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

  async function getBasketPrice() {
    saveSenderName(sender.trim());
    setLoading(true);
    setError(null);
    try {
      const parts = splitUsd(usdNum, basketStocks.length);
      const results = await Promise.all(basketStocks.map((s, i) => agent.quote(s.ticker, parts[i]!)));
      const failed = results.findIndex((r) => !r.ok);
      if (failed >= 0) {
        const r = results[failed]!;
        return setError(`${basketStocks[failed]!.ticker}: ${r.ok ? "" : r.message}`);
      }
      setBasketQuotes(results.map((r) => (r.ok ? r.quote : (null as never))));
      setStage("quote");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function onBasketPaid(r: PaidResult) {
    setPaid(r);
    setStage("sent");
    saveSent({
      id: r.gift.id,
      ticker: basketQuotes.map((q) => q.ticker).join(" · "),
      companyName: `${basketQuotes.length} stocks`,
      usd: Math.round(basketQuotes.reduce((s, q) => s + q.giftUsd, 0) * 100) / 100,
      recipientName: recipient.trim(),
      message: message.trim(),
      senderAddress: r.senderAddress,
      sentAt: new Date().toISOString(),
    });
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
            if (isBasket) return getBasketPrice();
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

          {isGroup ? null : (
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-ink">What are you sending?</legend>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    [false, "One stock", "Pick a company."],
                    [true, "A basket", `${MIN_BASKET} to ${MAX_BASKET} stocks, one link.`],
                  ] as const
                ).map(([value, label, hint]) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => setIsBasket(value)}
                    aria-pressed={isBasket === value}
                    className={`rounded-[10px] border px-3.5 py-3 text-left ${isBasket === value ? "border-engrave bg-sheet" : "border-rule"}`}
                  >
                    <span className="block text-[0.95rem] font-semibold text-ink">{label}</span>
                    <span className="block text-xs text-ink-soft">{hint}</span>
                  </button>
                ))}
              </div>
            </fieldset>
          )}

          {isBasket && !isGroup ? <BasketBuilder stocks={basketStocks} onChange={setBasketStocks} /> : <StockPicker value={stock} onChange={setStock} />}

          {isGroup ? (
          <Field label="Collect for" hint="Then the agent buys the gift with everything raised (up to $20, at least $1 from each friend). You can close it sooner. 5 minutes is handy for a quick demo.">
            <div className="flex flex-wrap gap-2">
              {[...new Set([...GROUP_MINUTES, groupMinutes])].sort((a, b) => a - b).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setGroupMinutes(d)}
                  className={`rounded-full border px-4 py-2 ${groupMinutes === d ? "border-engrave bg-engrave text-on-engrave" : "border-rule bg-sheet text-ink"}`}
                >
                  {duration(d)}
                </button>
              ))}
            </div>
          </Field>
          ) : (
          <Field
            label={isBasket ? "Total in US dollars" : "Amount in US dollars"}
            hint={isBasket ? `Split evenly between the stocks, at least $1 each, up to $20 in total. A $0.10 fee is added for each stock. Ondo stocks need more than $5.` : "From $1 to $20 per gift. Ondo stocks need more than $5."}
          >
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

          {isGroup || isBasket ? null : <WhenChoice value={when} onChange={setWhen} />}

          {isGroup ? null : <ReturnChoice value={returnAs} onChange={setReturnAs} />}

          {error ? <Notice kind="error">{error}</Notice> : null}
          <Button type="submit" disabled={loading}>
            {isGroup ? "Start the group gift" : loading ? "Getting the price…" : "See the price"}
          </Button>
        </form>
        </div>
      </div>
    );

  if (isBasket && !isGroup && basketQuotes.length) {
    const basketItems = basketQuotes.map((q) => ({ ticker: q.ticker, usd: q.giftUsd }));
    const giftTotal = Math.round(basketQuotes.reduce((t, q) => t + q.giftUsd, 0) * 100) / 100;
    const total = Math.round(basketQuotes.reduce((t, q) => t + q.totalUsd, 0) * 100) / 100;
    if (stage === "quote")
      return (
        <Narrow>
          <BasketQuoteStage quotes={basketQuotes} total={total} onBack={() => setStage("details")} onRefresh={getBasketPrice} onPay={() => setStage("pay")} loading={loading} error={error} />
        </Narrow>
      );
    if (stage === "pay")
      return (
        <Narrow>
          <div className="space-y-5">
            <BasketList quotes={basketQuotes} />
            <PayPanel
              ticker="BASKET"
              amountUsd={giftTotal}
              totalUsd={total}
              senderName={sender.trim()}
              recipientName={recipient.trim()}
              message={message.trim()}
              returnAs={returnAs}
              open={(senderAddress) => agent.openBasket({ items: basketItems, senderAddress, senderName: sender.trim(), recipientName: recipient.trim(), message: message.trim(), returnAs })}
              onPaid={onBasketPaid}
              onExpired={() => {
                setError("The held prices ran out. Here are fresh ones.");
                getBasketPrice();
              }}
            />
            <Button variant="quiet" onClick={() => setStage("quote")}>
              Back
            </Button>
          </div>
        </Narrow>
      );
    if (stage === "sent" && paid)
      return (
        <Narrow>
          <BasketSentStage quotes={basketQuotes} paid={paid} recipient={recipient} message={message} />
        </Narrow>
      );
  }

  if (stage === "group" && stock)
    return (
      <Narrow>
        <GroupStart ticker={stock.ticker} companyName={stock.name} recipient={recipient.trim()} sender={sender.trim()} message={message.trim()} minutes={groupMinutes} onBack={() => setStage("details")} />
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
function GroupStart(p: { ticker: string; companyName: string; recipient: string; sender: string; message: string; minutes: number; onBack: () => void }) {
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
        closesAt: new Date(Date.now() + p.minutes * 60_000).toISOString(),
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
        You&apos;ll get a link to share with friends. Each of you chips in what you like (you too) and adds a note. In {duration(p.minutes)}, or sooner if you close it, the agent buys one gift with everything raised, and you send {p.recipient} the claim link.
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

const MIN_BASKET = 2;
const MAX_BASKET = 5;

/** Picks the stocks for a basket: the ones chosen so far (tap to remove), then the usual picker to add another. */
function BasketBuilder({ stocks, onChange }: { stocks: Stock[]; onChange: (s: Stock[]) => void }) {
  const full = stocks.length >= MAX_BASKET;
  return (
    <div id="stock-picker" className="space-y-3">
      <div>
        <span className="mb-1.5 block text-sm font-medium text-ink">
          Stocks in the basket <span className="font-normal text-ink-soft">({stocks.length} of {MIN_BASKET} to {MAX_BASKET})</span>
        </span>
        {stocks.length ? (
          <ul className="flex flex-wrap gap-2">
            {stocks.map((s) => (
              <li key={s.ticker}>
                <button
                  type="button"
                  onClick={() => onChange(stocks.filter((x) => x.ticker !== s.ticker))}
                  aria-label={`Remove ${s.ticker}`}
                  className="rounded-full border border-engrave bg-engrave px-3 py-1.5 text-sm text-on-engrave"
                >
                  <span className="font-semibold">{s.ticker}</span> <span aria-hidden>✕</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-soft">Tap stocks below to add them.</p>
        )}
      </div>
      {full ? (
        <p className="text-sm text-ink-soft">That&apos;s {MAX_BASKET}, the most a basket can hold. Remove one to add another.</p>
      ) : (
        <StockPicker value={null} onChange={(s) => onChange(stocks.some((x) => x.ticker === s.ticker) ? stocks : [...stocks, s])} />
      )}
    </div>
  );
}

function BasketList({ quotes }: { quotes: GiftQuote[] }) {
  return (
    <ul className="divide-y divide-rule border-y border-rule">
      {quotes.map((q) => (
        <li key={q.ticker} className="flex items-center justify-between gap-3 py-3">
          <span>
            <span className="numerals block text-lg font-bold text-engrave">{q.ticker}</span>
            <span className="block text-sm text-ink-soft">
              {q.name} · {q.sharesOut.toFixed(4)} of a share
            </span>
          </span>
          <span className="numerals text-lg text-ink">{usd(q.giftUsd)}</span>
        </li>
      ))}
    </ul>
  );
}

function BasketQuoteStage(p: { quotes: GiftQuote[]; total: number; onBack: () => void; onRefresh: () => void; onPay: () => void; loading: boolean; error: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.min(...p.quotes.map((q) => q.expiresAt)) - now;
  const gift = Math.round(p.quotes.reduce((t, q) => t + q.giftUsd, 0) * 100) / 100;
  const fee = Math.round(p.quotes.reduce((t, q) => t + q.feeUsd, 0) * 100) / 100;
  const closed = p.quotes.some((q) => q.warnings.some((w) => w.code === "WEEKEND_PREMIUM"));
  return (
    <div className="space-y-5">
      <h1 className="numerals text-[1.8rem] font-bold leading-tight text-ink">A basket of {p.quotes.length} stocks</h1>
      <BasketList quotes={p.quotes} />
      <div className="space-y-1.5 text-[0.95rem]">
        <Row label="Gift" value={usd(gift)} />
        <Row label={`ShareSend fee (${usd(p.quotes[0]?.feeUsd ?? 0)} a stock)`} value={usd(fee)} />
        <div className="flex justify-between border-t border-rule pt-2 font-semibold">
          <span>You pay, once</span>
          <span className="numerals text-lg">{usd(p.total)}</span>
        </div>
      </div>
      <p className="text-sm text-ink-soft">One signature pays for every stock. They get one link and claim them all together. If a stock can&apos;t be bought, only that one is refunded.</p>
      {closed ? <Notice>The US stock market is closed, so some prices are above the last close. You can still send now, or wait for a closer price.</Notice> : null}
      {p.error ? <Notice kind="error">{p.error}</Notice> : null}
      {left > 0 ? (
        <>
          <Button onClick={p.onPay}>Pay {usd(p.total)}</Button>
          <p className="text-center text-xs text-ink-soft">Prices good for {countdown(left)}</p>
        </>
      ) : (
        <Button onClick={p.onRefresh} disabled={p.loading}>
          {p.loading ? "Getting new prices…" : "Get new prices"}
        </Button>
      )}
      <Button variant="quiet" onClick={p.onBack}>
        Change details
      </Button>
    </div>
  );
}

function BasketSentStage({ quotes, paid, recipient, message }: { quotes: GiftQuote[]; paid: PaidResult; recipient: string; message: string }) {
  const { gift } = useGift(paid.gift.id, paid.gift);
  const giftTotal = Math.round(quotes.reduce((t, q) => t + q.giftUsd, 0) * 100) / 100;
  const names = quotes.map((q) => q.ticker);
  return (
    <div className="space-y-6">
      <h1 className="numerals text-[1.8rem] font-bold leading-tight text-ink">{usd(giftTotal)} in {quotes.length} stocks, paid</h1>
      <BasketList quotes={quotes} />
      {paid.claimUrl ? (
        <ShareCard url={paid.claimUrl} recipientName={recipient.trim()} amountUsd={giftTotal} companyName={`${names.slice(0, -1).join(", ")} and ${names.at(-1)}`} message={message.trim()} />
      ) : (
        <Notice>This basket was already paid. You can get a new claim link from its page.</Notice>
      )}
      {gift?.basket ? (
        <section>
          <h2 className="mb-3 text-sm font-medium text-ink-soft">Where it is now</h2>
          <BasketProgress basket={gift.basket} recipientName={recipient.trim()} />
        </section>
      ) : null}
      <Link href={`/sent/${paid.gift.id}`} className="block text-center text-sm text-engrave underline underline-offset-4">
        Open this basket&apos;s page
      </Link>
    </div>
  );
}
