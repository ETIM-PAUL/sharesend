// Opens a gift: fresh quote → gift in AWAITING_PAYMENT holding the exact x402 requirements it will accept.
import { isAddress } from "viem";
import { config } from "../config.js";
import type { Db } from "../db/pool.js";
import { createGift, MAX_ORDER_DAYS, MAX_ORDER_DROP_PCT, type Gift, type GiftChannel } from "../gifts/ledger.js";
import { committedUsd, getGroup, type PoolQuote } from "../gifts/groups.js";
import { quoteGift } from "../pricing/quote.js";
import type { GiftQuote, RejectCode } from "../pricing/picker.js";
import { payAssets } from "./b402.js";
import { buildAccepts, PAYMENT_TIMEOUT_SECONDS } from "./x402.js";

export interface OpenGiftInput {
  ticker: string;
  usd: number;
  senderAddress: string;
  senderName: string;
  recipientName: string;
  message?: string;
  /** If the gift comes back to the sender: the stock itself (default) or USDT from selling it. */
  returnAs?: "stock" | "usdt";
  /** Buy only when the price per share has dropped by `dropPct` from its price now, by `deadline` (ISO 8601). */
  order?: { dropPct: number; deadline: string; text?: string };
  /** A contribution to an open group gift: the group sets the stock and the recipient. */
  groupId?: string;
}

export type OpenGiftResult =
  | { ok: true; gift: Gift; quote: GiftQuote }
  | { ok: false; status: 400 | 422 | 503; code: RejectCode | "BAD_INPUT" | "NO_PAYMENT_ASSETS"; message: string };

export async function openGift(db: Db, input: OpenGiftInput, dailyUsedUsd: number, channel: GiftChannel = "web"): Promise<OpenGiftResult> {
  let groupId: string | undefined;
  if (input && input.groupId !== undefined) {
    const grp = typeof input.groupId === "string" ? await getGroup(db, input.groupId) : null;
    if (!grp) return { ok: false, status: 400, code: "BAD_INPUT", message: "group not found" };
    if (grp.status !== "OPEN" || grp.closesAt.getTime() <= Date.now()) return { ok: false, status: 400, code: "BAD_INPUT", message: "this group gift has closed" };
    if (input.order) return { ok: false, status: 400, code: "BAD_INPUT", message: "a contribution can't be a price order" };
    const usd = typeof input.usd === "number" ? Math.round(input.usd * 100) / 100 : NaN;
    const room = Math.round((config.maxGiftUsd - (await committedUsd(db, grp.id))) * 100) / 100;
    if (!(usd <= room)) return { ok: false, status: 400, code: "BAD_INPUT", message: room > 0 ? `this group gift can take $${room.toFixed(2)} more` : "this group gift is full" };
    input = { ...input, ticker: grp.ticker, recipientName: grp.recipientName, returnAs: "stock" };
    groupId = grp.id;
  }
  if (!input || typeof input.ticker !== "string" || !/^[A-Za-z.]{1,10}$/.test(input.ticker)) return { ok: false, status: 400, code: "BAD_INPUT", message: "ticker required" };
  if (typeof input.usd !== "number" || !Number.isFinite(input.usd)) return { ok: false, status: 400, code: "BAD_INPUT", message: "usd must be a number" };
  if (typeof input.senderAddress !== "string" || !isAddress(input.senderAddress)) return { ok: false, status: 400, code: "BAD_INPUT", message: "senderAddress must be an address" };
  const vault = process.env.VAULT_ADDRESS;
  if (!vault) return { ok: false, status: 503, code: "NO_PAYMENT_ASSETS", message: "VAULT_ADDRESS not configured" };

  let order: { dropPct: number; deadline: Date; text?: string } | undefined;
  if (input.order !== undefined && input.order !== null) {
    const o = input.order;
    const deadline = typeof o.deadline === "string" ? new Date(o.deadline) : new Date(NaN);
    if (typeof o.dropPct !== "number" || !Number.isFinite(o.dropPct) || !(o.dropPct > 0 && o.dropPct <= MAX_ORDER_DROP_PCT))
      return { ok: false, status: 400, code: "BAD_INPUT", message: `the price drop must be more than 0% and at most ${MAX_ORDER_DROP_PCT}%` };
    if (Number.isNaN(deadline.getTime())) return { ok: false, status: 400, code: "BAD_INPUT", message: "the deadline isn't a valid date and time" };
    const ms = deadline.getTime() - Date.now();
    if (ms < 10 * 60_000) return { ok: false, status: 400, code: "BAD_INPUT", message: "the deadline must be at least 10 minutes from now" };
    if (ms > MAX_ORDER_DAYS * 86_400_000) return { ok: false, status: 400, code: "BAD_INPUT", message: `the deadline can be at most ${MAX_ORDER_DAYS} days away` };
    order = { dropPct: Math.round(o.dropPct * 1000) / 1000, deadline, text: typeof o.text === "string" ? o.text : undefined };
  }

  const q = await quoteGift(input.ticker, Math.round(input.usd * 100) / 100, dailyUsedUsd);
  if (!q.ok) return { ok: false, status: 422, code: q.code, message: q.message };

  const accepts = buildAccepts(await payAssets(), q.quote.totalUsd, vault);
  if (accepts.length === 0) return { ok: false, status: 503, code: "NO_PAYMENT_ASSETS", message: "B402 offers no payment assets right now" };

  try {
    const { gift } = await createGift(
      db,
      {
        senderAddress: input.senderAddress,
        senderName: input.senderName,
        recipientName: input.recipientName,
        message: input.message,
        ticker: q.quote.ticker,
        issuer: q.quote.issuer,
        tokenAddress: q.quote.tokenAddress,
        tokenDecimals: q.quote.tokenDecimals,
        quotedTokenAmount: BigInt(q.quote.tokenAmountRaw),
        usdCost: q.quote.giftUsd,
        feeUsd: q.quote.feeUsd,
        quoteId: q.quote.quoteId,
        paymentExpiresAt: new Date(Date.now() + PAYMENT_TIMEOUT_SECONDS * 1000),
        dryRun: !config.liveTrading,
        returnAs: input.returnAs === "usdt" ? "usdt" : "stock",
        order: order ? { ...order, baseline: q.quote.pricePerShare } : undefined,
        paymentRequirements: accepts,
        channel,
        groupId,
      },
      { maxGiftUsd: config.maxGiftUsd, dailyCapUsd: config.dailyCapUsd },
    );
    // createGift returned a claim code; it is discarded on purpose. The real code is issued after payment.
    return { ok: true, gift, quote: q.quote };
  } catch (e) {
    return { ok: false, status: 400, code: "BAD_INPUT", message: (e as Error).message };
  }
}

/** Price for a closing group's pooled gift. Its contributions already counted against today's cap, so this doesn't. */
export const poolQuote: PoolQuote = async (ticker, usd) => {
  const q = await quoteGift(ticker, usd, 0);
  if (!q.ok) return { ok: false, message: q.message };
  return { ok: true, issuer: q.quote.issuer, tokenAddress: q.quote.tokenAddress, tokenDecimals: q.quote.tokenDecimals, tokenAmountRaw: q.quote.tokenAmountRaw, quoteId: q.quote.quoteId, name: q.quote.name };
};
