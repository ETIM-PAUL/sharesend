import { describe, expect, it } from "vitest";
import {
  assertQuoteFresh,
  buildQuote,
  checkCaps,
  isQuoteExpired,
  nextUsWeekendOpen,
  pickIssuer,
  QuoteExpiredError,
  underlyingSession,
  usWeekendClosed,
  type QuoteLimits,
} from "./picker.js";
import { ISSUERS, isTransferable, meetsIssuerMinimum } from "./issuers.js";
import type { IssuerOption, TickerOptions } from "./quote.js";

const NOW = Date.parse("2026-10-06T14:00:00Z"); // Tuesday, US regular session

const limits: QuoteLimits = {
  maxGiftUsd: 20,
  dailyCapUsd: 50,
  dailyUsedUsd: 0,
  serviceFeeUsd: 0.1,
  quoteTtlSeconds: 60,
  maxPriceImpactPct: 1.5,
  weekendWarnPct: 1.0,
};

type Over = Partial<Omit<IssuerOption, "market" | "quote">> & {
  market?: Partial<IssuerOption["market"]>;
  quote?: Partial<NonNullable<IssuerOption["quote"]>> | null;
};

function opt(issuer: "ondo" | "bstock", pricePerShare: number, over: Over = {}): IssuerOption {
  const referencePrice = over.referencePrice ?? 240;
  const { market, quote, ...rest } = over;
  return {
    issuer,
    tokenSymbol: issuer === "ondo" ? "NVDAon" : "NVDAB",
    tokenAddress: issuer === "ondo" ? "0xa9ee" : "0x02fc",
    tokenToShareRatio: 1,
    referencePrice,
    market: {
      status: issuer === "ondo" ? "regular" : null,
      tradableNow: true,
      reasonCode: "TRADING",
      reason: "TRADING",
      nextOpenTime: null,
      nextCloseTime: null,
      ...market,
    },
    quote:
      quote === null
        ? undefined
        : {
            quoteId: `q-${issuer}`,
            vendor: "LiquidMesh",
            executionMode: "SWAP",
            tokensOut: 10 / pricePerShare,
            tokensOutRaw: "1",
            tokenDecimals: 18,
            sharesOut: 10 / pricePerShare,
            pricePerShare,
            premiumPct: (pricePerShare / referencePrice - 1) * 100,
            priceImpactPct: 0.01,
            tradeFeeUsd: 0.02,
            fetchedAt: NOW,
            ...quote,
          },
    ...rest,
  };
}

const ticker = (options: IssuerOption[], usd = 10): TickerOptions => ({ ticker: "NVDA", name: "Nvidia Corp", usd, options, fetchedAt: NOW });

describe("issuer registry", () => {
  it("both shortlisted issuers are transferable (simulated)", () => {
    expect(isTransferable("ondo")).toBe(true);
    expect(isTransferable("bstock")).toBe(true);
    expect(isTransferable("xstocks")).toBe(false);
  });
  it("Ondo needs strictly more than $5; bStocks at least $1", () => {
    expect(meetsIssuerMinimum("ondo", 5)).toBe(false);
    expect(meetsIssuerMinimum("ondo", 5.01)).toBe(true);
    expect(meetsIssuerMinimum("bstock", 1)).toBe(true);
    expect(meetsIssuerMinimum("bstock", 0.99)).toBe(false);
    expect(meetsIssuerMinimum("unknown", 100)).toBe(false);
  });
});

describe("pickIssuer", () => {
  it("chooses the cheapest per real share", () => {
    const { eligible } = pickIssuer([opt("bstock", 240.1), opt("ondo", 239.9)], limits);
    expect(eligible.map((o) => o.issuer)).toEqual(["ondo", "bstock"]);
  });

  it("compares per share, not by premium against each issuer's own reference", () => {
    // SPY-like: Ondo has the lower premium but costs more per share.
    const ondo = opt("ondo", 778.73, { referencePrice: 782.53 });
    const bstock = opt("bstock", 775.2, { referencePrice: 775.18 });
    expect(ondo.quote!.premiumPct).toBeLessThan(bstock.quote!.premiumPct);
    expect(pickIssuer([ondo, bstock], limits).eligible[0]!.issuer).toBe("bstock");
  });

  it("excludes issuers that aren't transferable", () => {
    const blocked = { ...opt("ondo", 200), issuer: "xstocks" as never };
    const { eligible, excluded } = pickIssuer([blocked, opt("bstock", 240)], limits);
    expect(eligible.map((o) => o.issuer)).toEqual(["bstock"]);
    expect(excluded[0]!.reason).toMatch(/transferable/);
  });

  it("excludes issuers that aren't tradable now", () => {
    const paused = opt("ondo", 200, { market: { tradableNow: false, status: "paused", reason: "Paused for session transition" } });
    const { eligible, excluded } = pickIssuer([paused, opt("bstock", 240)], limits);
    expect(eligible.map((o) => o.issuer)).toEqual(["bstock"]);
    expect(excluded[0]!.reason).toMatch(/session transition/);
  });

  it("excludes quotes over the price-impact cap", () => {
    const thin = opt("ondo", 200, { quote: { priceImpactPct: 2 } });
    const { eligible, excluded } = pickIssuer([thin, opt("bstock", 240)], limits);
    expect(eligible.map((o) => o.issuer)).toEqual(["bstock"]);
    expect(excluded[0]!.reason).toMatch(/price impact/);
  });

  it("allows impact exactly at the cap", () => {
    expect(pickIssuer([opt("ondo", 240, { quote: { priceImpactPct: 1.5 } })], limits).eligible).toHaveLength(1);
  });

  it("excludes issuers without a quote and keeps the reason", () => {
    const below = opt("ondo", 0, { quote: null, unavailable: "Ondo minimum is more than $5" });
    const { excluded } = pickIssuer([below, opt("bstock", 240)], limits);
    expect(excluded).toEqual([{ issuer: "ondo", tokenSymbol: "NVDAon", reason: "Ondo minimum is more than $5" }]);
  });
});

