// For other agents: how to send a stock gift through ShareSend, machine-readable and as a skill file.
//   GET /.well-known/agent-card.json   what ShareSend does, its endpoints, payment method and on-chain identity
//   GET /skill.md                      step-by-step instructions an agent (or its operator) can follow
// The gift endpoint itself is POST /gifts (x402 v2 over B402), already listed in the ERC-8004 registration.
import { Hono, type Context } from "hono";
import { config } from "../config.js";

export const forAgents = new Hono();

function base(c: Context): string {
  const u = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto") ?? u.protocol.replace(":", "");
  return `${proto}://${c.req.header("x-forwarded-host") ?? u.host}`;
}

forAgents.get("/.well-known/agent-card.json", (c) => {
  const b = base(c);
  const agentId = Number(process.env.ERC8004_AGENT_ID) || null;
  return c.json({
    name: "ShareSend",
    description:
      "Sends a slice of a real US company (tokenized stock on BNB Chain) to a person as a claim link. Any agent can pay for a gift over x402 (B402) and pass the link on; the recipient claims it with an email wallet, as shares or as USDT.",
    url: b,
    version: "1.0.0",
    identity: agentId ? { standard: "ERC-8004", network: "bsc-mainnet", agentId, registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" } : null,
    payment: { protocol: "x402", x402Version: 2, facilitator: "B402 (Binance)", network: "eip155:56", assets: "USDT, USDC, U, USD1 (as offered in each 402)" },
    skills: [
      {
        id: "send_stock_gift",
        name: "Send a stock gift",
        description: "Buys a tokenized stock for a recipient and returns a one-time claim link. The payer is the sender: refunds and returns go back to it.",
        method: "POST",
        endpoint: `${b}/gifts`,
        input: {
          ticker: "string, e.g. NVDA",
          usd: `number, 1 to ${config.maxGiftUsd}`,
          senderAddress: "the address that signs the payment",
          senderName: "string, shown to the recipient",
          recipientName: "string",
          message: "optional string, up to 280 characters",
        },
        flow: "POST once → 402 with PAYMENT-REQUIRED. Sign one option, POST the same body again with PAYMENT-SIGNATURE → 200 with claimUrl.",
      },
      { id: "quote", name: "Price a gift", method: "GET", endpoint: `${b}/quote?ticker=NVDA&usd=5`, description: "The issuer, shares and fee a gift would get. Nothing is created." },
      { id: "gift_status", name: "Track a gift", method: "GET", endpoint: `${b}/gifts/{id}`, description: "Public status and transaction links." },
    ],
    limits: { maxGiftUsd: config.maxGiftUsd, dailyCapUsd: config.dailyCapUsd, liveTrading: config.liveTrading },
    docs: `${b}/skill.md`,
  });
});

forAgents.get("/skill.md", (c) => {
  const b = base(c);
  c.header("content-type", "text/markdown; charset=utf-8");
  return c.body(`---
name: sharesend-send-stock-gift
description: Send someone a slice of a US stock (tokenized on BNB Chain) as a claim link, paid over x402 (B402). Use when an agent should gift, reward or remit stock to a person.
---

# Send a stock gift with ShareSend

ShareSend buys a tokenized stock (bStocks or Ondo, on BNB Chain) for a recipient and gives you a claim link. The
recipient opens it on their phone and claims with their email: as shares, or as USDT. You pay over x402 v2; the
facilitator is Binance's B402, on BSC mainnet (\`eip155:56\`). Gifts are $1 to $${config.maxGiftUsd}.

## 1. Ask for the price (optional)

    curl "${b}/quote?ticker=NVDA&usd=5"

## 2. Open the gift: you get 402 Payment Required

    curl -i -X POST ${b}/gifts -H 'content-type: application/json' -d '{
      "ticker": "NVDA", "usd": 5,
      "senderAddress": "0xYourPayingAddress", "senderName": "Payroll bot",
      "recipientName": "Ada", "message": "Your first share, from the team"
    }'

The response has a \`PAYMENT-REQUIRED\` header (base64 JSON) and the same object in the body: \`accepts\` lists one
option per stablecoin. The price is held for a few minutes.

## 3. Sign one option and send the same request again

Sign with any x402 v2 client. With a Binance Agentic Wallet:

    baw x402-payment preview --paymentRequirements "<PAYMENT-REQUIRED header>" --json
    baw x402-payment sign --paymentId <paymentId> --selectedIndex <index> --json

Then repeat step 2 with the header \`PAYMENT-SIGNATURE: <paymentHeaderValue>\` and the same JSON body. The answer is
200 with \`claimUrl\` (shown once: deliver it to the recipient) and a \`PAYMENT-RESPONSE\` header with the settlement tx.

## 4. Follow the gift

    curl ${b}/gifts/<giftId>

Status goes PAID → BUYING → READY → CLAIMED. If it can't be bought, the full payment is refunded to the paying
address. Unclaimed gifts return to the paying address after 30 days.

## Rules

- \`senderAddress\` must be the address that signs the payment.
- The claim link is a secret: anyone with it can claim the gift. Send it only to the recipient.
- Tokenized US stocks aren't offered to people in the United States and some other countries; the recipient confirms
  their eligibility when claiming.
`);
});
