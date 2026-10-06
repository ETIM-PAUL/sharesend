// Issuer picker and gift quote builder. Pure functions (no I/O, `now` passed in) so every branch is unit-tested.
import type { IssuerOption, TickerOptions } from "./quote.js";
import { issuerInfo, isTransferable } from "./issuers.js";

export interface QuoteLimits {
  maxGiftUsd: number;
  dailyCapUsd: number;
  /** Gift USD already committed today (from the ledger). */
  dailyUsedUsd: number;
  serviceFeeUsd: number;
  quoteTtlSeconds: number;
  maxPriceImpactPct: number;
  weekendWarnPct: number;
}

/** Issuers' reference prices for the same share disagreeing by more than this gets a warning. */
export const REFERENCE_MISMATCH_PCT = 0.5;

export type RejectCode = "INVALID_AMOUNT" | "OVER_MAX_GIFT" | "OVER_DAILY_CAP" | "NO_ISSUER";

export interface Exclusion {
  issuer: string;
  tokenSymbol: string;
  reason: string;
}

export interface QuoteWarning {
  code: "WEEKEND_PREMIUM" | "REFERENCE_MISMATCH";
  message: string;
  nextOpenTime?: number | null;
}

export interface GiftQuote {
  ticker: string;
  name: string;
  issuer: string;
  issuerLabel: string;
  tokenSymbol: string;
  tokenAddress: string;
  tokenAmount: number;
  tokenAmountRaw: string;
  tokenDecimals: number;
  sharesOut: number;
  pricePerShare: number;
  referencePrice: number;
  premiumPct: number;
  priceImpactPct: number;
  giftUsd: number;
  feeUsd: number;
  totalUsd: number;
  /** Plain-language reason for the issuer choice, shown to the sender. */
  reason: string;
  warnings: QuoteWarning[];
  market: { open: boolean; nextOpenTime: number | null; source: "issuer" | "calendar" };
  alternatives: { issuer: string; tokenSymbol: string; pricePerShare: number; premiumPct: number }[];
  excluded: Exclusion[];
  quoteId: string;
  quotedAt: number;
  expiresAt: number;
}

export type GiftQuoteResult = { ok: true; quote: GiftQuote } | { ok: false; code: RejectCode; message: string; excluded?: Exclusion[] };

type Priced = IssuerOption & { quote: NonNullable<IssuerOption["quote"]> };

const usd = (n: number) => `$${n.toFixed(2)}`;
const label = (issuer: string) => issuerInfo(issuer)?.label ?? issuer;

// ---- Caps ----

export function checkCaps(giftUsd: number, l: QuoteLimits): { code: RejectCode; message: string } | null {
  if (!Number.isFinite(giftUsd) || giftUsd <= 0) return { code: "INVALID_AMOUNT", message: "Amount must be more than $0" };
  if (giftUsd > l.maxGiftUsd) return { code: "OVER_MAX_GIFT", message: `Gifts are limited to ${usd(l.maxGiftUsd)} each` };
  if (l.dailyUsedUsd + giftUsd > l.dailyCapUsd) {
    const left = Math.max(0, l.dailyCapUsd - l.dailyUsedUsd);
    return { code: "OVER_DAILY_CAP", message: `Daily limit reached: ${usd(left)} of ${usd(l.dailyCapUsd)} left today` };
  }
  return null;
}

// ---- Issuer choice ----

export function pickIssuer(options: IssuerOption[], l: Pick<QuoteLimits, "maxPriceImpactPct">): { eligible: Priced[]; excluded: Exclusion[] } {
  const eligible: Priced[] = [];
  const excluded: Exclusion[] = [];
  for (const o of options) {
    const out = (reason: string) => excluded.push({ issuer: o.issuer, tokenSymbol: o.tokenSymbol, reason });
    if (!isTransferable(o.issuer)) out(`${label(o.issuer)} tokens aren't proven transferable`);
    else if (!o.quote) out(o.unavailable ?? "no quote");
    else if (!o.market.tradableNow) out(`market closed (${o.market.reason ?? o.market.status ?? "unknown"})`);
    else if (o.quote.priceImpactPct > l.maxPriceImpactPct) out(`price impact ${o.quote.priceImpactPct.toFixed(2)}% is above ${l.maxPriceImpactPct}%`);
    else eligible.push(o as Priced);
  }
  // Cheapest per real share = most shares for the money.
  eligible.sort((a, b) => a.quote.pricePerShare - b.quote.pricePerShare);
  return { eligible, excluded };
}

// ---- Market session (weekend logic) ----

const etFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hourCycle: "h23" });

/**
 * Fallback when no issuer reports a session: the weekend gap in US equity trading
 * (Fri 20:00 → Sun 20:00 New York time, when even overnight sessions stop). Ignores holidays.
 */
