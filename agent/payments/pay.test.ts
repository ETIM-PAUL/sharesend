// Pay flow against Postgres (TEST_DATABASE_URL, schema test_payments wiped) with a fake B402 facilitator.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Db } from "../db/pool.js";
import { freshTestDb } from "../db/testDb.js";
import { beginClaim, createGift, getGift } from "../gifts/ledger.js";
import { buildAccepts, draftAuthorization, eip3009TypedData, permit2ExactTypedData } from "./x402.js";
import { payForGift, type FundsCheck, type PayDeps } from "./pay.js";
import type { Facilitator, PaymentPayload, PaymentRequirements } from "./b402.js";
import { ASSETS } from "./fixtures.js";

const url = process.env.TEST_DATABASE_URL;
const VAULT = "0xF72ae96cB04c5A8036617474d13eED8610ff260C";

class FakeFacilitator implements Facilitator {
  verifyOk = true;
  settleMode: "ok" | "fail" | "throw" = "ok";
  verifies = 0;
  settles = 0;
  settledPayloads = new Map<string, string>();
  async verify() {
    this.verifies++;
    return this.verifyOk ? { isValid: true } : { isValid: false, invalidReason: "invalid_exact_evm_payload_signature" };
  }
  async settle(p: PaymentPayload) {
    this.settles++;
    if (this.settleMode === "throw") throw new Error("timeout");
    if (this.settleMode === "fail") return { success: false, errorReason: "insufficient_funds" };
    const key = JSON.stringify(p.payload);
    // Idempotent per signed payload, like B402.
    if (!this.settledPayloads.has(key)) this.settledPayloads.set(key, `0x${randomBytes(32).toString("hex")}`);
    return { success: true, transaction: this.settledPayloads.get(key)!, network: "eip155:56" };
  }
}

class FakeFunds implements FundsCheck {
  balance = 10n ** 30n;
  allowance: bigint | null = 10n ** 30n;
  async check(_a: string, _p: string, method: string) {
    return { balance: this.balance, allowance: method.startsWith("permit2") ? this.allowance : null };
  }
}

