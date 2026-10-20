// Group gifts: friends chip in, then one gift is bought for the recipient.
//   POST /groups                      {ticker, organizerAddress, organizerName, recipientName, message?, closesAt}
//   GET  /groups/:id                  the group, what's been raised and who chipped in (names and notes only)
//   POST /groups/:id/contributions    {usd, senderAddress, senderName, note?} → 402, paid like any gift (/gifts/:id/pay)
//   POST /groups/:id/close            {message, signature} by the organizer → one gift is bought; claim link returned once
//   POST /groups/:id/cancel           {message, signature} by the organizer → everyone who paid is refunded
import { Hono, type Context } from "hono";
import { config } from "../config.js";
import { getDb } from "../db/pool.js";
import { cancelGroup, closeGroup, committedUsd, createGroup, getGroup, groupContributors, verifyOrganizer, type Group, type GroupAction } from "../gifts/groups.js";
import { dailyUsedUsd, getGift } from "../gifts/ledger.js";
import { publicClient } from "../chain/bsc.js";
import { claimLink } from "../gifts/codes.js";
import { advanceInBackground } from "../execution/advance.js";
import { openGift, poolQuote } from "../payments/openGift.js";
import { BinanceError } from "../binance/errors.js";
import { respond402 } from "./gifts.js";

export const groupRoutes = new Hono();

const hits = new Map<string, number[]>();
function limited(ip: string, max = 20, windowMs = 60_000): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 10_000) hits.clear();
  return recent.length > max;
}
const clientIp = (c: Context) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";

function dbOr503() {
  try {
    return getDb();
  } catch {
    return null;
  }
}

function origin(c: Context): string {
  const u = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto") ?? u.protocol.replace(":", "");
  return `${proto}://${c.req.header("x-forwarded-host") ?? u.host}`;
}

async function publicGroup(db: ReturnType<typeof getDb>, g: Group) {
  const [contributors, committed, pool] = await Promise.all([
    groupContributors(db, g.id),
    committedUsd(db, g.id),
    g.pooledGiftId ? getGift(db, g.pooledGiftId) : Promise.resolve(null),
  ]);
  const raised = Math.round(contributors.reduce((s, x) => s + x.usd, 0) * 100) / 100;
  return {
    id: g.id,
    status: g.status,
    // A group whose closing time has passed is shown as closing until the job pools or cancels it.
    closing: g.status === "OPEN" && g.closesAt.getTime() <= Date.now(),
    organizerName: g.organizerName,
    organizerAddress: g.organizerAddress,
    recipientName: g.recipientName,
    message: g.message,
    ticker: g.ticker,
    companyName: g.companyName,
    closesAt: g.closesAt,
    createdAt: g.createdAt,
    raisedUsd: raised,
    maxUsd: config.maxGiftUsd,
    roomUsd: Math.max(0, Math.round((config.maxGiftUsd - committed) * 100) / 100),
    contributors: contributors.map((x) => ({ name: x.name, note: x.note, usd: x.usd, at: x.at })),
    pooledGift: pool ? { id: pool.id, status: pool.status, usd: pool.usdCost } : null,
    // The recipient's one-time thank-you to everyone who chipped in, once they've left it.
    thanks: pool?.thanksNote ? { note: pool.thanksNote, at: pool.thankedAt } : null,
    closeReason: g.closeReason,
    dryRun: g.dryRun,
  };
}

groupRoutes.post("/groups", async (c) => {
  if (limited(clientIp(c), 10)) return c.json({ ok: false, error: "too many requests" }, 429);
  const db = dbOr503();
  if (!db) return c.json({ ok: false, error: "database not configured" }, 503);
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return c.json({ ok: false, error: "JSON body required" }, 400);
  const closesAt = typeof b.closesAt === "string" ? new Date(b.closesAt) : new Date(NaN);
  if (Number.isNaN(closesAt.getTime())) return c.json({ ok: false, error: "closesAt must be a date and time" }, 400);
  // The stock must be giftable now: a $1 price check catches unknown tickers early, and names the company.
  let companyName: string | undefined;
  try {
    const probe = await poolQuote(String(b.ticker ?? ""), 1);
    if (!probe.ok) return c.json({ ok: false, error: probe.message }, 422);
    companyName = probe.name;
  } catch (e) {
    if (e instanceof BinanceError) return c.json({ ok: false, error: `Binance: ${e.message}` }, 502);
    throw e;
  }
  try {
    const g = await createGroup(db, {
      ticker: String(b.ticker ?? ""),
      organizerAddress: String(b.organizerAddress ?? ""),
      organizerName: String(b.organizerName ?? ""),
      recipientName: String(b.recipientName ?? ""),
      message: typeof b.message === "string" ? b.message : "",
      closesAt,
      dryRun: !config.liveTrading,
      companyName,
    });
    return c.json({ ok: true, group: await publicGroup(db, g) }, 201);
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400);
  }
});

