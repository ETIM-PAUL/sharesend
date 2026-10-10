// Proof of holdings: the vault's on-chain balance per token vs the total of gifts it owes.
import { createPublicClient, erc20Abi, http, type Address } from "viem";
import { bsc } from "viem/chains";
import type { Queryable } from "../db/pool.js";
import { VAULT_LIABILITY_STATUSES } from "./states.js";

export interface Liability {
  tokenAddress: string;
  ticker: string;
  gifts: number;
  amountRaw: bigint;
}

export interface ReconcileRow extends Liability {
  holdingRaw: bigint;
  /** holding − liability. Negative means the vault can't cover every unclaimed gift. */
  surplusRaw: bigint;
  ok: boolean;
}

/**
 * Tokens the vault owes: gifts that are READY, being claimed or being returned (until the transfer confirms),
 * plus gifts whose stock has reached the vault but aren't READY yet (BUYING at step in_vault).
 */
export async function liabilities(db: Queryable): Promise<Liability[]> {
  const { rows } = await db.query<{ token_address: string; ticker: string; gifts: string; amount: string }>(
    `SELECT lower(token_address) AS token_address, min(ticker) AS ticker, count(*) AS gifts, sum(token_amount) AS amount
     FROM gifts
     WHERE token_amount IS NOT NULL AND NOT dry_run
       AND (status = ANY($1) OR (status = 'BUYING' AND step = 'in_vault'))
       -- Stock sent to the Agentic Wallet for a sell-back isn't in the vault, unless it was unwound back.
       AND (NOT EXISTS (SELECT 1 FROM exec_records e WHERE e.gift_id = gifts.id AND e.kind = 'to_wallet')
            OR EXISTS (SELECT 1 FROM exec_records e WHERE e.gift_id = gifts.id AND e.kind = 'unwind' AND e.status = 'confirmed'))
     GROUP BY lower(token_address)
     ORDER BY 1`,
    [VAULT_LIABILITY_STATUSES],
  );
  return rows.map((r) => ({ tokenAddress: r.token_address, ticker: r.ticker, gifts: Number(r.gifts), amountRaw: BigInt(r.amount) }));
}

export type BalanceOf = (tokenAddress: string) => Promise<bigint>;

export async function reconcile(db: Queryable, balanceOf: BalanceOf): Promise<{ ok: boolean; rows: ReconcileRow[]; checkedAt: number }> {
  const owed = await liabilities(db);
  const rows = await Promise.all(
    owed.map(async (l) => {
      const holdingRaw = await balanceOf(l.tokenAddress);
      const surplusRaw = holdingRaw - l.amountRaw;
      return { ...l, holdingRaw, surplusRaw, ok: surplusRaw >= 0n };
    }),
  );
  return { ok: rows.every((r) => r.ok), rows, checkedAt: Date.now() };
}

/**
 * Raw ERC-20 balanceOf read straight from BSC. Raw units match the stored token amounts
 * (bStocks' balanceOfUI applies a display multiplier; don't use it here).
 */
export function onchainBalanceOf(holder: Address, rpcUrl = process.env.BSC_RPC_URL ?? "https://bsc-dataseed.bnbchain.org"): BalanceOf {
  const client = createPublicClient({ chain: bsc, transport: http(rpcUrl, { timeout: 10_000, retryCount: 2 }) });
  return (token) => client.readContract({ address: token as Address, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
}
