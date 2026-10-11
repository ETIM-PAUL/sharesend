// The chat assistant only ever proposes a draft. This turns whatever the model produced into a validated draft the
// send form can show, or a list of plain-language problems. Nothing here (or in the model) can spend money.
import { MAX_ORDER_DAYS, MAX_ORDER_DROP_PCT } from "../gifts/ledger.js";
import { MAX_GROUP_DAYS, MIN_GROUP_MINUTES } from "../gifts/groups.js";

export interface Draft {
  ticker: string;
  companyName: string;
  /** The gift amount. 0 for a group gift: friends decide what they chip in. */
  usd: number;
  recipientName: string;
  message: string;
  returnAs: "stock" | "usdt";
  /** Present when the gift should only be bought after a price drop. */
  order?: { dropPct: number; deadline: string };
  /** Present for a group gift: friends chip in for `minutes`, then one gift is bought with everything raised. */
  group?: { minutes: number };
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

  // A group gift has no amount up front: everyone chips in what they like, up to the cap in total.
  const isGroup = r.group_gift === true;
  let group: Draft["group"];
  if (isGroup) {
    // collect_minutes wins; collect_days is accepted too; 3 days if neither is given.
    const raw = r.collect_minutes ?? (typeof r.collect_days === "number" ? r.collect_days * 1440 : 3 * 1440);
    const minutes = typeof raw === "number" ? Math.round(raw) : NaN;
    if (!Number.isFinite(minutes) || minutes <= 0) problems.push(`How long should friends have to chip in? From ${MIN_GROUP_MINUTES} minutes to ${MAX_GROUP_DAYS} days.`);
    else if (minutes < MIN_GROUP_MINUTES) problems.push(`A group gift has to stay open for at least ${MIN_GROUP_MINUTES} minutes. Shall I make it ${MIN_GROUP_MINUTES}?`);
    else if (minutes > MAX_GROUP_DAYS * 1440) problems.push(`A group gift can collect for at most ${MAX_GROUP_DAYS} days. Shall I make it ${MAX_GROUP_DAYS}?`);
    else group = { minutes };
    if (r.buy_when_price_drops_pct !== undefined && r.buy_when_price_drops_pct !== null) problems.push("A group gift is bought when it closes, so it can't also wait for a price drop. Which would you like?");
  }

  const usd = isGroup ? 0 : typeof r.usd === "number" ? Math.round(r.usd * 100) / 100 : NaN;
  if (isGroup) {
    // no amount
  } else if (!Number.isFinite(usd)) problems.push("How many dollars?");
  else if (usd < 1) problems.push("The smallest gift is $1.");
  else if (usd > ctx.maxGiftUsd) problems.push(`Gifts are limited to ${money(ctx.maxGiftUsd)} each.`);

  const recipientName = str(r.recipient_name, 60);
  if (!recipientName) problems.push("Who is it for?");
  const message = str(r.message, 280);
  const returnAs = r.return_as === "usdt" ? "usdt" : "stock";

  let order: Draft["order"];
  const dropRaw = isGroup ? undefined : r.buy_when_price_drops_pct;
  const byRaw = isGroup ? "" : str(r.buy_by, 40);
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
  return { ok: true, draft: { ticker: stock.ticker, companyName: stock.name, usd, recipientName, message, returnAs, ...(order ? { order } : {}), ...(group ? { group } : {}) } };
}

/** "5 minutes", "2 hours", "3 days" */
export function duration(minutes: number): string {
  const [n, unit] = minutes % 1440 === 0 ? [minutes / 1440, "day"] : minutes % 60 === 0 ? [minutes / 60, "hour"] : [minutes, "minute"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}