describe.skipIf(!url)("payForGift (Postgres + fake B402)", () => {
  let db: Db;
  let fac: FakeFacilitator;
  let funds: FakeFunds;
  let d: PayDeps;

  beforeAll(async () => {
    db = await freshTestDb(url!, "test_payments");
  });
  afterAll(async () => {
    await db?.end();
  });
  beforeEach(() => {
    fac = new FakeFacilitator();
    funds = new FakeFunds();
    d = { db, facilitator: fac, funds, liveTrading: true };
  });

  async function openGift(opts: { dryRun?: boolean; expired?: boolean } = {}) {
    const sender = privateKeyToAccount(generatePrivateKey());
    const accepts = buildAccepts(ASSETS, 5.1, VAULT);
    const { gift, claimCode } = await createGift(
      db,
      {
        senderAddress: sender.address,
        senderName: "Paul",
        recipientName: "Ada",
        ticker: "NVDA",
        issuer: "bstock",
        tokenAddress: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436",
        tokenDecimals: 18,
        quotedTokenAmount: 10n ** 16n,
        usdCost: 5,
        feeUsd: 0.1,
        paymentExpiresAt: new Date(Date.now() + (opts.expired ? -1000 : 300_000)),
        dryRun: opts.dryRun,
        paymentRequirements: accepts,
      },
      { maxGiftUsd: 20, dailyCapUsd: 1e9 },
    );
    return { gift, sender, accepts, creationCode: claimCode };
  }

  async function sign(sender: ReturnType<typeof privateKeyToAccount>, r: PaymentRequirements): Promise<PaymentPayload> {
    const now = Math.floor(Date.now() / 1000);
    const dr = draftAuthorization(r, sender.address, now, randomBytes(32));
    const payload =
      dr.method === "eip3009"
        ? { signature: await sender.signTypedData(eip3009TypedData(r, dr.authorization)), authorization: dr.authorization }
        : { signature: await sender.signTypedData(permit2ExactTypedData(dr.permit2Authorization)), permit2Authorization: dr.permit2Authorization };
    return { x402Version: 2, accepted: r, payload };
  }

  it("verifies, settles, marks PAID, issues a claim code once and records the fee", async () => {
    const { gift, sender, accepts, creationCode } = await openGift();
    const p = await sign(sender, accepts[0]!);
    const r = await payForGift(d, gift.id, p);
    if (!r.ok) throw new Error(r.error);
    expect(r.gift.status).toBe("PAID");
    expect(r.gift.paymentTx).toBe(r.settleTx);
    expect(r.claimCode).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect([fac.verifies, fac.settles]).toEqual([1, 1]);

    const pay = (await db.query("SELECT status, settle_tx, payer FROM payments WHERE gift_id = $1", [gift.id])).rows[0];
    expect(pay).toMatchObject({ status: "settled", settle_tx: r.settleTx, payer: sender.address });
    const fee = (await db.query("SELECT usd FROM agent_ledger WHERE gift_id = $1 AND kind = 'fee_income'", [gift.id])).rows[0];
    expect(Number(fee.usd)).toBe(0.1);

    // Only the issued code works; the one generated at creation was never given out and is now dead.
    await db.query("UPDATE gifts SET status = 'READY', token_amount = 1, claim_expires_at = now() + interval '1 day' WHERE id = $1", [gift.id]);
    const claimTo = privateKeyToAccount(generatePrivateKey()).address;
    expect(await beginClaim(db, { giftId: gift.id, code: creationCode, claimAddress: claimTo, ip: "t1" })).toEqual({ ok: false, reason: "INVALID" });
    expect((await beginClaim(db, { giftId: gift.id, code: r.claimCode!, claimAddress: claimTo, ip: "t2" })).ok).toBe(true);
  });

  it("works with EIP-3009 assets too", async () => {
    const { gift, sender, accepts } = await openGift();
    const r = await payForGift(d, gift.id, await sign(sender, accepts[1]!));
    expect(r.ok && r.gift.status).toBe("PAID");
  });

  it("a retry of the same payment after success is idempotent and gives no second code", async () => {
    const { gift, sender, accepts } = await openGift();
    const p = await sign(sender, accepts[0]!);
    await payForGift(d, gift.id, p);
    const again = await payForGift(d, gift.id, p);
    expect(again).toMatchObject({ ok: true, alreadyPaid: true, claimCode: null });
    expect(fac.settles).toBe(1);
  });

  it("concurrent submissions of one payment: PAID once, one claim code", async () => {
    const { gift, sender, accepts } = await openGift();
    const p = await sign(sender, accepts[0]!);
    const rs = await Promise.all([1, 2, 3, 4].map(() => payForGift(d, gift.id, p)));
    const codes = rs.filter((r) => r.ok && r.claimCode).length;
    expect(codes).toBe(1);
    expect(new Set([...fac.settledPayloads.values()]).size).toBe(1);
    expect((await getGift(db, gift.id))!.status).toBe("PAID");
  });

  it("a second, different payment for a paid gift is refused", async () => {
    const { gift, sender, accepts } = await openGift();
    await payForGift(d, gift.id, await sign(sender, accepts[0]!));
    expect(await payForGift(d, gift.id, await sign(sender, accepts[1]!))).toMatchObject({ ok: false, status: 409 });
  });

  it("rejects a payer who isn't the gift's sender", async () => {
    const { gift, accepts } = await openGift();
    const stranger = privateKeyToAccount(generatePrivateKey());
    expect(await payForGift(d, gift.id, await sign(stranger, accepts[0]!))).toMatchObject({ ok: false, status: 402, error: expect.stringContaining("sender") });
    expect(fac.verifies).toBe(0);
  });

  it("rejects a payload for an amount that wasn't offered", async () => {
    const { gift, sender, accepts } = await openGift();
    const cheap = { ...accepts[0]!, amount: "1000" };
    expect(await payForGift(d, gift.id, await sign(sender, cheap))).toMatchObject({ ok: false, status: 402, error: expect.stringContaining("does not match") });
  });

  it("expires the gift once the payment window has passed", async () => {
    const { gift, sender, accepts } = await openGift({ expired: true });
    expect(await payForGift(d, gift.id, await sign(sender, accepts[0]!))).toMatchObject({ ok: false, status: 410 });
    expect((await getGift(db, gift.id))!.status).toBe("EXPIRED");
  });

  it("an invalid signature never settles", async () => {
    const { gift, sender, accepts } = await openGift();
    fac.verifyOk = false;
    expect(await payForGift(d, gift.id, await sign(sender, accepts[0]!))).toMatchObject({ ok: false, status: 402 });
    expect(fac.settles).toBe(0);
  });

  it("checks balance and Permit2 allowance before settling (B402 verify doesn't)", async () => {
    const a = await openGift();
    funds.balance = 0n;
    expect(await payForGift(d, a.gift.id, await sign(a.sender, a.accepts[0]!))).toMatchObject({ ok: false, error: expect.stringContaining("balance") });
    funds.balance = 10n ** 30n;
    funds.allowance = 0n;
    expect(await payForGift(d, a.gift.id, await sign(a.sender, a.accepts[0]!))).toMatchObject({ ok: false, error: expect.stringContaining("Permit2 approval") });
    // EIP-3009 needs no allowance.
    expect((await payForGift(d, a.gift.id, await sign(a.sender, a.accepts[1]!))).ok).toBe(true);
    expect(fac.settles).toBe(1);
  });

  it("a failed settlement leaves the gift payable", async () => {
    const { gift, sender, accepts } = await openGift();
    fac.settleMode = "fail";
    expect(await payForGift(d, gift.id, await sign(sender, accepts[0]!))).toMatchObject({ ok: false, status: 402, error: expect.stringContaining("insufficient_funds") });
    expect((await getGift(db, gift.id))!.status).toBe("AWAITING_PAYMENT");
    fac.settleMode = "ok";
    expect((await payForGift(d, gift.id, await sign(sender, accepts[0]!))).ok).toBe(true);
  });

  it("a settlement timeout can be retried with the same payment, even after the window closes", async () => {
    const { gift, sender, accepts } = await openGift();
    const p = await sign(sender, accepts[0]!);
    fac.settleMode = "throw";
    expect(await payForGift(d, gift.id, p)).toMatchObject({ ok: false, status: 502, retryable: true });
    await db.query("UPDATE gifts SET payment_expires_at = now() - interval '1 minute' WHERE id = $1", [gift.id]);
    // A different payment can't jump in while this one may have settled.
    expect(await payForGift(d, gift.id, await sign(sender, accepts[1]!))).toMatchObject({ ok: false, status: 409 });
    fac.settleMode = "ok";
    const r = await payForGift(d, gift.id, p);
    expect(r.ok && r.gift.status).toBe("PAID");
  });

  it("dry run: verifies and checks funds but never settles", async () => {
    const { gift, sender, accepts } = await openGift({ dryRun: true });
    const r = await payForGift({ ...d, liveTrading: false }, gift.id, await sign(sender, accepts[0]!));
    expect(r.ok && r.gift.status).toBe("PAID");
    expect(r.ok && r.gift.paymentTx).toMatch(/^dryrun:verified:/);
    expect([fac.verifies, fac.settles]).toEqual([1, 0]);
  });

  it("refuses a live gift on a dry-run server", async () => {
    const { gift, sender, accepts } = await openGift();
    expect(await payForGift({ ...d, liveTrading: false }, gift.id, await sign(sender, accepts[0]!))).toMatchObject({ ok: false, status: 409 });
  });
});
