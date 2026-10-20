// Gift + payment routes (x402 v2 over B402).
//   POST /gifts                 create a gift → 402 Payment Required (body + PAYMENT-REQUIRED header)
//                               the same request again with PAYMENT-SIGNATURE → paid, claim link (any x402 client or agent)
//   GET|POST /gifts/:id/pay     no PAYMENT-SIGNATURE → 402 again; with it → verify, settle, PAID, claim link
//   POST /gifts/:id/pay/draft   {from, asset} → exact EIP-712 data to sign, balance, and the Permit2 approve tx if needed
//   GET /pay/:id                minimal pay page for browser wallets (MetaMask, Binance Web3 Wallet, Trust, …)
//   GET /gifts/:id              public status (no sender address, no message, no codes)
//   POST /gifts/:id/cancel      {message, signature} signed by the sender → expire / refund / return
//   POST /gifts/:id/link        {message, signature} signed by the sender → new claim link (old one stops working)
//   POST /gifts/:id/return-as   {message, signature} signed by the sender → "stock" or "usdt" if the gift comes back
//   GET /search?q=              tokenized stocks on BSC by ticker or company name
//   GET /economics              self-funding ledger summary
import { Hono, type Context } from "hono";
import { config } from "../config.js";
import { getDb } from "../db/pool.js";
import { dailyUsedUsd, getGift, reissueClaimCode, setReturnAs, type Gift } from "../gifts/ledger.js";
import { actionOf, verifySender, type SenderAction } from "../gifts/senderAuth.js";
import { publicClient } from "../chain/bsc.js";
import { searchTickers } from "../binance/rwa.js";
import { cancelGift } from "../execution/cancel.js";
import { advanceInBackground } from "../execution/advance.js";
import { claimLink } from "../gifts/codes.js";
import { BinanceError } from "../binance/errors.js";
import { b402, BSC_NETWORK, type PaymentRequirements } from "../payments/b402.js";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAddress } from "viem";
import { decodePaymentHeader, encodeHeader, payerOf, paymentRequired, permit2ApproveTx, sameRequirements, signingRequest } from "../payments/x402.js";
import type { PaymentPayload } from "../payments/b402.js";
import type { GiftChannel } from "../gifts/ledger.js";
import { onchainFunds, payForGift } from "../payments/pay.js";
import { openGift } from "../payments/openGift.js";
import { economics } from "../payments/economics.js";

export const gifts = new Hono();

// Small per-IP limiter for gift creation (each one calls Binance and writes a row).
const hits = new Map<string, number[]>();
function limited(ip: string, max = 10, windowMs = 60_000): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 10_000) hits.clear();
  return recent.length > max;
}

const clientIp = (c: Context) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";

function origin(c: Context): string {
  const u = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto") ?? u.protocol.replace(":", "");
  return `${proto}://${c.req.header("x-forwarded-host") ?? u.host}`;
}

function publicGift(g: Gift) {
  return {
    id: g.id,
    status: g.status,
    step: g.step,
    ticker: g.ticker,
    issuer: g.issuer,
    tokenAddress: g.tokenAddress,
    usd: g.usdCost,
    fee: g.feeUsd,
    recipientName: g.recipientName,
    paymentExpiresAt: g.paymentExpiresAt,
    claimExpiresAt: g.claimExpiresAt,
    createdAt: g.createdAt,
    returnAs: g.returnAs,
    channel: g.channel,
    // Group gifts: a contribution (never bought on its own) or the group's pooled gift.
    group: g.groupId ? { id: g.groupId, role: g.groupRole } : null,
    // A conditional order: where it stands, never anything private.
    order: g.order
      ? {
          dropPct: g.order.dropPct,
          baseline: g.order.baseline,
          trigger: g.order.trigger,
          deadline: g.order.deadline,
          text: g.order.text,
          triggered: !!g.order.triggeredAt,
          lastPrice: g.order.lastPrice,
          checkedAt: g.order.checkedAt,
        }
      : null,
    dryRun: g.dryRun,
    failureReason: g.failureReason,
    // The recipient's one-time thank-you, once they've left it.
    thanks: g.thanksNote ? { note: g.thanksNote, at: g.thankedAt } : null,
    // Public on-chain anyway; real hashes only (dry runs use synthetic ones).
    txs: Object.fromEntries(
      Object.entries({ payment: g.paymentTx, buy: g.buyTx, vault: g.vaultTx, claim: g.claimTx, return: g.returnTx, refund: g.refundTx }).filter(
        ([, v]) => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v),
      ),
    ),
  };
}

