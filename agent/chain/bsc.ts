// Read-only BSC access over a public RPC: receipts, token transfers, balances.
import { createPublicClient, erc20Abi, http, parseEventLogs, type Address, type Hash } from "viem";
import { bsc } from "viem/chains";

export const RPC_URL = process.env.BSC_RPC_URL ?? "https://bsc-dataseed.bnbchain.org";

let client: ReturnType<typeof createPublicClient> | undefined;
export function publicClient() {
  client ??= createPublicClient({ chain: bsc, transport: http(RPC_URL, { timeout: 10_000, retryCount: 2 }) });
  return client;
}

export type TxState = "pending" | "success" | "reverted";

/** State of a tx and how many raw units of `token` it moved to `to` (sum of Transfer logs). "pending" covers not-yet-found. */
export async function transferIn(txHash: string, token: string, to: string): Promise<{ state: TxState; amount: bigint }> {
  const receipt = await publicClient()
    .getTransactionReceipt({ hash: txHash as Hash })
    .catch((e: Error) => {
      if (e.name === "TransactionReceiptNotFoundError") return null;
      throw e;
    });
  if (!receipt) return { state: "pending", amount: 0n };
  if (receipt.status !== "success") return { state: "reverted", amount: 0n };
  const logs = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs, strict: false });
  let amount = 0n;
  for (const l of logs)
    if (l.address.toLowerCase() === token.toLowerCase() && String(l.args.to).toLowerCase() === to.toLowerCase()) amount += l.args.value ?? 0n;
  return { state: "success", amount };
}

export async function tokenBalance(token: string, holder: string): Promise<bigint> {
  return publicClient().readContract({ address: token as Address, abi: erc20Abi, functionName: "balanceOf", args: [holder as Address] });
}

export async function nativeBalance(holder: string): Promise<bigint> {
  return publicClient().getBalance({ address: holder as Address });
}
