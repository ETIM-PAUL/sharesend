// Wallet API: balances. Body per the REST API reference (wallet-api).
import { request } from "./client.js";

export interface TokenAsset {
  binanceChainId: string;
  tokenContractAddress: string;
  address: string;
  symbol: string;
  balance: string; // human units
  rawBalance: string;
  tokenPrice: string;
  isRiskToken: boolean;
}

/** Balances for up to 20 specific tokens. Use "" as the token address for the native asset (BNB). */
export async function getTokenBalances(address: string, tokens: { binanceChainId: string; tokenContractAddress: string }[]): Promise<TokenAsset[]> {
  if (tokens.length === 0) return [];
  if (tokens.length > 20) throw new Error("getTokenBalances: max 20 tokens per request");
  const { data } = await request<{ tokenAssets: TokenAsset[] }[]>("POST", "/api/v1/dex/balance/token-balances-by-address", {
    // "1" includes risk-flagged tokens, so a newly listed stock token is never silently dropped.
    body: { address, tokenContractAddresses: tokens, excludeRiskToken: "1" },
  });
  return data.flatMap((d) => d.tokenAssets ?? []);
}