export function respond402(c: Context, g: Gift, error?: string, extra: Record<string, unknown> = {}) {
  const body = paymentRequired(`${origin(c)}/gifts/${g.id}/pay`, `${g.ticker} gift for ${g.recipientName}: $${g.usdCost} + $${g.feeUsd} fee`, (g.paymentRequirements ?? []) as PaymentRequirements[], error);
  c.header("PAYMENT-REQUIRED", encodeHeader(body));
  return c.json({ ...body, gift: publicGift(g), ...extra }, 402);
}

function dbOr503(c: Context) {
  try {
    return getDb();
  } catch {
    return null;
  }
}

/** The web app calls from one of WEB_ORIGINS; anything else (no Origin, another site) is another agent or script. */
function channelOf(c: Context): GiftChannel {
  const webOrigins = (process.env.WEB_ORIGINS ?? "http://localhost:3000").split(",").map((o) => o.trim());
  const o = c.req.header("origin");
  return o && webOrigins.includes(o) ? "web" : "agent";
}

/**
 * x402 at a single URL: a client that got a 402 from POST /gifts sends the same request again with PAYMENT-SIGNATURE.
 * The payment is matched to the open gift it was signed for (same sender, stock, amount and recipient, and the exact
 * requirements it accepted); with none left (e.g. the price hold ran out), a fresh gift is opened for it.
 */
