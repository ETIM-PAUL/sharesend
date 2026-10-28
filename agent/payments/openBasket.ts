// Opens a basket: several stocks in one gift, paid with one signature and claimed with one link.
//
// Each stock is its own gift row (bought, returned and refunded like any gift). The first one, the lead, holds the
// payment requirements for the whole basket's total; paying it marks every stock in the basket paid together.
import { randomUUID } from "node:crypto";
import { isAddress } from "viem";
import { config } from "../config.js";
import type { Db } from "../db/pool.js";
import { createGift, StaleStateError, transition, type Gift } from "../gifts/ledger.js";
import { quoteGift } from "../pricing/quote.js";
import type { GiftQuote, RejectCode } from "../pricing/picker.js";
import { payAssets } from "./b402.js";
import { buildAccepts, PAYMENT_TIMEOUT_SECONDS } from "./x402.js";

export const MIN_BASKET_STOCKS = 2;
export const MAX_BASKET_STOCKS = 5;

export interface OpenBasketInput {
  items: { ticker: string; usd: number }[];
  senderAddress: string;
  senderName: string;
  recipientName: string;
  message?: string;
  returnAs?: "stock" | "usdt";
}

export type OpenBasketResult =
  | { ok: true; gift: Gift; items: { gift: Gift; quote: GiftQuote }[]; totalUsd: number }
  | { ok: false; status: 400 | 422 | 503; code: RejectCode | "BAD_INPUT" | "NO_PAYMENT_ASSETS"; message: string };

const cents = (n: number) => Math.round(n * 100) / 100;
const bad = (message: string): OpenBasketResult => ({ ok: false, status: 400, code: "BAD_INPUT", message });

/** Stocks after the lead stay open a little longer than the lead, so the lead is always the first to expire. */
const SIBLING_EXTRA_MS = 120_000;

export async function openBasket(db: Db, input: OpenBasketInput, dailyUsedUsd: number, channel: "web" | "agent" = "web"): Promise<OpenBasketResult> {
  if (!input || !Array.isArray(input.items)) return bad("items required");
  if (input.items.length < MIN_BASKET_STOCKS || input.items.length > MAX_BASKET_STOCKS) return bad(`a basket holds ${MIN_BASKET_STOCKS} to ${MAX_BASKET_STOCKS} different stocks`);
  const items: { ticker: string; usd: number }[] = [];
  for (const it of input.items) {
    if (!it || typeof it.ticker !== "string" || !/^[A-Za-z.]{1,10}$/.test(it.ticker)) return bad("each stock needs a ticker");
    if (typeof it.usd !== "number" || !Number.isFinite(it.usd) || it.usd < 1) return bad("each stock needs at least $1");
    items.push({ ticker: it.ticker.toUpperCase(), usd: cents(it.usd) });
  }
  if (new Set(items.map((i) => i.ticker)).size !== items.length) return bad("each stock can only be in the basket once");
  const total = cents(items.reduce((s, i) => s + i.usd, 0));
  if (total > config.maxGiftUsd) return bad(`a basket is limited to $${config.maxGiftUsd} in total`);
  if (typeof input.senderAddress !== "string" || !isAddress(input.senderAddress)) return bad("senderAddress must be an address");
  const vault = process.env.VAULT_ADDRESS;
  if (!vault) return { ok: false, status: 503, code: "NO_PAYMENT_ASSETS", message: "VAULT_ADDRESS not configured" };

  // Price every stock first; nothing is created unless all of them can be bought.
  const quotes: GiftQuote[] = [];
  let counted = dailyUsedUsd;
  for (const it of items) {
    const q = await quoteGift(it.ticker, it.usd, counted);
    if (!q.ok) return { ok: false, status: 422, code: q.code, message: `${it.ticker}: ${q.message}` };
    quotes.push(q.quote);
    counted += it.usd;
  }
  const totalUsd = cents(quotes.reduce((s, q) => s + q.totalUsd, 0));
  const accepts = buildAccepts(await payAssets(), totalUsd, vault);
  if (accepts.length === 0) return { ok: false, status: 503, code: "NO_PAYMENT_ASSETS", message: "B402 offers no payment assets right now" };

  const leadId = randomUUID();
  const created: { gift: Gift; quote: GiftQuote }[] = [];
  try {
    for (const [i, q] of quotes.entries()) {
      const lead = i === 0;
      const { gift } = await createGift(
        db,
        {
          id: lead ? leadId : undefined,
          basketId: leadId,
          senderAddress: input.senderAddress,
          senderName: input.senderName,
          recipientName: input.recipientName,
          message: input.message,
          ticker: q.ticker,
          issuer: q.issuer,
          tokenAddress: q.tokenAddress,
          tokenDecimals: q.tokenDecimals,
          quotedTokenAmount: BigInt(q.tokenAmountRaw),
          usdCost: q.giftUsd,
          feeUsd: q.feeUsd,
          quoteId: q.quoteId,
          paymentExpiresAt: new Date(Date.now() + PAYMENT_TIMEOUT_SECONDS * 1000 + (lead ? 0 : SIBLING_EXTRA_MS)),
          dryRun: !config.liveTrading,
          returnAs: input.returnAs === "usdt" ? "usdt" : "stock",
          paymentRequirements: lead ? accepts : undefined,
          channel,
        },
        { maxGiftUsd: config.maxGiftUsd, dailyCapUsd: config.dailyCapUsd },
      );
      created.push({ gift, quote: q });
    }
    return { ok: true, gift: created[0]!.gift, items: created, totalUsd };
  } catch (e) {
    // Don't leave a half-made basket that could be paid for.
    for (const c of created) await transition(db, c.gift.id, "AWAITING_PAYMENT", "EXPIRED", { failureReason: "the basket couldn't be created" }).catch((x) => { if (!(x instanceof StaleStateError)) throw x; });
    return bad((e as Error).message);
  }
}
