// Issuer comparison for one ticker and USD amount, normalized to price per real share.
// Prices come from live swap quotes: the RWA list's tokenPrice is just referencePrice × ratio.
import { formatUnits, parseUnits } from "viem";
import { config } from "../config.js";
import { USDT_BSC } from "../binance/constants.js";
import { BinanceError } from "../binance/errors.js";
import { isTradableNow, tokensForTicker, type Issuer, type RwaStatus, type RwaToken } from "../binance/rwa.js";
import { getQuote } from "../binance/trading.js";

// Smallest order each issuer accepts, found by live quotes (docs/issuers.md).
// Ondo: Trading API rejects exactly $5 with 40375 "Minimum order amount is 5 USD"; $5.01 works.
export const ISSUER_MIN_USD: Record<Issuer, { usd: number; exclusive: boolean }> = {
  ondo: { usd: 5, exclusive: true },
  bstock: { usd: 1, exclusive: false },
};

export function meetsIssuerMinimum(issuer: Issuer, usd: number): boolean {
  const m = ISSUER_MIN_USD[issuer];
  if (!m) return true;
  return m.exclusive ? usd > m.usd : usd >= m.usd;
}

export interface IssuerOption {
  issuer: Issuer;
  tokenSymbol: string;
  tokenAddress: string;
  tokenToShareRatio: number;
  market: { status: string | null; tradableNow: boolean; reason: string | null; nextOpenTime: number | null; nextCloseTime: number | null };
  referencePrice: number;
  /** Set when a live quote was obtained. */
  quote?: {
    quoteId: string;
    vendor: string;
    executionMode: string;
    tokensOut: number;
    sharesOut: number;
    pricePerShare: number;
    /** (pricePerShare / referencePrice − 1) × 100. Positive means you pay above the reference price. */
    premiumPct: number;
    priceImpactPct: number;
    tradeFeeUsd: number;
    fetchedAt: number;
    expiresAt: number;
  };
  /** Why this issuer can't be offered for this amount right now. */
  unavailable?: string;
  warnings: string[];
}

export interface TickerQuote {
  ticker: string;
  name: string;
  usd: number;
  options: IssuerOption[];
  /** Cheapest available issuer per share, if any. */
  best: Issuer | null;
  fetchedAt: number;
}

function marketOf(s: RwaStatus): IssuerOption["market"] {
  return {
    status: s.marketStatus,
    tradableNow: isTradableNow(s),
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
    warnings: [],
  };

  if (!meetsIssuerMinimum(t.platformId, usd)) {
    const m = ISSUER_MIN_USD[t.platformId];
    option.unavailable = `${t.platformId} minimum is ${m.exclusive ? "more than" : "at least"} $${m.usd}`;
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
    const priceImpactPct = Math.abs(Number(quote.priceImpactPercent) || 0);

    option.quote = {
      quoteId: quote.quoteId,
      vendor: quote.vendorName,
      executionMode: quote.executionMode,
      tokensOut,
      sharesOut,
      pricePerShare,
      premiumPct: referencePrice > 0 ? (pricePerShare / referencePrice - 1) * 100 : NaN,
      priceImpactPct,
      tradeFeeUsd: Number(quote.tradeFee) || 0,
      fetchedAt,
      expiresAt: fetchedAt + config.quoteTtlSeconds * 1000,
    };
    if (priceImpactPct > config.maxPriceImpactPct) option.warnings.push(`price impact ${priceImpactPct.toFixed(2)}% is above the ${config.maxPriceImpactPct}% cap`);
    if (!option.market.tradableNow && Math.abs(option.quote.premiumPct) > config.weekendWarnPct)
      option.warnings.push(`market closed and price is ${option.quote.premiumPct.toFixed(2)}% from reference`);
  } catch (e) {
    option.unavailable = e instanceof BinanceError ? `quote failed (${e.code ?? e.kind}): ${e.message}` : `quote failed: ${(e as Error).message}`;
  }
  return option;
}

export async function quoteTicker(ticker: string, usd: number): Promise<TickerQuote> {
  if (!(usd > 0)) throw new Error("usd must be a positive number");
  const wallet = config.agenticWalletAddress;
  if (!wallet) throw new Error("Missing env var AGENTIC_WALLET_ADDRESS (RWA quotes need a userWalletAddress)");

  const tokens = await tokensForTicker(ticker);
  if (tokens.length === 0) throw new Error(`No tokenized stock for ${ticker.toUpperCase()} on BSC`);

  const options = await Promise.all(tokens.map((t) => quoteIssuer(t, usd, wallet)));
  const priced = options.filter((o) => o.quote && o.market.tradableNow && o.warnings.length === 0);
  priced.sort((a, b) => a.quote!.pricePerShare - b.quote!.pricePerShare);

  return {
    ticker: tokens[0]!.underlyingTicker,
    name: tokens[0]!.underlyingName,
    usd,
    options,
    best: priced[0]?.issuer ?? null,
    fetchedAt: Date.now(),
  };
}
