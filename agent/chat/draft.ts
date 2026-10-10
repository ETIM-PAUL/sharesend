// The chat assistant only ever proposes a draft. This turns whatever the model produced into a validated draft the
// send form can show, or a list of plain-language problems. Nothing here (or in the model) can spend money.
import { MAX_ORDER_DAYS, MAX_ORDER_DROP_PCT } from "../gifts/ledger.js";

export interface Draft {
  ticker: string;
  companyName: string;
  usd: number;
  recipientName: string;
  message: string;
  returnAs: "stock" | "usdt";
  /** Present when the gift should only be bought after a price drop. */
  order?: { dropPct: number; deadline: string };
}

export type DraftResult = { ok: true; draft: Draft } | { ok: false; problems: string[] };

export interface DraftContext {
  now: number;
  maxGiftUsd: number;
  /** Finds the tokenized stock for a ticker the model gave. null if there isn't one. */
  resolveTicker(ticker: string): Promise<{ ticker: string; name: string } | null>;
  /** Suggestions for a ticker that wasn't found. */
  suggest?(query: string): Promise<{ ticker: string; name: string }[]>;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const money = (n: number) => `$${n}`;

export async function validateDraft(raw: unknown, ctx: DraftContext): Promise<DraftResult> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const problems: string[] = [];

  const tickerIn = str(r.ticker, 12).toUpperCase();
  let stock: { ticker: string; name: string } | null = null;
  if (!tickerIn) problems.push("Which stock?");
  else {
    stock = await ctx.resolveTicker(tickerIn);
    if (!stock) {
      const alts = ctx.suggest ? (await ctx.suggest(tickerIn).catch(() => [])).slice(0, 3) : [];
      problems.push(`I couldn't find a tokenized stock called ${tickerIn}.${alts.length ? ` Did you mean ${alts.map((a) => `${a.name} (${a.ticker})`).join(", ")}?` : ""}`);
    }
  }

  const usd = typeof r.usd === "number" ? Math.round(r.usd * 100) / 100 : NaN;
  if (!Number.isFinite(usd)) problems.push("How many dollars?");
  else if (usd < 1) problems.push("The smallest gift is $1.");
  else if (usd > ctx.maxGiftUsd) problems.push(`Gifts are limited to ${money(ctx.maxGiftUsd)} each.`);

  const recipientName = str(r.recipient_name, 60);
  if (!recipientName) problems.push("Who is it for?");
  const message = str(r.message, 280);
  const returnAs = r.return_as === "usdt" ? "usdt" : "stock";

  let order: Draft["order"];
  const dropRaw = r.buy_when_price_drops_pct;
  const byRaw = str(r.buy_by, 40);
  if (dropRaw !== undefined && dropRaw !== null) {
    const drop = typeof dropRaw === "number" ? Math.round(dropRaw * 1000) / 1000 : NaN;
    if (!Number.isFinite(drop) || drop <= 0 || drop > MAX_ORDER_DROP_PCT) problems.push(`The price drop has to be more than 0% and at most ${MAX_ORDER_DROP_PCT}%.`);
    else if (!byRaw) problems.push("By when should I wait for that price? I can wait up to 7 days.");
    else {
      const t = Date.parse(byRaw);
      // Needs an explicit offset (Z or ±hh:mm): a bare local time would be read in the server's zone.
      if (Number.isNaN(t) || !/(Z|[+-]\d{2}:?\d{2})$/i.test(byRaw)) problems.push("I couldn't read that deadline. Could you give a date and time?");
      else if (t - ctx.now < 10 * 60_000) problems.push("That deadline is too soon or already past. It needs to be at least 10 minutes from now.");
      else if (t - ctx.now > MAX_ORDER_DAYS * 86_400_000) problems.push(`I can wait at most ${MAX_ORDER_DAYS} days for a price.`);
      else order = { dropPct: drop, deadline: new Date(t).toISOString() };
    }
  } else if (byRaw) {
    problems.push("I can wait for a price drop by a deadline, but I can't send a gift at a set time yet. Do you want to add a price drop, like 0.5%?");
  }

  if (problems.length || !stock || !Number.isFinite(usd)) return { ok: false, problems: problems.length ? problems : ["I couldn't make sense of that."] };
  return { ok: true, draft: { ticker: stock.ticker, companyName: stock.name, usd, recipientName, message, returnAs, ...(order ? { order } : {}) } };
}
