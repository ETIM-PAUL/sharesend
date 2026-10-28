// Baskets (several stocks, one payment, one claim link) against Postgres (TEST_DATABASE_URL, schema test_baskets wiped).
// Only the price quote and the list of payment assets are faked; the ledger, payment, claim and cancel code is real.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Db } from "../db/pool.js";
import { freshTestDb } from "../db/testDb.js";
import { cancelBasket } from "../execution/cancel.js";
import {
  advanceStep,
  basketMembers,
  basketStatus,
  beginBasketClaim,
  beginClaim,
  completeClaim,
  createGift,
  getGift,
  leaveThanks,
  reissueClaimCode,
  transition,
  type Gift,
} from "../gifts/ledger.js";
import { buildJobs } from "../jobs/jobs.js";
import { buildAccepts, draftAuthorization, eip3009TypedData, permit2ExactTypedData } from "./x402.js";
import { payForGift, type FundsCheck, type PayDeps } from "./pay.js";
import { MAX_BASKET_STOCKS, openBasket } from "./openBasket.js";
import type { Facilitator, PaymentPayload, PaymentRequirements } from "./b402.js";
import { ASSETS } from "./fixtures.js";

vi.mock("../pricing/quote.js", () => ({ quoteGift: vi.fn() }));
vi.mock("./b402.js", async (orig) => ({ ...(await orig<typeof import("./b402.js")>()), payAssets: vi.fn(async () => (await import("./fixtures.js")).ASSETS) }));
import { quoteGift } from "../pricing/quote.js";

