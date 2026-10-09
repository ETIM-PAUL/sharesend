// B402 facilitator client (Binance x402, v2). Per the B402 integration guide:
//   POST /api/v2/b402/{supported,verify,settle}, body wrapped as {"body": {...}}, success code "000000000".
import { createPublicClient, erc20Abi, http, type Address } from "viem";
import { bsc } from "viem/chains";
import { request } from "../binance/client.js";
import { RPC_URL } from "../chain/bsc.js";

export const X402_VERSION = 2;
export const BSC_NETWORK = "eip155:56";
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

export type TransferMethod = "eip3009" | "permit2-exact" | "permit2-upto";

export interface SupportedKind {
  x402Version: number;
  scheme: "exact" | "upto";
  network: string;
  extra: { name: string; version: string; assetTransferMethod: TransferMethod; signerAddress: string; spenderAddress?: string };
}

export interface PaymentRequirements {
  scheme: "exact" | "upto";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string; assetTransferMethod: TransferMethod; signerAddress: string; spenderAddress?: string };
}

export interface Eip3009Payload {
  signature: string;
  authorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string };
}

export interface Permit2Payload {
  signature: string;
  permit2Authorization: {
    permitted: { token: string; amount: string };
    from: string;
    spender: string;
    nonce: string;
    deadline: string;
    witness: { to: string; validAfter: string; facilitator?: string };
  };
}

export interface PaymentPayload {
  x402Version: number;
  resource?: { url: string; description?: string; mimeType?: string };
  accepted: PaymentRequirements;
  payload: Eip3009Payload | Permit2Payload;
  extensions?: unknown;
}

export interface VerifyResult {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  payer?: string;
}

export interface SettleResult {
  success: boolean;
  transaction?: string;
  payer?: string;
  network?: string;
  amount?: string;
  errorReason?: string;
}

// /supported identifies assets by EIP-712 name only, with no contract address (see docs/dx-log.md).
// Candidate addresses come from the Agentic Wallet skill's Common Token Addresses table; each is only
// used if its on-chain name() equals the name /supported returns.
const CANDIDATE_ASSETS: Record<string, string> = {
  "Tether USD": "0x55d398326f99059fF775485246999027B3197955",
  "USD Coin": "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  "United Stables": "0xcE24439F2D9C6a2289F741120FE202248B666666",
  "World Liberty Financial USD": "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d",
};

export interface PayAsset {
  name: string;
  symbol: string;
  address: string;
  decimals: number;
  kinds: SupportedKind[];
}

const SUPPORTED_TTL_MS = 5 * 60_000;
let cache: { at: number; assets: PayAsset[] } | undefined;

export async function supportedRaw(): Promise<{ kinds: SupportedKind[]; signers: Record<string, string[]> }> {
  return (await request<{ kinds: SupportedKind[]; signers: Record<string, string[]> }>("POST", "/api/v2/b402/supported", { body: { body: {} } })).data;
}

/** BSC payment assets B402 supports right now, with addresses and decimals checked on-chain. Cached 5 min. */
export async function payAssets(network = BSC_NETWORK): Promise<PayAsset[]> {
  if (cache && Date.now() - cache.at < SUPPORTED_TTL_MS) return cache.assets;
  const { kinds } = await supportedRaw();
  const byName = new Map<string, SupportedKind[]>();
  for (const k of kinds) if (k.network === network && k.x402Version === X402_VERSION) byName.set(k.extra.name, [...(byName.get(k.extra.name) ?? []), k]);

  const pc = createPublicClient({ chain: bsc, transport: http(RPC_URL, { timeout: 10_000, retryCount: 2 }) });
  const assets: PayAsset[] = [];
  for (const [name, ks] of byName) {
    const address = CANDIDATE_ASSETS[name];
    if (!address) continue;
    const [onchainName, symbol, decimals] = await Promise.all([
      pc.readContract({ address: address as Address, abi: erc20Abi, functionName: "name" }),
      pc.readContract({ address: address as Address, abi: erc20Abi, functionName: "symbol" }),
      pc.readContract({ address: address as Address, abi: erc20Abi, functionName: "decimals" }),
    ]);
    if (onchainName !== name) continue;
    assets.push({ name, symbol, address, decimals, kinds: ks });
  }
  cache = { at: Date.now(), assets };
  return assets;
}

/** For tests. */
export function _setPayAssetsCache(assets: PayAsset[] | undefined) {
  cache = assets ? { at: Date.now(), assets } : undefined;
}

export interface Facilitator {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResult>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResult>;
}

export const b402: Facilitator = {
  async verify(paymentPayload, paymentRequirements) {
    const { data } = await request<VerifyResult>("POST", "/api/v2/b402/verify", {
      body: { body: { x402Version: X402_VERSION, paymentPayload, paymentRequirements } },
      timeoutMs: 20_000,
    });
    return data;
  },
  async settle(paymentPayload, paymentRequirements) {
    // Settle is idempotent on the signed authorization, so a retry after a timeout can't charge twice.
    const { data } = await request<SettleResult>("POST", "/api/v2/b402/settle", {
      body: { body: { x402Version: X402_VERSION, paymentPayload, paymentRequirements } },
      timeoutMs: 60_000,
      retries: 2,
    });
    return data;
  },
};
