// What the execution pipeline needs from the outside world. Live implementations wrap `baw`, the vault
// key and BSC; dry-run implementations quote and simulate only; tests use fakes.
import type { TxState } from "../chain/bsc.js";

export type ExecKind = "forward" | "swap" | "vault_send" | "sweep" | "claim" | "return" | "refund";

/** The Agentic Wallet (trading engine). It can only send to its address book, i.e. the vault. */
export interface AgenticWalletPort {
  address: string;
  isConnected(): Promise<boolean>;
  /** Expected output in raw token units for spending `usdQty` USDT. */
  quoteOut(toToken: string, toDecimals: number, usdQty: string): Promise<bigint>;
  submitSwap(toToken: string, usdQty: string, slippagePct: number): Promise<string>;
  getOrder(orderId: string): Promise<{ status: "PENDING" | "FINISHED" | "FAILED"; txHash: string | null } | null>;
  /** A market order into `toToken` submitted at or after `sinceMs`: adopts a swap whose orderId was lost in a crash. */
  findOrderSince(toToken: string, sinceMs: number): Promise<string | null>;
  sendToVault(token: string, amountHuman: string): Promise<string>;
  /** A send of `token` to the vault at or after `sinceMs`: adopts a send whose txHash was lost in a crash. */
  findSendSince(token: string, sinceMs: number): Promise<string | null>;
}

export interface ChainPort {
  transferIn(txHash: string, token: string, to: string): Promise<{ state: TxState; amount: bigint }>;
}

export interface MarketPort {
  /** Trading API best-quote output in raw token units for `usd` USDT. */
  apiQuoteOut(toToken: string, usd: number): Promise<bigint>;
}

export interface VaultTransfer {
  giftId: string;
  kind: Extract<ExecKind, "forward" | "claim" | "return" | "refund">;
  token: string;
  to: string;
  amount: bigint;
}

export interface VaultPort {
  address: string;
  /**
   * Simulate → sign → record → broadcast → wait for confirmation. Idempotent per (giftId, kind): a retry
   * returns the earlier tx (rebroadcasting it if needed), never a second one. `onSigned` runs after the tx
   * is recorded and before broadcast.
   */
  transfer(t: VaultTransfer, onSigned?: (txHash: string) => Promise<void>): Promise<{ txHash: string; amount: bigint }>;
}

// ---- Errors the pipeline reacts to ----

/** Simulation failed, nothing was signed or broadcast: safe to undo the step. */
export class SimulationFailedError extends Error {
  constructor(public readonly reason: string) {
    super(`Simulation failed: ${reason}`);
  }
}

/** A tx was broadcast and isn't confirmed yet. Leave the gift where it is; a later run picks it up. */
export class StillPendingError extends Error {}

/** The vault needs BNB for gas. Nothing was signed. */
export class NeedsGasError extends Error {}
