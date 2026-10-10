// Creating and reading conditional orders (TEST_DATABASE_URL, schema test_orders wiped). Skipped if unset.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/pool.js";
import { freshTestDb } from "../db/testDb.js";
import { createGift, getGift, triggerPrice, type NewGift } from "./ledger.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("conditional orders (Postgres)", () => {
  let db: Db;
  beforeAll(async () => {
    db = await freshTestDb(url!, "test_orders");
  });
  afterAll(async () => {
    await db?.end();
  });

  const base = (order?: NewGift["order"]): NewGift => ({
    senderAddress: "0x5e78822d6326360c51d746E164d878210E0FEbff",
    senderName: "Paul",
    recipientName: "Ada",
    ticker: "NVDA",
    issuer: "bstock",
    tokenAddress: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436",
    tokenDecimals: 18,
    quotedTokenAmount: 10n ** 16n,
    usdCost: 5,
    feeUsd: 0.1,
    paymentExpiresAt: new Date(Date.now() + 300_000),
    order,
  });
  const caps = { maxGiftUsd: 20, dailyCapUsd: 1e9 };
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000);

  it("stores the order with its trigger price", async () => {
    const { gift } = await createGift(db, base({ dropPct: 0.52, baseline: 239.87, deadline: inHours(24), text: "Buy NVDA by 2PM tomorrow if it drops 0.52%" }), caps);
    const g = (await getGift(db, gift.id))!;
    expect(g.order).toMatchObject({ dropPct: 0.52, baseline: 239.87, trigger: triggerPrice(239.87, 0.52), triggeredAt: null, lastPrice: null, text: "Buy NVDA by 2PM tomorrow if it drops 0.52%" });
    expect(g.order!.deadline.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });

  it("an ordinary gift has no order", async () => {
    const { gift } = await createGift(db, base(), caps);
    expect((await getGift(db, gift.id))!.order).toBeNull();
  });

  it("rejects drops outside 0–50%, past or too-near deadlines, and deadlines beyond 7 days", async () => {
    const bad = (o: NewGift["order"]) => createGift(db, base(o), caps);
    await expect(bad({ dropPct: 0, baseline: 230, deadline: inHours(2) })).rejects.toThrow(/price drop/);
    await expect(bad({ dropPct: 51, baseline: 230, deadline: inHours(2) })).rejects.toThrow(/price drop/);
    await expect(bad({ dropPct: 1, baseline: 230, deadline: inHours(-1) })).rejects.toThrow(/5 minutes/);
    await expect(bad({ dropPct: 1, baseline: 230, deadline: new Date(Date.now() + 60_000) })).rejects.toThrow(/5 minutes/);
    await expect(bad({ dropPct: 1, baseline: 230, deadline: inHours(24 * 8) })).rejects.toThrow(/7 days/);
    await expect(bad({ dropPct: 1, baseline: 0, deadline: inHours(2) })).rejects.toThrow(/starting price/);
  });

  it("the database refuses a half-filled order", async () => {
    const { gift } = await createGift(db, base(), caps);
    await expect(db.query("UPDATE gifts SET order_drop_pct = 1 WHERE id = $1", [gift.id])).rejects.toThrow(/order_is_complete/);
  });
});
