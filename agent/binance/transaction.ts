// Transaction API: simulate and broadcast. Bodies per the REST API reference (transaction-api).
import { request } from "./client.js";

export interface EvmTx {
  from: string;
  to: string;
  value: string; // wei, integer string
  data: string; // hex calldata
}

export interface SimulationResult {
  status: "SUCCESS" | string;
  failReason: string | null;
  balanceChanges: { contractAddress: string; tokenType: string; change: string; owner: string }[];
  allowanceChanges?: unknown[];
}

export async function simulateEvmTx(binanceChainId: string, evmTx: EvmTx): Promise<SimulationResult & { fetchedAt: number }> {
  const { data, fetchedAt } = await request<SimulationResult>("POST", "/api/v1/dex/pre-transaction/simulate", {
    body: { binanceChainId, evmTx },
    retries: 1,
  });
  return { ...data, fetchedAt };
}

export interface BroadcastResult {
  orderId: string;
  txHash: string;
}

/** Broadcasts an already-signed transaction. Never retried automatically: a retry could double-send. */
export async function broadcastSignedTx(binanceChainId: string, signedTransaction: string, address: string, enableMevProtection = true): Promise<BroadcastResult> {
  const { data } = await request<BroadcastResult>("POST", "/api/v1/dex/pre-transaction/broadcast-transaction", {
    body: { binanceChainId, signedTransaction, address, enableMevProtection },
    retries: 0,
  });
  return data;
}
