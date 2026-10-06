// Live data for one ticker and USD amount: every issuer's token, market status and swap quote,
// normalized to price per real share. Choosing between them is done by picker.ts (pure, tested).
// Prices come from live swap quotes: the RWA list's tokenPrice is just referencePrice × ratio.
import { formatUnits, parseUnits } from "viem";
import { config } from "../config.js";
import { USDT_BSC } from "../binance/constants.js";
import { BinanceError } from "../binance/errors.js";
import { isTradableNow, tokensForTicker, type Issuer, type RwaStatus, type RwaToken } from "../binance/rwa.js";
import { getQuote } from "../binance/trading.js";
import { buildQuote, checkCaps, type GiftQuoteResult, type QuoteLimits } from "./picker.js";
import { meetsIssuerMinimum, minimumText } from "./issuers.js";

export interface IssuerOption {
  issuer: Issuer;
  tokenSymbol: string;
  tokenAddress: string;
  tokenToShareRatio: number;
  market: {
    status: string | null;
    tradableNow: boolean;
    reasonCode: string | null;
    reason: string | null;
    nextOpenTime: number | null;
    nextCloseTime: number | null;
  };
  referencePrice: number;
  /** Set when a live quote was obtained. */
  quote?: {
    quoteId: string;
    vendor: string;
    executionMode: string;
    tokensOut: number;
    /** Raw toTokenAmount, kept for the Phase 6 cross-check against the baw quote. */
    tokensOutRaw: string;
    tokenDecimals: number;
    sharesOut: number;
    pricePerShare: number;
    /** (pricePerShare / referencePrice − 1) × 100. Positive means paying above this issuer's reference. */
    premiumPct: number;
    priceImpactPct: number;
    tradeFeeUsd: number;
    fetchedAt: number;
  };
  /** Why no quote could be fetched for this issuer and amount. */
  unavailable?: string;
}

export interface TickerOptions {
  ticker: string;
  name: string;
  usd: number;
  options: IssuerOption[];
  fetchedAt: number;
}

function marketOf(s: RwaStatus): IssuerOption["market"] {
  return {
    status: s.marketStatus,
    tradableNow: isTradableNow(s),
    reasonCode: s.reasonCode,
    reason: s.reasonMsg ?? s.reasonCode,
    nextOpenTime: s.nextOpenTime,
    nextCloseTime: s.nextCloseTime,
  };
}

async function quoteIssuer(t: RwaToken, usd: number, wallet: string): Promise<IssuerOption> {
  const ratio = Number(t.tokenToShareRatio);
  const referencePrice = Number(t.referencePrice);
  const option: IssuerOption = {
    issuer: t.platformId,
    tokenSymbol: t.tokenSymbol,
    tokenAddress: t.tokenContractAddress,
    tokenToShareRatio: ratio,
    market: marketOf(t.statusInfo),
    referencePrice,
  };

  if (!meetsIssuerMinimum(t.platformId, usd)) {
    option.unavailable = minimumText(t.platformId);
    return option;
  }

  try {
    const { quote, fetchedAt } = await getQuote({
      binanceChainId: t.binanceChainId,
      fromTokenAddress: USDT_BSC.address,
      toTokenAddress: t.tokenContractAddress,
      amount: parseUnits(usd.toFixed(USDT_BSC.decimals), USDT_BSC.decimals),
      userWalletAddress: wallet,
    });
    const toDecimals = Number(quote.toToken?.decimal ?? t.decimals);
    const fromDecimals = Number(quote.fromToken?.decimal ?? USDT_BSC.decimals);
    const tokensOut = Number(formatUnits(BigInt(quote.toTokenAmount), toDecimals));
    const usdIn = Number(formatUnits(BigInt(quote.fromTokenAmount), fromDecimals));
    const sharesOut = tokensOut * ratio;
    if (!(sharesOut > 0)) throw new Error("quote returned zero output");
    const pricePerShare = usdIn / sharesOut;

    option.quote = {
      quoteId: quote.quoteId,
      vendor: quote.vendorName,
      executionMode: quote.executionMode,
      tokensOut,
      tokensOutRaw: quote.toTokenAmount,
      tokenDecimals: toDecimals,
      sharesOut,
      pricePerShare,
      premiumPct: referencePrice > 0 ? (pricePerShare / referencePrice - 1) * 100 : NaN,
      priceImpactPct: Math.abs(Number(quote.priceImpactPercent) || 0),
      tradeFeeUsd: Number(quote.tradeFee) || 0,
      fetchedAt,
    };
  } catch (e) {
    option.unavailable = e instanceof BinanceError ? `quote failed (${e.code ?? e.kind}): ${e.message}` : `quote failed: ${(e as Error).message}`;
  }
  return option;
}

/** Fetches every issuer's live option for a ticker. Read-only: no transactions. */
export async function fetchTickerOptions(ticker: string, usd: number): Promise<TickerOptions> {
  if (!(usd > 0)) throw new Error("usd must be a positive number");
  const wallet = config.agenticWalletAddress;
  if (!wallet) throw new Error("Missing env var AGENTIC_WALLET_ADDRESS (RWA quotes need a userWalletAddress)");

  const tokens = await tokensForTicker(ticker);
  if (tokens.length === 0) throw new Error(`No tokenized stock for ${ticker.toUpperCase()} on BSC`);

  const options = await Promise.all(tokens.map((t) => quoteIssuer(t, usd, wallet)));
  return { ticker: tokens[0]!.underlyingTicker, name: tokens[0]!.underlyingName, usd, options, fetchedAt: Date.now() };
}

export function limitsFromConfig(dailyUsedUsd = 0): QuoteLimits {
  return {
    maxGiftUsd: config.maxGiftUsd,
    dailyCapUsd: config.dailyCapUsd,
    dailyUsedUsd,
    serviceFeeUsd: config.serviceFeeUsd,
    quoteTtlSeconds: config.quoteTtlSeconds,
    maxPriceImpactPct: config.maxPriceImpactPct,
    weekendWarnPct: config.weekendWarnPct,
  };
}

/**
 * Caps are checked before any network call, so an over-cap request never reaches Binance.
 * dailyUsedUsd comes from the gift ledger once it exists (Phase 5); until then callers pass 0.
 */
export async function quoteGift(ticker: string, usd: number, dailyUsedUsd = 0): Promise<GiftQuoteResult> {
  const limits = limitsFromConfig(dailyUsedUsd);
  const cap = checkCaps(usd, limits);
  if (cap) return { ok: false, ...cap };
  return buildQuote(await fetchTickerOptions(ticker, usd), limits, Date.now());
}
