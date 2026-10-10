import { describe, expect, it } from "vitest";
import { decideOrder } from "./order.js";
import type { GiftOrder } from "../gifts/ledger.js";
import { triggerPrice } from "../gifts/ledger.js";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const order = (over: Partial<GiftOrder> = {}): GiftOrder => ({
  dropPct: 0.52,
  baseline: 230,
  trigger: triggerPrice(230, 0.52),
  deadline: new Date(NOW + 3_600_000),
  text: null,
  triggeredAt: null,
  lastPrice: null,
  checkedAt: null,
  ...over,
});

describe("triggerPrice", () => {
  it("is the baseline minus the drop, to 6 places", () => {
    expect(triggerPrice(230, 0.52)).toBe(228.804);
    expect(triggerPrice(100, 10)).toBe(90);
    expect(triggerPrice(239.87, 0.52)).toBe(238.622676);
  });
});

describe("decideOrder", () => {
  it("waits while the price is above the trigger", () => {
    expect(decideOrder(order(), 229.5, NOW)).toMatchObject({ action: "wait", reason: expect.stringContaining("$228.80") });
  });
  it("buys at exactly the trigger and below it", () => {
    expect(decideOrder(order(), 228.804, NOW)).toEqual({ action: "buy", why: "price reached" });
    expect(decideOrder(order(), 200, NOW)).toEqual({ action: "buy", why: "price reached" });
  });
  it("refunds once the deadline passes without the condition being met, even if the price is low by then", () => {
    expect(decideOrder(order(), 229.5, NOW + 3_600_000)).toMatchObject({ action: "expire" });
    expect(decideOrder(order(), 200, NOW + 3_600_001)).toMatchObject({ action: "expire" });
  });
  it("once triggered it is a normal buy, whatever the price or the clock", () => {
    const o = order({ triggeredAt: new Date(NOW - 1000) });
    expect(decideOrder(o, 250, NOW + 10 * 3_600_000)).toEqual({ action: "buy", why: "already triggered" });
  });
  it("waits when the price can't be read, but still refunds at the deadline", () => {
    expect(decideOrder(order(), null, NOW)).toMatchObject({ action: "wait", reason: expect.stringContaining("can't be read") });
    expect(decideOrder(order(), null, NOW + 4_000_000)).toMatchObject({ action: "expire" });
  });
});