describe("caps", () => {
  it("rejects zero, negative and non-numbers", () => {
    expect(checkCaps(0, limits)?.code).toBe("INVALID_AMOUNT");
    expect(checkCaps(-1, limits)?.code).toBe("INVALID_AMOUNT");
    expect(checkCaps(NaN, limits)?.code).toBe("INVALID_AMOUNT");
  });
  it("rejects gifts over MAX_GIFT_USD, allows exactly the max", () => {
    expect(checkCaps(20.01, limits)?.code).toBe("OVER_MAX_GIFT");
    expect(checkCaps(20, limits)).toBeNull();
  });
  it("rejects gifts that would exceed DAILY_CAP_USD", () => {
    expect(checkCaps(10, { ...limits, dailyUsedUsd: 45 })).toMatchObject({ code: "OVER_DAILY_CAP", message: expect.stringContaining("$5.00") });
    expect(checkCaps(5, { ...limits, dailyUsedUsd: 45 })).toBeNull();
  });
  it("buildQuote enforces caps before picking", () => {
    const r = buildQuote(ticker([opt("bstock", 240)], 25), limits, NOW);
    expect(r).toMatchObject({ ok: false, code: "OVER_MAX_GIFT" });
  });
});

describe("buildQuote", () => {
  it("returns amount, cost, fee, total, reason and expiry", () => {
    const r = buildQuote(ticker([opt("bstock", 240.1), opt("ondo", 239.9)]), limits, NOW);
    if (!r.ok) throw new Error(r.message);
    const q = r.quote;
    expect(q.issuer).toBe("ondo");
    expect(q.giftUsd).toBe(10);
    expect(q.feeUsd).toBe(0.1);
    expect(q.totalUsd).toBe(10.1);
    expect(q.tokenAmount).toBeCloseTo(10 / 239.9);
    expect(q.reason).toBe("Ondo is 0.08% cheaper per share than bStocks");
    expect(q.alternatives.map((a) => a.issuer)).toEqual(["bstock"]);
    expect(q.expiresAt).toBe(NOW + 60_000);
    expect(q.warnings).toEqual([]);
  });

  it("says when two issuers cost the same", () => {
    const r = buildQuote(ticker([opt("bstock", 240), opt("ondo", 240.01)]), limits, NOW);
    expect(r.ok && r.quote.reason).toBe("bStocks and Ondo cost the same per share; using bStocks");
  });

  it("explains a single-issuer pick by the excluded one", () => {
    const below = opt("ondo", 0, { quote: null, unavailable: "Ondo minimum is more than $5" });
    const r = buildQuote(ticker([below, opt("bstock", 240)], 3), limits, NOW);
    expect(r.ok && r.quote.reason).toBe("Only bStocks is available (Ondo: Ondo minimum is more than $5)");
  });

  it("explains a ticker with only one issuer", () => {
    const r = buildQuote(ticker([opt("ondo", 330)]), limits, NOW);
    expect(r.ok && r.quote.reason).toBe("Ondo is the only issuer for this stock");
  });

  it("returns NO_ISSUER with reasons when nothing can fill", () => {
    const r = buildQuote(ticker([opt("ondo", 0, { quote: null, unavailable: "Ondo minimum is more than $5" })], 3), limits, NOW);
    expect(r).toMatchObject({ ok: false, code: "NO_ISSUER" });
    expect(!r.ok && r.message).toContain("Ondo minimum");
  });

  it("warns when issuers' reference prices disagree", () => {
    const r = buildQuote(ticker([opt("ondo", 778.73, { referencePrice: 782.53 }), opt("bstock", 775.2, { referencePrice: 775.18 })]), limits, NOW);
    expect(r.ok && r.quote.warnings.map((w) => w.code)).toEqual(["REFERENCE_MISMATCH"]);
  });
});

