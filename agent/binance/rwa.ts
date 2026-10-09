// RWA Data API (Market API module). Paths from the Market API intro page; parameters confirmed by
// live calls because the per-endpoint reference pages don't render (see docs/dx-log.md).
import { request } from "./client.js";
import { BSC_CHAIN_ID } from "./constants.js";

export type Issuer = "ondo" | "bstock";

export interface RwaStatus {
  openState: boolean | null;
  // Documented values: premarket, regular, postmarket, overnight, closed, pause. Also seen: "offhours" (undocumented), null (bStocks).
  marketStatus: string | null;
  reasonCode: string | null; // TRADING, MARKET_CLOSED, MARKET_PAUSED, ASSET_PAUSED, ASSET_LIMITED, UNSUPPORTED, MARKET_MAINTENANCE
  reasonMsg: string | null;
  nextOpenTime: number | null;
  nextCloseTime: number | null;
}

export interface RwaToken {
  binanceChainId: string;
  tokenContractAddress: string;
  platformId: Issuer;
  assetType: number;
  tokenName: string;
  tokenSymbol: string;
  tokenLogoUrl: string;
  decimals: string;
  underlyingTicker: string;
  /** Null for a few tokens (e.g. HYGWon, SECUon, SYSBon); fall back to tokenName. */
  underlyingName: string | null;
  /** Shares represented by one token. sharesOut = tokensOut × tokenToShareRatio. */
  tokenToShareRatio: string;
  tags: string[] | null;
  statusInfo: RwaStatus;
  /** Derived from referencePrice × ratio, not a market price. Don't use it to compare issuers. */
  tokenPrice: string;
  /** Reference price per real share (USD). */
  referencePrice: string;
  volume24H: string;
  marketCap: string;
  peRatioTTM: string | null;
}

export interface RwaPlatform {
  platformId: string;
  tickerCount: number;
  chainDistribution: { binanceChainId: string; tokenCount: number }[];
  website: string;
  logoUrl: string;
}

export interface UnderlyingProfile {
  platformId: Issuer;
  underlyingTicker: string;
  underlyingFullName: string;
  tokenToShareRatio: string;
  protections?: { collateralReport?: { supported: boolean; description: string | null; url: string | null } };
  companyInfo?: { ceo?: string; website?: string; industry?: string; description?: string; conceptsEn?: string[] };
}

export interface UnderlyingMarket {
  platformId: Issuer;
  statusInfo: RwaStatus;
  marketData: Record<string, string | null>;
}

const TOKEN_LIST_TTL_MS = 60_000;
const tokenListCache = new Map<string, { at: number; tokens: RwaToken[] }>();

export async function listPlatforms(): Promise<RwaPlatform[]> {
  return (await request<RwaPlatform[]>("GET", "/api/v1/dex/market/rwa/platforms")).data;
}

/** Full RWA token list for a chain (~390 KB on BSC), cached for 60 s. */
export async function listRwaTokens(chainId = BSC_CHAIN_ID): Promise<{ tokens: RwaToken[]; fetchedAt: number }> {
  const hit = tokenListCache.get(chainId);
  if (hit && Date.now() - hit.at < TOKEN_LIST_TTL_MS) return { tokens: hit.tokens, fetchedAt: hit.at };
  const { data, fetchedAt } = await request<RwaToken[]>("GET", "/api/v1/dex/market/rwa/tokens", { query: { binanceChainId: chainId }, timeoutMs: 15_000 });
  tokenListCache.set(chainId, { at: fetchedAt, tokens: data });
  return { tokens: data, fetchedAt };
}

/** All issuer tokens for an underlying ticker (exact match, case-insensitive), e.g. "NVDA" → NVDAB + NVDAon. */
export async function tokensForTicker(ticker: string, chainId = BSC_CHAIN_ID): Promise<RwaToken[]> {
  const t = ticker.trim().toUpperCase();
  const { tokens } = await listRwaTokens(chainId);
  return tokens.filter((x) => (x.underlyingTicker ?? "").toUpperCase() === t);
}

export const displayName = (t: Pick<RwaToken, "underlyingName" | "tokenName" | "underlyingTicker">) => t.underlyingName ?? t.tokenName ?? t.underlyingTicker;

/** Ranks tokens against a query (ticker, token symbol, company name) into distinct tickers, best match first. Pure. */
export function rankTickers(tokens: RwaToken[], query: string): { ticker: string; name: string; issuers: Issuer[] }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const byTicker = new Map<string, { ticker: string; name: string; issuers: Issuer[]; score: number }>();
  for (const t of tokens) {
    const ticker = t.underlyingTicker ?? "";
    if (!ticker) continue;
    const name = displayName(t) ?? ticker;
    const tl = ticker.toLowerCase();
    const score = tl === q ? 3 : (t.tokenSymbol ?? "").toLowerCase() === q ? 2 : name.toLowerCase().includes(q) || tl.startsWith(q) ? 1 : 0;
    if (!score) continue;
    const row = byTicker.get(ticker) ?? { ticker, name, issuers: [], score };
    if (!row.issuers.includes(t.platformId)) row.issuers.push(t.platformId);
    row.score = Math.max(row.score, score);
    byTicker.set(ticker, row);
  }
  return [...byTicker.values()].sort((a, b) => b.score - a.score || a.ticker.localeCompare(b.ticker)).map(({ score: _s, ...r }) => r);
}

/** Local search over ticker, token symbol and company name. Returns distinct underlying tickers, best match first. */
export async function searchTickers(query: string, chainId = BSC_CHAIN_ID): Promise<{ ticker: string; name: string; issuers: Issuer[] }[]> {
  if (!query.trim()) return [];
  const { tokens } = await listRwaTokens(chainId);
  return rankTickers(tokens, query);
}

export async function getUnderlyingProfile(token: Pick<RwaToken, "binanceChainId" | "tokenContractAddress">): Promise<UnderlyingProfile> {
  return (
    await request<UnderlyingProfile>("GET", "/api/v1/dex/market/rwa/underlying-profile", {
      query: { binanceChainId: token.binanceChainId, tokenContractAddress: token.tokenContractAddress },
    })
  ).data;
}

export async function getUnderlyingMarket(token: Pick<RwaToken, "binanceChainId" | "tokenContractAddress">): Promise<UnderlyingMarket> {
  return (
    await request<UnderlyingMarket>("GET", "/api/v1/dex/market/rwa/underlying-market", {
      query: { binanceChainId: token.binanceChainId, tokenContractAddress: token.tokenContractAddress },
    })
  ).data;
}

/** True only when the API says the asset can trade right now. */
export function isTradableNow(s: RwaStatus): boolean {
  return s.openState === true && (s.reasonCode === null || s.reasonCode === "TRADING");
}