groupRoutes.get("/groups/:id", async (c) => {
  const db = dbOr503();
  if (!db) return c.json({ ok: false, error: "database not configured" }, 503);
  const g = await getGroup(db, c.req.param("id"));
  if (!g) return c.json({ ok: false, error: "group not found" }, 404);
  return c.json({ ok: true, group: await publicGroup(db, g) });
});

groupRoutes.post("/groups/:id/contributions", async (c) => {
  if (limited(clientIp(c), 10)) return c.json({ ok: false, error: "too many requests" }, 429);
  const db = dbOr503();
  if (!db) return c.json({ ok: false, error: "database not configured" }, 503);
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return c.json({ ok: false, error: "JSON body required" }, 400);
  try {
    const r = await openGift(
      db,
      {
        groupId: c.req.param("id"),
        ticker: "",
        usd: typeof b.usd === "number" ? b.usd : NaN,
        senderAddress: String(b.senderAddress ?? ""),
        senderName: String(b.senderName ?? ""),
        recipientName: "",
        message: typeof b.note === "string" ? b.note : "",
      },
      await dailyUsedUsd(db),
    );
    if (!r.ok) return c.json({ ok: false, code: r.code, error: r.message }, r.status);
    return respond402(c, r.gift, undefined, { quote: { giftUsd: r.quote.giftUsd, feeUsd: r.quote.feeUsd, totalUsd: r.quote.totalUsd } });
  } catch (e) {
    if (e instanceof BinanceError) return c.json({ ok: false, error: `Binance: ${e.message}` }, 502);
    throw e;
  }
});

const verifyWithChain = (address: string, message: string, signature: string) =>
  publicClient().verifyMessage({ address: address as `0x${string}`, message, signature: signature as `0x${string}` });

async function organizerAction(c: Context, action: GroupAction) {
  if (limited(clientIp(c), 10)) return { res: c.json({ ok: false, error: "too many requests" }, 429) };
  const db = dbOr503();
  if (!db) return { res: c.json({ ok: false, error: "database not configured" }, 503) };
  const g = await getGroup(db, c.req.param("id")!);
  if (!g) return { res: c.json({ ok: false, error: "group not found" }, 404) };
  const b = (await c.req.json().catch(() => null)) as { message?: unknown; signature?: unknown } | null;
  const auth = await verifyOrganizer(db, g, action, b?.message, b?.signature, verifyWithChain);
  if (!auth.ok) return { res: c.json({ ok: false, error: auth.error }, 401) };
  return { db, g };
}

groupRoutes.post("/groups/:id/close", async (c) => {
  const a = await organizerAction(c, "close");
  if ("res" in a) return a.res;
  try {
    const r = await closeGroup(a.db, a.g.id, poolQuote);
    if (!r.ok) return c.json({ ok: false, error: r.error }, r.status);
    if (r.outcome === "cancelled") {
      for (const id of r.refunding) advanceInBackground(a.db, id);
      return c.json({ ok: true, group: await publicGroup(a.db, r.group), claimUrl: null });
    }
    if (process.env.AUTO_EXECUTE === "true") advanceInBackground(a.db, r.gift.id);
    return c.json({
      ok: true,
      group: await publicGroup(a.db, r.group),
      // Shown once. The organizer shares it with the recipient; a new one can be made from the gift's page.
      claimUrl: claimLink(process.env.CLAIM_BASE_URL ?? origin(c), r.gift.id, r.claimCode),
    });
  } catch (e) {
    if (e instanceof BinanceError) return c.json({ ok: false, error: `Binance: ${e.message}` }, 502);
    throw e;
  }
});

groupRoutes.post("/groups/:id/cancel", async (c) => {
  const a = await organizerAction(c, "cancel");
  if ("res" in a) return a.res;
  const r = await cancelGroup(a.db, a.g.id);
  if (!r.ok) return c.json({ ok: false, error: r.error }, r.status);
  for (const id of r.refunding) advanceInBackground(a.db, id);
  return c.json({ ok: true, group: await publicGroup(a.db, r.group) });
});