describe("weekend logic", () => {
  const SAT = Date.parse("2026-10-10T16:00:00Z"); // Sat 12:00 New York
  const MON_OPEN = Date.parse("2026-10-12T00:00:00Z"); // Sun 20:00 New York
  const closedOndo = (price: number) =>
    opt("ondo", price, { market: { status: "closed", tradableNow: false, reasonCode: "MARKET_CLOSED", reason: "Market closed", nextOpenTime: MON_OPEN } });
  const weekendBstock = (price: number) => opt("bstock", price, { quote: { fetchedAt: SAT } });

  it("warns with the next open time when closed and the premium is above WEEKEND_WARN_PCT", () => {
    const r = buildQuote(ticker([closedOndo(240), weekendBstock(243)]), limits, SAT); // +1.25%
    if (!r.ok) throw new Error(r.message);
    expect(r.quote.issuer).toBe("bstock");
    expect(r.quote.market).toEqual({ open: false, nextOpenTime: MON_OPEN, source: "issuer" });
    expect(r.quote.warnings).toEqual([expect.objectContaining({ code: "WEEKEND_PREMIUM", nextOpenTime: MON_OPEN })]);
    expect(r.quote.warnings[0]!.message).toContain("2026-10-12T00:00:00.000Z");
  });

  it("no warning when closed but the premium is within WEEKEND_WARN_PCT", () => {
    const r = buildQuote(ticker([closedOndo(240), weekendBstock(242)]), limits, SAT); // +0.83%
    expect(r.ok && r.quote.warnings).toEqual([]);
  });

  it("no warning for a discount while closed", () => {
    const r = buildQuote(ticker([closedOndo(240), weekendBstock(230)]), limits, SAT);
    expect(r.ok && r.quote.warnings).toEqual([]);
  });

  it("no weekend warning when the market is open, whatever the premium", () => {
    const r = buildQuote(ticker([opt("ondo", 250)]), limits, NOW);
    expect(r.ok && r.quote.warnings).toEqual([]);
  });

  it("a session-transition pause doesn't count as closed", () => {
    const paused = opt("ondo", 240, { market: { status: "paused", tradableNow: false, reasonCode: "MARKET_PAUSED" } });
    expect(underlyingSession([paused, opt("bstock", 240)], NOW).open).toBe(true);
  });

  it("falls back to the US calendar when no issuer reports a session (bStocks-only)", () => {
    expect(underlyingSession([weekendBstock(245)], SAT)).toEqual({ open: false, nextOpenTime: MON_OPEN, source: "calendar" });
    const r = buildQuote(ticker([weekendBstock(245)]), limits, SAT);
    expect(r.ok && r.quote.warnings.map((w) => w.code)).toEqual(["WEEKEND_PREMIUM"]);
    expect(underlyingSession([opt("bstock", 240)], NOW)).toEqual({ open: true, nextOpenTime: null, source: "calendar" });
  });

  it("calendar: closed Fri 20:00 → Sun 20:00 New York time", () => {
    expect(usWeekendClosed(Date.parse("2026-10-09T23:59:00Z"))).toBe(false); // Fri 19:59 EDT
    expect(usWeekendClosed(Date.parse("2026-10-10T00:00:00Z"))).toBe(true); // Fri 20:00 EDT
    expect(usWeekendClosed(Date.parse("2026-10-11T23:59:00Z"))).toBe(true); // Sun 19:59 EDT
    expect(usWeekendClosed(MON_OPEN)).toBe(false); // Sun 20:00 EDT
    expect(nextUsWeekendOpen(SAT)).toBe(MON_OPEN);
    // After DST ends (EST, UTC−5): Sun 20:00 EST = Mon 01:00 UTC.
    expect(nextUsWeekendOpen(Date.parse("2026-11-07T12:00:00Z"))).toBe(Date.parse("2026-11-09T01:00:00Z"));
  });
});

describe("quote expiry", () => {
  const q = { expiresAt: NOW + 60_000 };
  it("is fresh before expiresAt and expired at or after it", () => {
    expect(isQuoteExpired(q, NOW + 59_999)).toBe(false);
    expect(isQuoteExpired(q, NOW + 60_000)).toBe(true);
  });
  it("assertQuoteFresh throws QuoteExpiredError once expired", () => {
    expect(() => assertQuoteFresh(q, NOW)).not.toThrow();
    expect(() => assertQuoteFresh(q, NOW + 61_000)).toThrow(QuoteExpiredError);
  });
  it("expiry follows QUOTE_TTL_SECONDS from the quote's fetch time", () => {
    const r = buildQuote(ticker([opt("ondo", 240, { quote: { fetchedAt: NOW - 5_000 } })]), { ...limits, quoteTtlSeconds: 30 }, NOW);
    expect(r.ok && r.quote.expiresAt).toBe(NOW - 5_000 + 30_000);
  });
});

it("ISSUERS covers every issuer the RWA API lists on BSC", () => {
  expect(Object.keys(ISSUERS).sort()).toEqual(["bstock", "ondo"]);
});
