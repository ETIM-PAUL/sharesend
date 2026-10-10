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
  const { data } = await request<unknown>("POST", "/api/v1/dex/balance/token-balances-by-address", {
    // "1" includes risk-flagged tokens, so a newly listed stock token is never silently dropped.
    body: { address, tokenContractAddresses: tokens, excludeRiskToken: "1" },
  });
  return flattenBalances(data);
}

/**
 * The reference shows `[{ tokenAssets: [...] }]`; the live API (Oct 2026) returns the assets as a flat array.
 * Accept both. Tokens with a zero balance are omitted by the API.
 */
export function flattenBalances(data: unknown): TokenAsset[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((d) => (d && typeof d === "object" && Array.isArray((d as { tokenAssets?: unknown }).tokenAssets) ? (d as { tokenAssets: TokenAsset[] }).tokenAssets : [d as TokenAsset]));
}

/** Raw balance per token address (lower-cased), 0n when the API omits it. */
export async function rawBalances(address: string, tokenAddresses: string[], binanceChainId = "56"): Promise<Map<string, bigint>> {
  const out = new Map(tokenAddresses.map((t) => [t.toLowerCase(), 0n]));
  for (let i = 0; i < tokenAddresses.length; i += 20) {
    const assets = await getTokenBalances(
      address,
      tokenAddresses.slice(i, i + 20).map((t) => ({ binanceChainId, tokenContractAddress: t })),
    );
    for (const a of assets) out.set(a.tokenContractAddress.toLowerCase(), BigInt(a.rawBalance ?? "0"));
  }
  return out;
}