export function usWeekendClosed(ms: number): boolean {
  const parts = Object.fromEntries(etFmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const day = parts.weekday;
  const hour = Number(parts.hour);
  return day === "Sat" || (day === "Sun" && hour < 20) || (day === "Fri" && hour >= 20);
}

export function nextUsWeekendOpen(ms: number): number {
  const step = 5 * 60_000;
  let t = Math.ceil(ms / step) * step;
  for (let i = 0; i < (4 * 24 * 60) / 5 && usWeekendClosed(t); i++) t += step;
  return t;
}

const isClosedStatus = (o: IssuerOption) => o.market.status === "closed" || o.market.reasonCode === "MARKET_CLOSED";

/** Is the underlying stock market open? Issuers that report a session (Ondo) win; otherwise the calendar. */
export function underlyingSession(options: IssuerOption[], now: number): GiftQuote["market"] {
  const reporting = options.filter((o) => o.market.status !== null);
  if (reporting.length > 0) {
    const open = reporting.some((o) => !isClosedStatus(o));
    const nexts = reporting.map((o) => o.market.nextOpenTime).filter((t): t is number => typeof t === "number" && t > now);
    return { open, nextOpenTime: open ? null : nexts.length ? Math.min(...nexts) : null, source: "issuer" };
  }
  const closed = usWeekendClosed(now);
  return { open: !closed, nextOpenTime: closed ? nextUsWeekendOpen(now) : null, source: "calendar" };
}

// ---- Quote ----

function reasonFor(chosen: Priced, eligible: Priced[], excluded: Exclusion[]): string {
  const runnerUp = eligible[1];
  if (runnerUp) {
    const pct = (runnerUp.quote.pricePerShare / chosen.quote.pricePerShare - 1) * 100;
    if (pct < 0.01) return `${label(chosen.issuer)} and ${label(runnerUp.issuer)} cost the same per share; using ${label(chosen.issuer)}`;
    return `${label(chosen.issuer)} is ${pct.toFixed(2)}% cheaper per share than ${label(runnerUp.issuer)}`;
  }
  const other = excluded[0];
  return other ? `Only ${label(chosen.issuer)} is available (${label(other.issuer)}: ${other.reason})` : `${label(chosen.issuer)} is the only issuer for this stock`;
}

function warningsFor(chosen: Priced, options: IssuerOption[], market: GiftQuote["market"], l: QuoteLimits): QuoteWarning[] {
  const warnings: QuoteWarning[] = [];
  if (!market.open && chosen.quote.premiumPct > l.weekendWarnPct) {
    const when = market.nextOpenTime ? ` Market reopens ${new Date(market.nextOpenTime).toISOString()}.` : "";
    warnings.push({
      code: "WEEKEND_PREMIUM",
      message: `The stock market is closed and this price is ${chosen.quote.premiumPct.toFixed(2)}% above the last reference price.${when}`,
      nextOpenTime: market.nextOpenTime,
    });
  }
  const refs = options.map((o) => o.referencePrice).filter((p) => p > 0);
  if (refs.length > 1) {
    const spread = (Math.max(...refs) / Math.min(...refs) - 1) * 100;
    if (spread > REFERENCE_MISMATCH_PCT)
      warnings.push({
        code: "REFERENCE_MISMATCH",
        message: `Issuers' reference prices differ by ${spread.toFixed(2)}%; the per-share comparison relies on each issuer's token-to-share ratio`,
      });
  }
  return warnings;
}

export function buildQuote(t: TickerOptions, l: QuoteLimits, now: number): GiftQuoteResult {
  const cap = checkCaps(t.usd, l);
  if (cap) return { ok: false, ...cap };

  const { eligible, excluded } = pickIssuer(t.options, l);
  const chosen = eligible[0];
  if (!chosen) {
    const why = excluded.map((e) => `${label(e.issuer)}: ${e.reason}`).join("; ");
    return { ok: false, code: "NO_ISSUER", message: `No issuer can fill ${usd(t.usd)} of ${t.ticker} right now${why ? ` (${why})` : ""}`, excluded };
  }

  const market = underlyingSession(t.options, now);
  const q = chosen.quote;
  const giftUsd = t.usd;
  return {
    ok: true,
    quote: {
      ticker: t.ticker,
      name: t.name,
      issuer: chosen.issuer,
      issuerLabel: label(chosen.issuer),
      tokenSymbol: chosen.tokenSymbol,
      tokenAddress: chosen.tokenAddress,
      tokenAmount: q.tokensOut,
      tokenAmountRaw: q.tokensOutRaw,
      tokenDecimals: q.tokenDecimals,
      sharesOut: q.sharesOut,
      pricePerShare: q.pricePerShare,
      referencePrice: chosen.referencePrice,
      premiumPct: q.premiumPct,
      priceImpactPct: q.priceImpactPct,
      giftUsd,
      feeUsd: l.serviceFeeUsd,
      totalUsd: Math.round((giftUsd + l.serviceFeeUsd) * 100) / 100,
      reason: reasonFor(chosen, eligible, excluded),
      warnings: warningsFor(chosen, t.options, market, l),
      market,
      alternatives: eligible.slice(1).map((o) => ({ issuer: o.issuer, tokenSymbol: o.tokenSymbol, pricePerShare: o.quote.pricePerShare, premiumPct: o.quote.premiumPct })),
      excluded,
      quoteId: q.quoteId,
      quotedAt: q.fetchedAt,
      expiresAt: q.fetchedAt + l.quoteTtlSeconds * 1000,
    },
  };
}

// ---- Expiry ----

export function isQuoteExpired(q: Pick<GiftQuote, "expiresAt">, now: number): boolean {
  return now >= q.expiresAt;
}

export class QuoteExpiredError extends Error {
  constructor(public readonly expiresAt: number) {
    super(`Quote expired at ${new Date(expiresAt).toISOString()}; get a new quote`);
  }
}

/** Execution (Phase 6) calls this before acting on a quote. */
export function assertQuoteFresh(q: Pick<GiftQuote, "expiresAt">, now: number): void {
  if (isQuoteExpired(q, now)) throw new QuoteExpiredError(q.expiresAt);
}