const url = process.env.TEST_DATABASE_URL;
const VAULT = "0xF72ae96cB04c5A8036617474d13eED8610ff260C";
const caps = { maxGiftUsd: 20, dailyCapUsd: 1e9 };
const TICKERS = ["NVDA", "AAPL", "TSLA", "SPY", "QQQ"];
const tokenOf = (t: string) => `0x${Buffer.from(t.padEnd(20, "_")).toString("hex")}`;
const ip = () => `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
const addr = () => `0x${randomUUID().replace(/-/g, "")}${"0".repeat(8)}`;

function fakeQuote(ticker: string, usd: number) {
  return {
    ok: true as const,
    quote: {
      ticker,
      name: `${ticker} Corp`,
      issuer: "bstock",
      issuerLabel: "bStocks",
      tokenSymbol: `${ticker}B`,
      tokenAddress: tokenOf(ticker),
      tokenDecimals: 18,
      tokenAmountRaw: "10000000000000000",
      tokenAmount: 0.01,
      sharesOut: 0.01,
      pricePerShare: 100,
      referencePrice: 100,
      premiumPct: 0,
      giftUsd: usd,
      feeUsd: 0.1,
      totalUsd: Math.round((usd + 0.1) * 100) / 100,
      quoteId: `q-${ticker}`,
      reason: "cheapest",
      warnings: [],
      market: { open: true, nextOpenTime: null },
      quotedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    },
  };
}

class FakeFacilitator implements Facilitator {
  settles = 0;
  settled = new Map<string, string>();
  async verify() {
    return { isValid: true };
  }
  async settle(p: PaymentPayload) {
    this.settles++;
    const key = JSON.stringify(p.payload);
    if (!this.settled.has(key)) this.settled.set(key, `0x${randomBytes(32).toString("hex")}`);
    return { success: true, transaction: this.settled.get(key)!, network: "eip155:56" };
  }
}
const funds: FundsCheck = { check: async (_a, _p, method) => ({ balance: 10n ** 30n, allowance: method.startsWith("permit2") ? 10n ** 30n : null }) };

describe.skipIf(!url)("baskets (Postgres + fake B402)", () => {
  let db: Db;
  let fac: FakeFacilitator;
  let live: PayDeps;
  let dry: PayDeps;

  beforeAll(async () => {
    process.env.VAULT_ADDRESS = VAULT;
    db = await freshTestDb(url!, "test_baskets");
  });
  afterAll(async () => {
    await db?.end();
  });
  beforeEach(() => {
    fac = new FakeFacilitator();
    live = { db, facilitator: fac, funds, liveTrading: true };
    dry = { db, facilitator: fac, funds, liveTrading: false };
    vi.mocked(quoteGift).mockReset();
    vi.mocked(quoteGift).mockImplementation(async (ticker: string, usd: number) => fakeQuote(ticker.toUpperCase(), usd) as never);
  });

  /** A basket built the way openBasket builds one, without going through pricing. */
  async function basket(n = 3, opts: { dryRun?: boolean; usd?: number } = {}) {
    const leadId = randomUUID();
    const sender = privateKeyToAccount(generatePrivateKey());
    const usd = opts.usd ?? 5;
    const accepts = buildAccepts(ASSETS, Math.round(n * (usd + 0.1) * 100) / 100, VAULT);
    const gifts: Gift[] = [];
    for (let i = 0; i < n; i++) {
      const { gift } = await createGift(
        db,
        {
          id: i === 0 ? leadId : undefined,
          basketId: leadId,
          senderAddress: sender.address,
          senderName: "Paul",
          recipientName: "Ada",
          ticker: TICKERS[i]!,
          issuer: "bstock",
          tokenAddress: tokenOf(TICKERS[i]!),
          tokenDecimals: 18,
          quotedTokenAmount: 10n ** 16n,
          usdCost: usd,
          feeUsd: 0.1,
          paymentExpiresAt: new Date(Date.now() + 300_000 + (i ? 120_000 : 0)),
          dryRun: opts.dryRun ?? false,
          paymentRequirements: i === 0 ? accepts : undefined,
        },
        caps,
      );
      gifts.push(gift);
    }
    return { leadId, gifts, sender, accepts };
  }

  async function sign(sender: ReturnType<typeof privateKeyToAccount>, r: PaymentRequirements): Promise<PaymentPayload> {
    const dr = draftAuthorization(r, sender.address, Math.floor(Date.now() / 1000), randomBytes(32));
    const payload =
      dr.method === "eip3009"
        ? { signature: await sender.signTypedData(eip3009TypedData(r, dr.authorization)), authorization: dr.authorization }
        : { signature: await sender.signTypedData(permit2ExactTypedData(dr.permit2Authorization)), permit2Authorization: dr.permit2Authorization };
    return { x402Version: 2, accepted: r, payload };
  }

  async function payBasket(b: Awaited<ReturnType<typeof basket>>, deps = live) {
    const r = await payForGift(deps, b.leadId, await sign(b.sender, b.accepts[0]!));
    if (!r.ok) throw new Error(r.error);
    return r;
  }

  /** PAID → BUYING → READY, as the buy step would leave it. */
  async function makeReady(id: string) {
    await transition(db, id, "PAID", "BUYING");
    await advanceStep(db, id, null, "forwarded", { forwardTx: "0xf" });
    await advanceStep(db, id, "forwarded", "swapped", { buyTx: "0xb" });
    await advanceStep(db, id, "swapped", "in_vault", { vaultTx: "0xv", tokenAmount: 10n ** 16n });
    return transition(db, id, "BUYING", "READY");
  }

  const statuses = async (leadId: string) => (await basketMembers(db, leadId)).map((m) => m.status);

  describe("opening", () => {
    it("rejects a basket that is too small, too big, repeated, under $1 or over the total limit, and creates nothing", async () => {
      const before = Number((await db.query("SELECT count(*) AS n FROM gifts")).rows[0].n);
      const base = { senderAddress: privateKeyToAccount(generatePrivateKey()).address, senderName: "Paul", recipientName: "Ada" };
      const item = (ticker: string, usd = 2) => ({ ticker, usd });
      const cases: [string, unknown][] = [
        ["one stock", [item("NVDA")]],
        ["too many", TICKERS.concat("MSFT").map((t) => item(t))],
        ["the same stock twice", [item("NVDA"), item("nvda")]],
        ["under $1", [item("NVDA"), item("AAPL", 0.5)]],
        ["not a number", [item("NVDA"), { ticker: "AAPL", usd: "5" }]],
        ["over the total limit", [item("NVDA", 11), item("AAPL", 10)]],
        ["a bad ticker", [item("NVDA"), item("A$PL")]],
      ];
      expect(MAX_BASKET_STOCKS).toBe(5);
      for (const [name, items] of cases) {
        const r = await openBasket(db, { ...base, items } as never, 0);
        expect(r.ok, name).toBe(false);
        if (!r.ok) expect(r.code, name).toBe("BAD_INPUT");
      }
      expect((await openBasket(db, { ...base, senderAddress: "nope", items: [item("NVDA"), item("AAPL")] }, 0)).ok).toBe(false);
      expect(Number((await db.query("SELECT count(*) AS n FROM gifts")).rows[0].n)).toBe(before);
    });

    it("creates one gift per stock: the lead holds the whole payment, the rest wait and expire after it", async () => {
      const r = await openBasket(db, { senderAddress: privateKeyToAccount(generatePrivateKey()).address, senderName: "Paul", recipientName: "Ada", items: [{ ticker: "nvda", usd: 5 }, { ticker: "AAPL", usd: 3 }, { ticker: "TSLA", usd: 2 }] }, 0);
      if (!r.ok) throw new Error(r.message);
      expect(r.totalUsd).toBe(10.3);
      const members = await basketMembers(db, r.gift.id);
      expect(members.map((m) => m.ticker)).toEqual(["NVDA", "AAPL", "TSLA"]);
      expect(members.every((m) => m.basketId === r.gift.id && m.status === "AWAITING_PAYMENT")).toBe(true);
      expect(members[0]!.id).toBe(r.gift.id);
      expect(members.map((m) => m.usdCost)).toEqual([5, 3, 2]);
      // One payment for everything: $10.30 in the lead's requirements, none on the others.
      const want = buildAccepts(ASSETS, 10.3, VAULT);
      expect((members[0]!.paymentRequirements as PaymentRequirements[]).map((a) => a.amount)).toEqual(want.map((a) => a.amount));
      expect(members.slice(1).every((m) => m.paymentRequirements === null)).toBe(true);
      expect(members[1]!.paymentExpiresAt.getTime()).toBeGreaterThan(members[0]!.paymentExpiresAt.getTime());
    });

    it("leaves nothing payable behind when pricing one stock fails", async () => {
      vi.mocked(quoteGift).mockImplementation(async (ticker: string, usd: number) => (ticker.toUpperCase() === "AAPL" ? ({ ok: false, code: "NO_TOKEN", message: "no token" } as never) : (fakeQuote(ticker.toUpperCase(), usd) as never)));
      const before = Number((await db.query("SELECT count(*) AS n FROM gifts")).rows[0].n);
      const r = await openBasket(db, { senderAddress: privateKeyToAccount(generatePrivateKey()).address, senderName: "Paul", recipientName: "Ada", items: [{ ticker: "NVDA", usd: 5 }, { ticker: "AAPL", usd: 5 }] }, 0);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/AAPL/);
      expect(Number((await db.query("SELECT count(*) AS n FROM gifts")).rows[0].n)).toBe(before);
    });
  });

  describe("paying", () => {
    it("one signature settles once and marks every stock paid, with one claim code and a fee for each", async () => {
      const b = await basket(3);
      const r = await payBasket(b);
      expect(fac.settles).toBe(1);
      expect(await statuses(b.leadId)).toEqual(["PAID", "PAID", "PAID"]);
      const members = await basketMembers(db, b.leadId);
      expect(new Set(members.map((m) => m.paymentTx)).size).toBe(1);
      expect(members[0]!.paymentTx).toBe(r.settleTx);
      expect(Number((await db.query("SELECT count(*) AS n FROM payments WHERE gift_id = ANY($1)", [members.map((m) => m.id)])).rows[0].n)).toBe(1);
      const fees = (await db.query("SELECT gift_id, tx FROM agent_ledger WHERE kind = 'fee_income' AND gift_id = ANY($1)", [members.map((m) => m.id)])).rows;
      expect(fees).toHaveLength(3);
      expect(new Set(fees.map((f) => f.tx)).size).toBe(3);
      // The code is given once, for the lead, and opens the whole basket.
      expect(r.claimCode).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(members[0]!.claimCodeIssued).toBe(true);
      for (const m of members) await makeReady(m.id);
      const claim = await beginBasketClaim(db, { giftId: b.leadId, code: r.claimCode!, claimAddress: addr(), ip: ip() });
      expect(claim.ok).toBe(true);
    });

    it("works the same in a dry run", async () => {
      const b = await basket(2, { dryRun: true });
      const r = await payBasket(b, dry);
      expect(await statuses(b.leadId)).toEqual(["PAID", "PAID"]);
      expect(r.claimCode).toBeTruthy();
      expect(fac.settles).toBe(0);
    });

    it("a repeated payment is a no-op and gives no second code", async () => {
      const b = await basket(2);
      const p = await sign(b.sender, b.accepts[0]!);
      const first = await payForGift(live, b.leadId, p);
      const again = await payForGift(live, b.leadId, p);
      expect(first.ok && again.ok).toBe(true);
      if (first.ok && again.ok) {
        expect(again.alreadyPaid).toBe(true);
        expect(again.claimCode).toBeNull();
      }
      expect(fac.settles).toBe(1);
    });

    it("the unpaid-gift job leaves a basket's other stocks alone while the lead's payment exists", async () => {
      const b = await basket(3);
      await db.query("UPDATE gifts SET payment_expires_at = now() - interval '10 minutes' WHERE basket_id = $1", [b.leadId]);
      await db.query("INSERT INTO payments (gift_id, payload_hash, payer, asset, method, amount, status) VALUES ($1, 'h', $2, 'a', 'eip3009', '1', 'settling')", [b.leadId, b.gifts[0]!.senderAddress]);
      const job = buildJobs({ advance: async () => ({ status: "NOOP", gift: b.gifts[0]! }) as never }).find((j) => j.name === "expire-unpaid")!;
      await job.run(db);
      expect(await statuses(b.leadId)).toEqual(["AWAITING_PAYMENT", "AWAITING_PAYMENT", "AWAITING_PAYMENT"]);
      await db.query("DELETE FROM payments WHERE gift_id = $1", [b.leadId]);
      await job.run(db);
      expect(await statuses(b.leadId)).toEqual(["EXPIRED", "EXPIRED", "EXPIRED"]);
    });
  });

  describe("claiming", () => {
    async function paidReady(n = 3) {
      const b = await basket(n);
      const r = await payBasket(b);
      for (const g of b.gifts) await makeReady(g.id);
      return { ...b, code: r.claimCode! };
    }

    it("claims every stock to one address, all at once", async () => {
      const b = await paidReady(3);
      const to = addr();
      const r = await beginBasketClaim(db, { giftId: b.leadId, code: b.code, claimAddress: to, ip: ip() });
      if (!r.ok) throw new Error(r.reason);
      expect(r.gifts).toHaveLength(3);
      const members = await basketMembers(db, b.leadId);
      expect(members.map((m) => m.status)).toEqual(["CLAIMING", "CLAIMING", "CLAIMING"]);
      expect(members.every((m) => m.claimAddress!.toLowerCase() === to.toLowerCase())).toBe(true);
      for (const m of members) await completeClaim(db, m.id, "0xclaim");
      expect(basketStatus(await basketMembers(db, b.leadId))).toBe("CLAIMED");
    });

    it("only the lead's id opens the basket: another stock's id with the same code does not", async () => {
      const b = await paidReady(3);
      const other = b.gifts[1]!.id;
      expect(await beginClaim(db, { giftId: other, code: b.code, claimAddress: addr(), ip: ip() })).toEqual({ ok: false, reason: "INVALID" });
      expect(await beginBasketClaim(db, { giftId: other, code: b.code, claimAddress: addr(), ip: ip() })).toEqual({ ok: false, reason: "INVALID" });
      expect(await statuses(b.leadId)).toEqual(["READY", "READY", "READY"]);
    });

    it("a wrong code, a bad address or one of the stock tokens as the address claims nothing", async () => {
      const b = await paidReady(2);
      expect(await beginBasketClaim(db, { giftId: b.leadId, code: "x".repeat(22), claimAddress: addr(), ip: ip() })).toEqual({ ok: false, reason: "INVALID" });
      expect(await beginBasketClaim(db, { giftId: b.leadId, code: b.code, claimAddress: "0x123", ip: ip() })).toEqual({ ok: false, reason: "BAD_ADDRESS" });
      expect(await beginBasketClaim(db, { giftId: b.leadId, code: b.code, claimAddress: tokenOf("AAPL"), ip: ip() })).toEqual({ ok: false, reason: "BAD_ADDRESS" });
      expect(await beginBasketClaim(db, { giftId: b.leadId, code: b.code, claimAddress: VAULT, ip: ip(), forbiddenAddresses: [VAULT] })).toEqual({ ok: false, reason: "BAD_ADDRESS" });
      expect(await statuses(b.leadId)).toEqual(["READY", "READY"]);
    });

    it("waits (and claims nothing) while any stock is still being bought", async () => {
      const b = await basket(3);
      const r = await payBasket(b);
      await makeReady(b.gifts[0]!.id);
      await makeReady(b.gifts[1]!.id);
      const res = await beginBasketClaim(db, { giftId: b.leadId, code: r.claimCode!, claimAddress: addr(), ip: ip() });
      expect(res).toEqual({ ok: false, reason: "NOT_READY" });
      expect(await statuses(b.leadId)).toEqual(["READY", "READY", "PAID"]);
    });

    it("leaves out a stock that was refunded and claims the rest", async () => {
      const b = await basket(3);
      const r = await payBasket(b);
      await makeReady(b.gifts[0]!.id);
      await makeReady(b.gifts[1]!.id);
      await transition(db, b.gifts[2]!.id, "PAID", "BUYING");
      await transition(db, b.gifts[2]!.id, "BUYING", "FAILED", { failureReason: "no liquidity" });
      expect(basketStatus(await basketMembers(db, b.leadId))).toBe("READY");
      const res = await beginBasketClaim(db, { giftId: b.leadId, code: r.claimCode!, claimAddress: addr(), ip: ip() });
      if (!res.ok) throw new Error(res.reason);
      expect(res.gifts.map((g) => g.ticker)).toEqual(["NVDA", "AAPL"]);
      expect((await getGift(db, b.gifts[2]!.id))!.status).toBe("FAILED");
    });

    it("of many simultaneous claims, exactly one wins and every stock follows it", async () => {
      const b = await paidReady(3);
      const results = await Promise.all(Array.from({ length: 12 }, () => beginBasketClaim(db, { giftId: b.leadId, code: b.code, claimAddress: addr(), ip: ip() })));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const members = await basketMembers(db, b.leadId);
      expect(members.map((m) => m.status)).toEqual(["CLAIMING", "CLAIMING", "CLAIMING"]);
      expect(new Set(members.map((m) => m.claimAddress)).size).toBe(1);
    });

    it("an expired claim window blocks the whole basket", async () => {
      const b = await paidReady(2);
      await db.query("UPDATE gifts SET claim_expires_at = now() - interval '1 hour' WHERE basket_id = $1", [b.leadId]);
      expect(await beginBasketClaim(db, { giftId: b.leadId, code: b.code, claimAddress: addr(), ip: ip() })).toEqual({ ok: false, reason: "EXPIRED" });
      expect(await statuses(b.leadId)).toEqual(["READY", "READY"]);
    });
  });

  describe("sender actions", () => {
    it("a new claim link replaces the code for the whole basket", async () => {
      const b = await basket(3);
      const r = await payBasket(b);
      for (const g of b.gifts) await makeReady(g.id);
      const fresh = await reissueClaimCode(db, b.leadId);
      expect(fresh).toBeTruthy();
      expect(await beginBasketClaim(db, { giftId: b.leadId, code: r.claimCode!, claimAddress: addr(), ip: ip() })).toEqual({ ok: false, reason: "INVALID" });
      expect((await beginBasketClaim(db, { giftId: b.leadId, code: fresh!, claimAddress: addr(), ip: ip() })).ok).toBe(true);
    });

    it("cancelling before payment expires every stock", async () => {
      const b = await basket(3);
      const r = await cancelBasket(db, b.leadId, () => {});
      expect(r.ok).toBe(true);
      expect(await statuses(b.leadId)).toEqual(["EXPIRED", "EXPIRED", "EXPIRED"]);
    });

    it("cancelling after payment refunds every stock; a ready basket goes back to the sender", async () => {
      const paid = await basket(2);
      await payBasket(paid);
      expect((await cancelBasket(db, paid.leadId, () => {})).ok).toBe(true);
      expect(await statuses(paid.leadId)).toEqual(["REFUNDING", "REFUNDING"]);

      const ready = await basket(2);
      await payBasket(ready);
      for (const g of ready.gifts) await makeReady(g.id);
      const r = await cancelBasket(db, ready.leadId, () => {}, "usdt");
      expect(r.ok).toBe(true);
      const members = await basketMembers(db, ready.leadId);
      expect(members.map((m) => m.status)).toEqual(["RETURNING", "RETURNING"]);
      expect(members.every((m) => m.returnAs === "usdt")).toBe(true);
    });

    it("a stock that is being bought is skipped and named; the others are still cancelled", async () => {
      const b = await basket(3);
      await payBasket(b);
      await transition(db, b.gifts[1]!.id, "PAID", "BUYING");
      const r = await cancelBasket(db, b.leadId, () => {});
      expect(r.ok).toBe(true);
      expect(r.ok && r.skipped).toEqual(["AAPL"]);
      expect(await statuses(b.leadId)).toEqual(["REFUNDING", "BUYING", "REFUNDING"]);
    });
  });

  describe("status and thanks", () => {
    const g = (status: string) => ({ status }) as Gift;
    it("sums the stocks into one status", () => {
      const s = (...x: string[]) => basketStatus(x.map(g));
      expect(s("READY", "READY")).toBe("READY");
      expect(s("READY", "BUYING")).toBe("BUYING");
      expect(s("PAID", "READY")).toBe("PAID");
      expect(s("CLAIMING", "CLAIMING")).toBe("CLAIMING");
      expect(s("CLAIMED", "CLAIMED")).toBe("CLAIMED");
      expect(s("CLAIMED", "CLAIMING")).toBe("CLAIMING");
      expect(s("READY", "REFUNDED")).toBe("READY");
      expect(s("CLAIMED", "REFUNDED")).toBe("CLAIMED");
      expect(s("AWAITING_PAYMENT", "AWAITING_PAYMENT")).toBe("AWAITING_PAYMENT");
      expect(s("REFUNDED", "REFUNDED")).toBe("REFUNDED");
    });

    it("a thank-you goes on the lead once any stock is claimed, and only once", async () => {
      const b = await basket(2);
      const r = await payBasket(b);
      for (const m of b.gifts) await makeReady(m.id);
      expect(await leaveThanks(db, b.leadId, "Too soon")).toBe("NOT_CLAIMED");
      const c = await beginBasketClaim(db, { giftId: b.leadId, code: r.claimCode!, claimAddress: addr(), ip: ip() });
      if (!c.ok) throw new Error(c.reason);
      expect(await leaveThanks(db, b.leadId, "Still paying out")).toBe("NOT_CLAIMED");
      await completeClaim(db, b.gifts[1]!.id, "0xc");
      expect(await leaveThanks(db, b.leadId, "Thank you!")).toBe("SAVED");
      expect(await leaveThanks(db, b.leadId, "Again")).toBe("ALREADY_THANKED");
      expect((await getGift(db, b.leadId))!.thanksNote).toBe("Thank you!");
    });
  });
});
