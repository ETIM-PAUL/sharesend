// What a recipient sees about their stock: company profile, issuer, value now and since gifted.
// Value uses the issuer's reference price per real share (RWA Data API): Market API candles for Ondo
// tokens contain bad prints (e.g. $425 closes while the stock trades at $230), so candles only feed
// the chart, after outlier filtering.
import { formatUnits } from "viem";
import { displayName, getUnderlyingProfile, listPlatforms, listRwaTokens, type RwaToken } from "../binance/rwa.js";
import { getCandles, type Candle } from "../binance/market.js";
import { issuerInfo } from "../pricing/issuers.js";

export interface StockInfo {
  ticker: string;
  companyName: string;
  tokenSymbol: string;
  tokenAddress: string;
  decimals: number;
  issuer: string;
  issuerLabel: string;
  issuerWebsite: string | null;
  /** Shares per token. */
  ratio: number;
  /** Issuer's reference price per real share, USD. */
  referencePrice: number;
  marketOpen: boolean;
  profile: { description: string | null; website: string | null; industry: string | null; ceo: string | null };
  /** The API's collateral/attestation report link; null when the issuer doesn't publish one through the API. */
  attestationUrl: string | null;
}

const INFO_TTL_MS = 5 * 60_000;
const infoCache = new Map<string, { at: number; info: StockInfo }>();

async function tokenByAddress(address: string): Promise<RwaToken | undefined> {
  const { tokens } = await listRwaTokens();
  return tokens.find((t) => t.tokenContractAddress.toLowerCase() === address.toLowerCase());
}

export async function stockInfo(tokenAddress: string): Promise<StockInfo | null> {
  const key = tokenAddress.toLowerCase();
  const hit = infoCache.get(key);
  if (hit && Date.now() - hit.at < INFO_TTL_MS) return hit.info;
  const t = await tokenByAddress(tokenAddress);
  if (!t) return null;
  const [profile, platforms] = await Promise.all([getUnderlyingProfile(t).catch(() => null), listPlatforms().catch(() => [])]);
  const info: StockInfo = {
    ticker: t.underlyingTicker,
    // The profile's full name carries the issuer ("NVIDIA (bStocks)"); the token list's name doesn't.
    companyName: t.underlyingName ?? profile?.underlyingFullName?.replace(/\s*\([^)]*\)\s*$/, "") ?? displayName(t),
    tokenSymbol: t.tokenSymbol,
    tokenAddress: t.tokenContractAddress,
    decimals: Number(t.decimals),
    issuer: t.platformId,
    issuerLabel: issuerInfo(t.platformId)?.label ?? t.platformId,
    issuerWebsite: platforms.find((p) => p.platformId === t.platformId)?.website ?? null,
    ratio: Number(t.tokenToShareRatio),
    referencePrice: Number(t.referencePrice),
    marketOpen: t.statusInfo?.openState === true,
    profile: {
      description: profile?.companyInfo?.description ?? null,
      website: profile?.companyInfo?.website ?? null,
      industry: profile?.companyInfo?.industry ?? null,
      ceo: profile?.companyInfo?.ceo ?? null,
    },
    attestationUrl: profile?.protections?.collateralReport?.url ?? null,
  };
  infoCache.set(key, { at: Date.now(), info });
  return info;
}

export function sharesOf(rawTokens: bigint, decimals: number, ratio: number): number {
  return Number(formatUnits(rawTokens, decimals)) * ratio;
}

/**
 * Per-share price points from candles, dropping bad prints: any close more than `maxDevPct` away from the
 * reference price (or, without one, the series median). Pure.
 */
export function cleanSeries(candles: Candle[], ratio: number, referencePrice?: number, maxDevPct = 8): { t: number; price: number }[] {
  const pts = candles.filter((c) => c.close > 0 && c.time > 0).map((c) => ({ t: c.time, price: c.close / ratio }));
  if (!pts.length) return [];
  // The reference price is the trustworthy anchor; the median only stands in when there isn't one
  // (with many bad prints the median can itself be a bad print).
  const sorted = [...pts].map((p) => p.price).sort((a, b) => a - b);
  const anchor = referencePrice && referencePrice > 0 ? referencePrice : sorted[Math.floor(sorted.length / 2)]!;
  return pts.filter((p) => Math.abs(p.price / anchor - 1) * 100 <= maxDevPct).sort((a, b) => a.t - b.t);
}

/** Value of `shares` over time since `sinceMs` (hourly, or daily for older gifts). */
export async function valueSeries(info: StockInfo, shares: number, sinceMs: number): Promise<{ t: number; usd: number }[]> {
  const ageH = Math.max(1, (Date.now() - sinceMs) / 3_600_000);
  const bar = ageH > 72 ? "1d" : "1h";
  const limit = Math.min(200, Math.ceil(bar === "1d" ? ageH / 24 : ageH) + 2);
  const candles = await getCandles("56", info.tokenAddress, bar, Math.max(limit, 24)).catch(() => []);
  return cleanSeries(candles, info.ratio, info.referencePrice).map((p) => ({ t: p.t, usd: Math.round(p.price * shares * 100) / 100 }));
}
