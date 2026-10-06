// Trading API: aggregated swap quotes. Parameters per the REST API reference (trading-api).
import { request } from "./client.js";

export interface QuoteToken {
  tokenContractAddress: string;
  tokenSymbol: string;
  tokenUnitPrice: string;
  decimal: string;
  isHoneyPot: boolean;
  taxRate: string;
}

export interface SwapQuote {
  quoteId: string; // valid ~30 s
  vendorName: string;
  executionMode: "SWAP" | "RFQ" | string;
  binanceChainId: string;
  fromTokenAmount: string; // raw units
  toTokenAmount: string; // raw units
  tradeFee: string; // USD
  estimateGasFee: string;
  priceImpactPercent: string;
  router?: string;
  fromToken?: QuoteToken;
  toToken?: QuoteToken;
  approveTarget?: string;
  isBest: boolean;
}

export interface QuoteParams {
  binanceChainId: string;
  fromTokenAddress: string;
  toTokenAddress: string;
  /** Sell amount in the from-token's smallest unit. */
  amount: bigint;
  /** Required for RWA tokens (Ondo, bStocks). */
  userWalletAddress?: string;
}

/** Best quote across vendors, with the time it was fetched. */
export async function getQuote(p: QuoteParams): Promise<{ quote: SwapQuote; fetchedAt: number }> {
  const { data, fetchedAt } = await request<SwapQuote[]>("GET", "/api/v1/dex/aggregator/quote", {
    query: {
      binanceChainId: p.binanceChainId,
      amount: p.amount.toString(),
      fromTokenAddress: p.fromTokenAddress,
      toTokenAddress: p.toTokenAddress,
      userWalletAddress: p.userWalletAddress,
    },
  });
  const quote = data.find((q) => q.isBest) ?? data[0];
  if (!quote) throw new Error("Trading API returned no quotes");
  return { quote, fetchedAt };
}