async function payAtCreate(c: Context, db: NonNullable<ReturnType<typeof dbOr503>>, input: any, header: string) {
  const payload = decodePaymentHeader(header);
  if (!payload) return c.json({ ok: false, error: "malformed PAYMENT-SIGNATURE header" }, 400);
  const payer = payerOf(payload);
  if (!payer) return c.json({ ok: false, error: "the payment has no payer address" }, 400);
  if (input?.senderAddress && String(input.senderAddress).toLowerCase() !== payer.toLowerCase())
    return c.json({ ok: false, error: "senderAddress must be the address that signs the payment" }, 400);

  let g: Gift | null = null;
  if (typeof input?.giftId === "string") g = await getGift(db, input.giftId);
  else {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM gifts WHERE status = 'AWAITING_PAYMENT' AND payment_expires_at > now() AND group_id IS NULL
         AND lower(sender_address) = lower($1) AND ticker = upper($2) AND usd_cost = $3 AND recipient_name = $4
       ORDER BY created_at DESC LIMIT 5`,
      [payer, String(input?.ticker ?? ""), Math.round(Number(input?.usd) * 100) / 100, String(input?.recipientName ?? "").trim()],
    );
    for (const r of rows) {
      const cand = await getGift(db, r.id);
      if (cand && ((cand.paymentRequirements ?? []) as PaymentRequirements[]).some((req) => sameRequirements(req, (payload as PaymentPayload).accepted))) {
        g = cand;
        break;
      }
    }
  }
  if (!g) {
    const r = await openGift(db, { ...(input ?? {}), senderAddress: payer }, await dailyUsedUsd(db), channelOf(c));
    if (!r.ok) return c.json({ ok: false, code: r.code, error: r.message }, r.status);
    g = r.gift;
  }
  return settle(c, db, g, payload);
}

gifts.post("/gifts", async (c) => {
  if (limited(clientIp(c))) return c.json({ ok: false, error: "too many requests" }, 429);
  const db = dbOr503(c);
  if (!db) return c.json({ ok: false, error: "database not configured" }, 503);
  const input = await c.req.json().catch(() => null);
  try {
    const header = c.req.header("PAYMENT-SIGNATURE") ?? c.req.header("X-PAYMENT");
    if (header) return await payAtCreate(c, db, input, header);
    const r = await openGift(db, input, await dailyUsedUsd(db), channelOf(c));
    if (!r.ok) return c.json({ ok: false, code: r.code, error: r.message }, r.status);
    const q = r.quote;
    c.header("Location", `/gifts/${r.gift.id}/pay`);
    // Quote details for the UI alongside the standard 402 body.
    return respond402(c, r.gift, undefined, {
        quote: {
          issuer: q.issuerLabel,
          tokenSymbol: q.tokenSymbol,
          tokenAmount: q.tokenAmount,
          sharesOut: q.sharesOut,
          pricePerShare: q.pricePerShare,
          reason: q.reason,
          warnings: q.warnings,
          giftUsd: q.giftUsd,
          feeUsd: q.feeUsd,
          totalUsd: q.totalUsd,
        },
    });
  } catch (e) {
    if (e instanceof BinanceError) return c.json({ ok: false, error: `Binance: ${e.message}` }, 502);
    throw e;
  }
});

async function pay(c: Context) {
  const db = dbOr503(c);
  if (!db) return c.json({ ok: false, error: "database not configured" }, 503);
  const id = c.req.param("id")!;
  const g = await getGift(db, id);
  if (!g) return c.json({ ok: false, error: "gift not found" }, 404);

  const header = c.req.header("PAYMENT-SIGNATURE") ?? c.req.header("X-PAYMENT");
  if (!header) {
    if (g.status !== "AWAITING_PAYMENT") return c.json({ ok: false, error: `gift is ${g.status}`, gift: publicGift(g) }, 409);
    if (g.paymentExpiresAt.getTime() <= Date.now()) return c.json({ ok: false, error: "payment window expired; request a new quote" }, 410);
    return respond402(c, g);
  }
  const payload = decodePaymentHeader(header);
  if (!payload) return respond402(c, g, "malformed PAYMENT-SIGNATURE header");
  return settle(c, db, g, payload);
}

/** Verify, settle and answer for one gift and one payment. */
async function settle(c: Context, db: NonNullable<ReturnType<typeof dbOr503>>, g: Gift, payload: PaymentPayload) {
  const id = g.id;
  try {
    const r = await payForGift({ db, facilitator: b402, funds: onchainFunds, liveTrading: config.liveTrading }, id, payload);
    if (!r.ok) {
      if (r.status === 402) return respond402(c, g, r.error);
      return c.json({ ok: false, error: r.error, retryable: r.retryable ?? false }, r.status);
    }
    c.header("PAYMENT-RESPONSE", encodeHeader({ success: true, transaction: r.settleTx ?? "", network: BSC_NETWORK, payer: r.gift.senderAddress }));
    // Start the buy right away when this host can run it (needs a signed-in `baw`); otherwise it waits as "queued".
    if (!r.alreadyPaid && process.env.AUTO_EXECUTE === "true") advanceInBackground(db, id);
    const base = process.env.CLAIM_BASE_URL ?? origin(c);
    // A group contribution has no claim link of its own: the group's gift gets one when the group closes.
    const contribution = r.gift.groupRole === "contribution";
    return c.json({
      ok: true,
      gift: publicGift(r.gift),
      settleTx: r.settleTx,
      // Only present in the first successful response. Share it with the recipient; it can't be shown again.
      claimUrl: r.claimCode && !contribution ? claimLink(base, r.gift.id, r.claimCode) : null,
      groupUrl: contribution ? `${base}/g/${r.gift.groupId}` : null,
      alreadyPaid: r.alreadyPaid,
    });
  } catch (e) {
    if (e instanceof BinanceError) return c.json({ ok: false, error: `B402: ${e.message}`, retryable: e.retryable }, 502);
    throw e;
  }
}

gifts.get("/gifts/:id/pay", pay);
gifts.post("/gifts/:id/pay", pay);

// What a browser wallet needs to pay: the typed data to sign (built server-side from the same tested code that
// checks payments), the payer's balance, and the one-time Permit2 approve tx when the asset needs it.
gifts.post("/gifts/:id/pay/draft", async (c) => {
  if (limited(clientIp(c), 30)) return c.json({ ok: false, error: "too many requests" }, 429);
  const db = dbOr503(c);
  if (!db) return c.json({ ok: false, error: "database not configured" }, 503);
  const g = await getGift(db, c.req.param("id"));
  if (!g) return c.json({ ok: false, error: "gift not found" }, 404);
  if (g.status !== "AWAITING_PAYMENT") return c.json({ ok: false, error: `gift is ${g.status}`, gift: publicGift(g) }, 409);
  if (g.paymentExpiresAt.getTime() <= Date.now()) return c.json({ ok: false, error: "payment window expired; request a new quote" }, 410);

  const body = (await c.req.json().catch(() => null)) as { from?: string; asset?: string } | null;
  if (!body?.from || !isAddress(body.from) || !body.asset || !isAddress(body.asset)) return c.json({ ok: false, error: "from and asset must be addresses" }, 400);
  if (body.from.toLowerCase() !== g.senderAddress.toLowerCase())
    return c.json({ ok: false, error: `this gift must be paid from ${g.senderAddress}; switch to that account in your wallet` }, 400);
  const requirement = ((g.paymentRequirements ?? []) as PaymentRequirements[]).find((r) => r.asset.toLowerCase() === body.asset!.toLowerCase());
  if (!requirement) return c.json({ ok: false, error: "asset not offered for this gift" }, 400);

  const funds = await onchainFunds.check(requirement.asset, body.from, requirement.extra.assetTransferMethod);
  const amount = BigInt(requirement.amount);
  const needsApproval = funds.allowance !== null && funds.allowance < amount;
  const req = signingRequest(requirement, body.from, Math.floor(Date.now() / 1000), randomBytes(32));
  return c.json({
    ok: true,
    requirement,
    resource: { url: `${origin(c)}/gifts/${g.id}/pay`, description: `${g.ticker} gift for ${g.recipientName}`, mimeType: "application/json" },
    method: req.method,
    balance: funds.balance.toString(),
    sufficient: funds.balance >= amount,
    needsApproval,
    approveTx: needsApproval ? permit2ApproveTx(requirement.asset) : null,
    typedData: req.typedData,
    draft: req.draft,
  });
});

// The pay page is static; the gift id comes from the URL. Read once at boot.
const payPage = readFileSync(new URL("../public/pay.html", import.meta.url), "utf8");
gifts.get("/pay/:id", (c) => c.html(payPage));

gifts.get("/gifts/:id", async (c) => {
  const db = dbOr503(c);
  if (!db) return c.json({ ok: false, error: "database not configured" }, 503);
  const g = await getGift(db, c.req.param("id"));
  if (!g) return c.json({ ok: false, error: "gift not found" }, 404);
  // What the sender got back when it was sold: USDT sent to them (raw units, 18 decimals), if that happened.
  const cash = await db.query<{ amount: string }>("SELECT amount FROM exec_records WHERE gift_id = $1 AND kind = 'cashout' AND status = 'confirmed'", [g.id]);
  return c.json({ ok: true, gift: publicGift(g), returnedUsdt: cash.rows[0] ? Number(BigInt(cash.rows[0].amount) / 10n ** 14n) / 10_000 : null });
});

const verifyWithChain = (address: string, message: string, signature: string) =>
  // Handles EOAs and smart-contract wallets (ERC-1271).
  publicClient().verifyMessage({ address: address as `0x${string}`, message, signature: signature as `0x${string}` });

/** Checks a sender-signed request. `actions` lists the signed messages the route accepts; returns which one it was. */
async function senderAction(c: Context, actions: SenderAction[]) {
  if (limited(clientIp(c), 20)) return { res: c.json({ ok: false, error: "too many requests" }, 429) };
  const db = dbOr503(c);
  if (!db) return { res: c.json({ ok: false, error: "database not configured" }, 503) };
  const g = await getGift(db, c.req.param("id")!);
  if (!g) return { res: c.json({ ok: false, error: "gift not found" }, 404) };
  const body = (await c.req.json().catch(() => null)) as { message?: unknown; signature?: unknown } | null;
  const action = actionOf(body?.message, g.id, actions);
  if (!action) return { res: c.json({ ok: false, error: "message doesn't match this action and gift" }, 401) };
  const auth = await verifySender(db, g, action, body?.message, body?.signature, verifyWithChain);
  if (!auth.ok) return { res: c.json({ ok: false, error: auth.error }, 401) };
  return { db, g, action };
}

gifts.post("/gifts/:id/cancel", async (c) => {
  const a = await senderAction(c, ["cancel", "cancel-stock", "cancel-usdt"]);
  if ("res" in a) return a.res;
  const returnAs = a.action === "cancel-usdt" ? "usdt" : a.action === "cancel-stock" ? "stock" : undefined;
  const r = await cancelGift(a.db!, a.g!.id, undefined, returnAs);
  return r.ok ? c.json({ ok: true, gift: publicGift(r.gift) }) : c.json({ ok: false, error: r.error }, r.status);
});

// How an unclaimed gift comes back to the sender: the stock itself, or sold into USDT. Changeable until the sale starts.
gifts.post("/gifts/:id/return-as", async (c) => {
  const a = await senderAction(c, ["return-stock", "return-usdt"]);
  if ("res" in a) return a.res;
  const choice = a.action === "return-usdt" ? "usdt" : "stock";
  if (!(await setReturnAs(a.db!, a.g!.id, choice))) return c.json({ ok: false, error: "it's too late to change this: the return has already started or finished" }, 409);
  return c.json({ ok: true, returnAs: choice });
});

gifts.post("/gifts/:id/link", async (c) => {
  const a = await senderAction(c, ["link"]);
  if ("res" in a) return a.res;
  const code = await reissueClaimCode(a.db!, a.g!.id);
  if (!code) return c.json({ ok: false, error: `a new link can't be made while the gift is ${a.g!.status.toLowerCase()}` }, 409);
  return c.json({ ok: true, claimUrl: claimLink(process.env.CLAIM_BASE_URL ?? origin(c), a.g!.id, code) });
});

gifts.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").slice(0, 40);
  if (!q.trim()) return c.json({ ok: true, results: [] });
  try {
    return c.json({ ok: true, results: (await searchTickers(q)).slice(0, 12) });
  } catch (e) {
    if (e instanceof BinanceError) return c.json({ ok: false, error: `Binance: ${e.message}` }, 502);
    throw e;
  }
});

gifts.get("/economics", async (c) => {
  const db = dbOr503(c);
  if (!db) return c.json({ ok: false, error: "database not configured" }, 503);
  return c.json({ ok: true, ...(await economics(db)) });
});
