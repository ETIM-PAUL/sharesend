// Pays for a gift as a standard x402 client, using the Agentic Wallet (`baw x402-payment`). For the Phase 7
// live test: the Agentic Wallet is the sender, the vault receives gift + fee via B402.
//   npm run cli -- b402-pay <SERVER_URL> <TICKER> <USD> [--token USDT|U|USD1|USDC] --confirm
// Moves real funds when the server runs with LIVE_TRADING=true. Run only after approval in the conversation.
import { runBaw } from "../baw/cli.js";

interface PreviewOption {
  index: number;
  status: "READY_TO_SIGN" | "ACTION_REQUIRED" | "NOT_SIGNABLE";
  reasons: string[];
  tokenSymbol?: string;
  amount?: string;
  assetTransferMethod?: string;
  needApproveFirst?: boolean;
}

export async function b402PayCommand(args: string[]): Promise<void> {
  const [server, ticker, usdArg] = args;
  if (!server || !ticker || !usdArg) throw new Error("usage: npm run cli -- b402-pay <SERVER_URL> <TICKER> <USD> [--token USDT] --confirm");
  if (!args.includes("--confirm")) throw new Error("b402-pay signs a real payment: add --confirm (only after approval in the conversation)");
  const ti = args.indexOf("--token");
  const token = ti >= 0 ? args[ti + 1]?.toUpperCase() : undefined;
  const sender = process.env.AGENTIC_WALLET_ADDRESS;
  if (!sender) throw new Error("Missing env var AGENTIC_WALLET_ADDRESS");

  const open = await fetch(`${server}/gifts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticker, usd: Number(usdArg), senderAddress: sender, senderName: "Live test", recipientName: "Test recipient", message: "Phase 7 live payment test" }),
  });
  const body: any = await open.json();
  if (open.status !== 402) throw new Error(`expected 402, got ${open.status}: ${JSON.stringify(body)}`);
  const header = open.headers.get("payment-required");
  if (!header) throw new Error("402 without PAYMENT-REQUIRED header");
  console.log(`gift ${body.gift.id}: ${body.quote.issuer} ${body.quote.tokenSymbol}, total $${body.quote.totalUsd} (gift $${body.quote.giftUsd} + fee $${body.quote.feeUsd})`);

  const preview = await runBaw<{ paymentId: string; options: PreviewOption[] }>(["x402-payment", "preview", "--paymentRequirements", header]);
  for (const o of preview.options) console.log(`  option ${o.index}: ${o.tokenSymbol} ${o.amount} via ${o.assetTransferMethod} — ${o.status}${o.reasons.length ? ` (${o.reasons.join(", ")})` : ""}${o.needApproveFirst ? ", needs Permit2 approve" : ""}`);
  const choice = preview.options.find((o) => o.status === "READY_TO_SIGN" && (!token || o.tokenSymbol?.toUpperCase() === token));
  if (!choice) throw new Error(`no READY_TO_SIGN option${token ? ` for ${token}` : ""}`);

  const signed = await runBaw<{ paymentHeaderValue: string; approveTxHash: string | null; signatureExpiresAt: number }>([
    "x402-payment", "sign", "--paymentId", preview.paymentId, "--selectedIndex", String(choice.index),
  ]);
  if (signed.approveTxHash) {
    console.log(`Permit2 approve sent: ${signed.approveTxHash}; waiting for it to confirm`);
    for (let i = 0; i < 40; i++) {
      const h = await runBaw<{ transactions: { status: string }[] }>(["wallet", "tx-history", "--tx", signed.approveTxHash]).catch(() => null);
      if (h?.transactions?.[0]?.status === "confirmed") break;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  // Replay right away: the signature is short-lived.
  const paid = await fetch(`${server}/gifts/${body.gift.id}/pay`, { method: "POST", headers: { "PAYMENT-SIGNATURE": signed.paymentHeaderValue } });
  const pb: any = await paid.json();
  if (!paid.ok) throw new Error(`payment failed (${paid.status}): ${pb.error ?? JSON.stringify(pb)}`);
  console.log(`PAID. settlement tx: ${pb.settleTx}${pb.settleTx ? `  https://bscscan.com/tx/${pb.settleTx}` : ""}`);
  console.log(`gift status: ${pb.gift.status}${pb.claimUrl ? " — claim link issued (not printed; it's a secret)" : ""}`);
}
