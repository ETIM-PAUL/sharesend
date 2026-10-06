// Runs against a real Postgres: TEST_DATABASE_URL (uses and wipes schema test_ledger). Skipped if unset.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/pool.js";
import { freshTestDb } from "../db/testDb.js";
import {
  advanceStep,
  beginClaim,
  CapExceededError,
  completeClaim,
  createGift,
  getGift,
  IllegalTransitionError,
  releaseClaim,
  StaleStateError,
  transition,
  type NewGift,
} from "./ledger.js";
import { generateClaimCode } from "./codes.js";
import { reconcile } from "./reconcile.js";

const url = process.env.TEST_DATABASE_URL;
const SENDER = "0x5e78822d6326360c51d746E164d878210E0FEbff";
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const SPYB = "0x7138b48df7d98d7e3cc221bfe7192d0a178182d8";
const VAULT = "0xF72ae96cB04c5A8036617474d13eED8610ff260C";
const caps = { maxGiftUsd: 20, dailyCapUsd: 1_000_000 };
const addr = () => `0x${randomUUID().replace(/-/g, "")}${"0".repeat(8)}`;
const ip = () => `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;

const input = (over: Partial<NewGift> = {}): NewGift => ({
  senderAddress: SENDER,
  senderName: "Paul",
  recipientName: "Ada",
  message: "Happy birthday",
  ticker: "nvda",
  issuer: "bstock",
  tokenAddress: NVDAB,
  tokenDecimals: 18,
  quotedTokenAmount: 41_000_000_000_000_000n,
  usdCost: 10,
  feeUsd: 0.1,
  paymentExpiresAt: new Date(Date.now() + 60_000),
  ...over,
});

describe.skipIf(!url)("gift ledger (Postgres)", () => {
  let db: Db;

  beforeAll(async () => {
    db = await freshTestDb(url!, "test_ledger", 30);
  });
  afterAll(async () => {
    await db?.end();
  });

  async function readyGift(over: Partial<NewGift> = {}, tokenAmount = 41_000_000_000_000_000n) {
    const { gift, claimCode } = await createGift(db, input(over), caps);
    await transition(db, gift.id, "AWAITING_PAYMENT", "PAID", { paymentTx: "0xpay" });
    await transition(db, gift.id, "PAID", "BUYING");
    await advanceStep(db, gift.id, null, "forwarded", { forwardTx: "0xfwd" });
    await advanceStep(db, gift.id, "forwarded", "swapped", { buyTx: "0xbuy" });
    await advanceStep(db, gift.id, "swapped", "in_vault", { vaultTx: "0xvault", tokenAmount });
    const ready = await transition(db, gift.id, "BUYING", "READY");
    return { gift: ready, claimCode };
  }

  describe("create", () => {
    it("stores only the claim code's hash", async () => {
      const { gift, claimCode } = await createGift(db, input(), caps);
      expect(gift.status).toBe("AWAITING_PAYMENT");
      expect(gift.ticker).toBe("NVDA");
      const { rows } = await db.query("SELECT row_to_json(g)::text AS j FROM gifts g WHERE id = $1", [gift.id]);
      expect(rows[0].j).not.toContain(claimCode);
    });

    it("enforces MAX_GIFT_USD", async () => {
      await expect(createGift(db, input({ usdCost: 20.01 }), caps)).rejects.toMatchObject({ code: "OVER_MAX_GIFT" });
    });

    it("enforces DAILY_CAP_USD even under concurrent creates", async () => {
      const used = Number((await db.query("SELECT coalesce(sum(usd_cost),0) AS u FROM gifts WHERE status NOT IN ('EXPIRED','REFUNDED')")).rows[0].u);
      const tight = { maxGiftUsd: 20, dailyCapUsd: used + 50 };
      const results = await Promise.allSettled(Array.from({ length: 8 }, () => createGift(db, input({ usdCost: 10 }), tight)));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(rejected).toHaveLength(3);
      for (const r of rejected) expect(r.reason).toBeInstanceOf(CapExceededError);
    });

    it("validates input", async () => {
      await expect(createGift(db, input({ senderAddress: "0x123" }), caps)).rejects.toThrow(/senderAddress/);
      await expect(createGift(db, input({ recipientName: "  " }), caps)).rejects.toThrow(/recipientName/);
      await expect(createGift(db, input({ message: "x".repeat(281) }), caps)).rejects.toThrow(/message/);
      await expect(createGift(db, input({ quotedTokenAmount: 0n }), caps)).rejects.toThrow(/quotedTokenAmount/);
    });
  });

  describe("transitions", () => {
    it("walks the happy path and writes an audit event per change", async () => {
      const { gift } = await readyGift();
      expect(gift.status).toBe("READY");
      expect(gift.tokenAmount).toBe(41_000_000_000_000_000n);
      expect(gift.claimExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
      const { rows } = await db.query("SELECT from_status, to_status, step FROM gift_events WHERE gift_id = $1 ORDER BY id", [gift.id]);
      expect(rows.map((r) => `${r.from_status ?? ""}→${r.to_status}${r.step ? `/${r.step}` : ""}`)).toEqual([
        "→AWAITING_PAYMENT",
        "AWAITING_PAYMENT→PAID",
        "PAID→BUYING",
        "BUYING→BUYING/forwarded",
        "BUYING→BUYING/swapped",
        "BUYING→BUYING/in_vault",
        "BUYING→READY",
      ]);
    });

    it("rejects illegal transitions without touching the gift", async () => {
      const { gift } = await createGift(db, input(), caps);
      await expect(transition(db, gift.id, "AWAITING_PAYMENT", "READY")).rejects.toBeInstanceOf(IllegalTransitionError);
      await expect(transition(db, gift.id, "AWAITING_PAYMENT", "CLAIMED")).rejects.toBeInstanceOf(IllegalTransitionError);
      expect((await getGift(db, gift.id))!.status).toBe("AWAITING_PAYMENT");
    });

    it("rejects a transition from a status the gift isn't in (compare-and-set)", async () => {
      const { gift } = await createGift(db, input(), caps);
      await expect(transition(db, gift.id, "PAID", "BUYING")).rejects.toMatchObject({ expected: "PAID", actual: "AWAITING_PAYMENT" });
      await transition(db, gift.id, "AWAITING_PAYMENT", "PAID");
      await expect(transition(db, gift.id, "AWAITING_PAYMENT", "PAID")).rejects.toBeInstanceOf(StaleStateError);
    });

    it("only one of two concurrent identical transitions wins", async () => {
      const { gift } = await createGift(db, input(), caps);
      const r = await Promise.allSettled([transition(db, gift.id, "AWAITING_PAYMENT", "PAID"), transition(db, gift.id, "AWAITING_PAYMENT", "EXPIRED")]);
      expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    });

    it("can't leave a terminal state", async () => {
      const { gift } = await createGift(db, input(), caps);
      await transition(db, gift.id, "AWAITING_PAYMENT", "EXPIRED");
      await expect(transition(db, gift.id, "EXPIRED", "PAID" as never)).rejects.toBeInstanceOf(IllegalTransitionError);
    });

    it("buy steps can't be skipped or repeated", async () => {
      const { gift } = await createGift(db, input(), caps);
      await transition(db, gift.id, "AWAITING_PAYMENT", "PAID");
      await expect(advanceStep(db, gift.id, null, "forwarded")).rejects.toBeInstanceOf(StaleStateError); // not BUYING yet
      await transition(db, gift.id, "PAID", "BUYING");
      await expect(advanceStep(db, gift.id, null, "swapped")).rejects.toBeInstanceOf(IllegalTransitionError);
      await advanceStep(db, gift.id, null, "forwarded");
      await expect(advanceStep(db, gift.id, null, "forwarded")).rejects.toBeInstanceOf(StaleStateError); // retry doesn't repeat
    });

    it("READY requires the received token amount", async () => {
      const { gift } = await createGift(db, input(), caps);
      await transition(db, gift.id, "AWAITING_PAYMENT", "PAID");
      await transition(db, gift.id, "PAID", "BUYING");
      await expect(transition(db, gift.id, "BUYING", "READY")).rejects.toThrow(/ready_has_amount/);
      expect((await getGift(db, gift.id))!.status).toBe("BUYING");
    });
  });

  describe("claims", () => {
    it("claims with the right code into CLAIMING, then CLAIMED", async () => {
      const { gift, claimCode } = await readyGift();
      const to = addr();
      const r = await beginClaim(db, { giftId: gift.id, code: claimCode, claimAddress: to, ip: ip() });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.gift.status).toBe("CLAIMING");
      expect(r.gift.claimAddress!.toLowerCase()).toBe(to.toLowerCase());
      const done = await completeClaim(db, gift.id, "0xclaim");
      expect(done.status).toBe("CLAIMED");
    });

    it("exactly one of many concurrent claims succeeds", async () => {
      const { gift, claimCode } = await readyGift();
      const addrs = Array.from({ length: 20 }, addr);
      const results = await Promise.all(addrs.map((a) => beginClaim(db, { giftId: gift.id, code: claimCode, claimAddress: a, ip: ip() })));
      const winners = results.filter((r) => r.ok);
      expect(winners).toHaveLength(1);
      expect(results.filter((r) => !r.ok).map((r) => (r.ok ? "" : r.reason))).toEqual(Array(19).fill("IN_PROGRESS"));
      const g = await getGift(db, gift.id);
      expect(g!.status).toBe("CLAIMING");
      expect(winners[0]!.ok && winners[0]!.gift.claimAddress).toBe(g!.claimAddress);
    });

    it("rejects a wrong code, a malformed code and an unknown gift with the same answer", async () => {
      const { gift } = await readyGift();
      const a = addr();
      for (const req of [
        { giftId: gift.id, code: generateClaimCode() },
        { giftId: gift.id, code: "not-a-code" },
        { giftId: randomUUID(), code: generateClaimCode() },
        { giftId: "../../etc", code: generateClaimCode() },
      ])
        expect(await beginClaim(db, { ...req, claimAddress: a, ip: ip() })).toEqual({ ok: false, reason: "INVALID" });
      expect((await getGift(db, gift.id))!.status).toBe("READY");
    });

    it("doesn't reveal a gift's status to someone without the code", async () => {
      const { gift, claimCode } = await readyGift();
      await beginClaim(db, { giftId: gift.id, code: claimCode, claimAddress: addr(), ip: ip() });
      await completeClaim(db, gift.id, "0xclaim");
      expect(await beginClaim(db, { giftId: gift.id, code: generateClaimCode(), claimAddress: addr(), ip: ip() })).toEqual({ ok: false, reason: "INVALID" });
    });

    it("rejects already-claimed, expired, returned, refunded and unpaid gifts", async () => {
      const claimed = await readyGift();
      await beginClaim(db, { giftId: claimed.gift.id, code: claimed.claimCode, claimAddress: addr(), ip: ip() });
      await completeClaim(db, claimed.gift.id, "0xclaim");

      const expired = await readyGift();
      await db.query("UPDATE gifts SET claim_expires_at = now() - interval '1 second' WHERE id = $1", [expired.gift.id]);

      const returned = await readyGift();
      await transition(db, returned.gift.id, "READY", "RETURNING");
      await transition(db, returned.gift.id, "RETURNING", "RETURNED", { returnTx: "0xret" });

      const refunded = await createGift(db, input(), caps);
      await transition(db, refunded.gift.id, "AWAITING_PAYMENT", "PAID");
      await transition(db, refunded.gift.id, "PAID", "REFUNDING");
      await transition(db, refunded.gift.id, "REFUNDING", "REFUNDED", { refundTx: "0xref" });

      const unpaid = await createGift(db, input(), caps);

      const tryClaim = (g: { gift: { id: string }; claimCode: string }) => beginClaim(db, { giftId: g.gift.id, code: g.claimCode, claimAddress: addr(), ip: ip() });
      expect(await tryClaim(claimed)).toEqual({ ok: false, reason: "ALREADY_CLAIMED" });
      expect(await tryClaim(expired)).toEqual({ ok: false, reason: "EXPIRED" });
      expect(await tryClaim(returned)).toEqual({ ok: false, reason: "RETURNED" });
      expect(await tryClaim(refunded)).toEqual({ ok: false, reason: "REFUNDED" });
      expect(await tryClaim(unpaid)).toEqual({ ok: false, reason: "NOT_READY" });
      expect((await getGift(db, expired.gift.id))!.status).toBe("READY"); // the return job moves it, not the claim
    });

    it("rejects bad or forbidden claim addresses", async () => {
      const { gift, claimCode } = await readyGift();
      const claim = (claimAddress: string) => beginClaim(db, { giftId: gift.id, code: claimCode, claimAddress, ip: ip(), forbiddenAddresses: [VAULT] });
      for (const a of ["0x123", "0x0000000000000000000000000000000000000000", VAULT, VAULT.toLowerCase(), NVDAB])
        expect(await claim(a)).toEqual({ ok: false, reason: "BAD_ADDRESS" });
      expect((await getGift(db, gift.id))!.status).toBe("READY");
    });

    it("a released claim can be claimed again and keeps its expiry", async () => {
      const { gift, claimCode } = await readyGift();
      await beginClaim(db, { giftId: gift.id, code: claimCode, claimAddress: addr(), ip: ip() });
      const released = await releaseClaim(db, gift.id, "simulation failed");
      expect(released.status).toBe("READY");
      expect(released.claimAddress).toBeNull();
      expect(released.claimExpiresAt).toEqual(gift.claimExpiresAt);
      expect((await beginClaim(db, { giftId: gift.id, code: claimCode, claimAddress: addr(), ip: ip() })).ok).toBe(true);
    });

    it("rate-limits failed attempts per gift, even for the right code", async () => {
      const { gift, claimCode } = await readyGift();
      for (let i = 0; i < 10; i++) await beginClaim(db, { giftId: gift.id, code: generateClaimCode(), claimAddress: addr(), ip: ip() });
      expect(await beginClaim(db, { giftId: gift.id, code: claimCode, claimAddress: addr(), ip: ip() })).toEqual({ ok: false, reason: "RATE_LIMITED" });
    });

    it("rate-limits failed attempts per IP", async () => {
      const attacker = ip();
      for (let i = 0; i < 20; i++) await beginClaim(db, { giftId: randomUUID(), code: generateClaimCode(), claimAddress: addr(), ip: attacker });
      const { gift, claimCode } = await readyGift();
      expect(await beginClaim(db, { giftId: gift.id, code: claimCode, claimAddress: addr(), ip: attacker })).toEqual({ ok: false, reason: "RATE_LIMITED" });
      expect((await beginClaim(db, { giftId: gift.id, code: claimCode, claimAddress: addr(), ip: ip() })).ok).toBe(true);
    });
  });

  describe("reconciliation", () => {
    it("compares vault holdings per token with unclaimed gifts", async () => {
      await db.query("TRUNCATE gifts, gift_events, claim_attempts CASCADE");
      await readyGift({}, 100n);
      await readyGift({}, 50n);
      const claiming = await readyGift({}, 7n);
      await beginClaim(db, { giftId: claiming.gift.id, code: claiming.claimCode, claimAddress: addr(), ip: ip() });
      const done = await readyGift({}, 1000n); // claimed: no longer owed
      await beginClaim(db, { giftId: done.gift.id, code: done.claimCode, claimAddress: addr(), ip: ip() });
      await completeClaim(db, done.gift.id, "0xclaim");
      await readyGift({ ticker: "SPY", tokenAddress: SPYB }, 30n);
      await createGift(db, input({ tokenAddress: SPYB }), caps); // unpaid: not owed

      const balances: Record<string, bigint> = { [NVDAB]: 157n, [SPYB]: 29n };
      const r = await reconcile(db, async (t) => balances[t.toLowerCase()] ?? 0n);
      expect(r.rows.map((x) => [x.ticker, x.gifts, x.amountRaw, x.holdingRaw, x.surplusRaw, x.ok])).toEqual([
        ["NVDA", 3, 157n, 157n, 0n, true],
        ["SPY", 1, 30n, 29n, -1n, false],
      ]);
      expect(r.ok).toBe(false);
    });
  });
});
