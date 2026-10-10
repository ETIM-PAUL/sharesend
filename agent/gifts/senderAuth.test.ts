// Sender-signed actions against Postgres (TEST_DATABASE_URL, schema test_sender wiped). Skipped if unset.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyMessage } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Db } from "../db/pool.js";
import { freshTestDb } from "../db/testDb.js";
import { createGift, getGift, reissueClaimCode, setReturnAs, transition, beginClaim } from "./ledger.js";
import { actionOf, senderMessage, verifySender } from "./senderAuth.js";
import { cancelGift } from "../execution/cancel.js";

const url = process.env.TEST_DATABASE_URL;
const verify = (address: string, message: string, signature: string) =>
  verifyMessage({ address: address as `0x${string}`, message, signature: signature as `0x${string}` });

describe.skipIf(!url)("sender-signed actions (Postgres)", () => {
  let db: Db;
  beforeAll(async () => {
    db = await freshTestDb(url!, "test_sender");
  });
  afterAll(async () => {
    await db?.end();
  });

  const set = (id: string, sql: string) => db.query(`UPDATE gifts SET ${sql} WHERE id = $1`, [id]);

  async function gift() {
    const sender = privateKeyToAccount(generatePrivateKey());
    const { gift } = await createGift(
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
        paymentExpiresAt: new Date(Date.now() + 300_000),
      },
      { maxGiftUsd: 20, dailyCapUsd: 1e9 },
    );
    return { sender, gift };
  }

  it("accepts the sender's signature once, and only for that action and gift", async () => {
    const { sender, gift: g } = await gift();
    const msg = senderMessage("cancel", g.id, new Date().toISOString());
    const sig = await sender.signMessage({ message: msg });
    expect(await verifySender(db, g, "link", msg, sig, verify)).toMatchObject({ ok: false, error: expect.stringContaining("doesn't match") });
    expect(await verifySender(db, g, "cancel", msg, sig, verify)).toEqual({ ok: true });
    expect(await verifySender(db, g, "cancel", msg, sig, verify)).toMatchObject({ ok: false, error: expect.stringContaining("already used") });
  });

  it("rejects other signers, expired messages and another gift's message", async () => {
    const { gift: g } = await gift();
    const other = await gift();
    const stranger = privateKeyToAccount(generatePrivateKey());
    const msg = senderMessage("cancel", g.id, new Date().toISOString());
    expect(await verifySender(db, g, "cancel", msg, await stranger.signMessage({ message: msg }), verify)).toMatchObject({ ok: false, error: expect.stringContaining("not from") });
    const old = senderMessage("cancel", g.id, new Date(Date.now() - 6 * 60_000).toISOString());
    expect(await verifySender(db, g, "cancel", old, "0x00", verify)).toMatchObject({ ok: false, error: expect.stringContaining("expired") });
    const forOther = senderMessage("cancel", other.gift.id, new Date().toISOString());
    expect(await verifySender(db, g, "cancel", forOther, await other.sender.signMessage({ message: forOther }), verify)).toMatchObject({ ok: false });
  });

  it("a new claim link replaces the old one", async () => {
    const { gift: g } = await gift();
    expect(await reissueClaimCode(db, g.id)).toBeNull(); // unpaid
    await transition(db, g.id, "AWAITING_PAYMENT", "PAID");
    const first = (await reissueClaimCode(db, g.id))!;
    const second = (await reissueClaimCode(db, g.id))!;
    await db.query("UPDATE gifts SET status = 'READY', token_amount = 1, claim_expires_at = now() + interval '1 day' WHERE id = $1", [g.id]);
    const to = privateKeyToAccount(generatePrivateKey()).address;
    expect(await beginClaim(db, { giftId: g.id, code: first, claimAddress: to, ip: "a" })).toEqual({ ok: false, reason: "INVALID" });
    expect((await beginClaim(db, { giftId: g.id, code: second, claimAddress: to, ip: "b" })).ok).toBe(true);
    expect(await reissueClaimCode(db, g.id)).toBeNull(); // claiming
  });

  it("cancel: unpaid expires, paid refunds, ready returns, buying waits", async () => {
    const started: string[] = [];
    const bg = (_db: Db, id: string) => void started.push(id);

    const a = await gift();
    expect((await cancelGift(db, a.gift.id, bg)).ok && (await getGift(db, a.gift.id))!.status).toBe("EXPIRED");

    const b = await gift();
    await transition(db, b.gift.id, "AWAITING_PAYMENT", "PAID");
    const rb = await cancelGift(db, b.gift.id, bg);
    expect(rb.ok && rb.gift.status).toBe("REFUNDING");

    const c = await gift();
    await transition(db, c.gift.id, "AWAITING_PAYMENT", "PAID");
    await db.query("UPDATE gifts SET status = 'READY', token_amount = 1, claim_expires_at = now() + interval '1 day' WHERE id = $1", [c.gift.id]);
    const rc = await cancelGift(db, c.gift.id, bg);
    expect(rc.ok && rc.gift.status).toBe("RETURNING");
    expect(started).toEqual([b.gift.id, c.gift.id]);

    const d = await gift();
    await transition(db, d.gift.id, "AWAITING_PAYMENT", "PAID");
    await transition(db, d.gift.id, "PAID", "BUYING");
    expect(await cancelGift(db, d.gift.id, bg)).toMatchObject({ ok: false, status: 409 });
  });

  describe("how a gift comes back", () => {
    it("the signed text names the choice, so one signature can't be replayed as the other", async () => {
      const { sender, gift: g } = await gift();
      const iso = new Date().toISOString();
      const usdtMsg = senderMessage("return-usdt", g.id, iso);
      const sig = await sender.signMessage({ message: usdtMsg });
      expect(actionOf(usdtMsg, g.id, ["return-stock", "return-usdt"])).toBe("return-usdt");
      // The same signature presented with the other choice's text is rejected.
      const stockMsg = senderMessage("return-stock", g.id, iso);
      expect(await verifySender(db, g, "return-stock", stockMsg, sig, verify)).toMatchObject({ ok: false, error: expect.stringContaining("not from") });
      expect(await verifySender(db, g, "return-usdt", usdtMsg, sig, verify)).toEqual({ ok: true });
      expect(actionOf("ShareSend\nSomething else\nGift: x\nTime: y", g.id, ["cancel"])).toBeNull();
    });

    it("the default is stock; the choice can be set until the sell-back starts", async () => {
      const { gift: g } = await gift();
      expect((await getGift(db, g.id))!.returnAs).toBe("stock");
      expect(await setReturnAs(db, g.id, "usdt")).toBe(true);
      expect((await getGift(db, g.id))!.returnAs).toBe("usdt");
      await db.query("INSERT INTO exec_records (gift_id, kind, status) VALUES ($1, 'to_wallet', 'confirmed')", [g.id]);
      expect(await setReturnAs(db, g.id, "stock")).toBe(false);
    });

    it("can't be changed after the gift is claimed or returned", async () => {
      const { gift: g } = await gift();
      await db.query("UPDATE gifts SET status = 'CLAIMED', claim_address = '0x1', token_amount = 1, claim_expires_at = now() + interval '1 day' WHERE id = $1", [g.id]);
      expect(await setReturnAs(db, g.id, "usdt")).toBe(false);
    });

    it("cancelling a ready gift with a choice saves it, then starts the return", async () => {
      const started: string[] = [];
      const { gift: g } = await gift();
      await transition(db, g.id, "AWAITING_PAYMENT", "PAID");
      await set(g.id, "status = 'READY', token_amount = 1, claim_expires_at = now() + interval '1 day'");
      const r = await cancelGift(db, g.id, (_db, id) => void started.push(id), "usdt");
      expect(r.ok && r.gift.status).toBe("RETURNING");
      expect((await getGift(db, g.id))!.returnAs).toBe("usdt");
      expect(started).toEqual([g.id]);
    });

    it("a gift is created with the sender's choice", async () => {
      const { gift: g } = await createGift(
        db,
        {
          senderAddress: privateKeyToAccount(generatePrivateKey()).address,
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
          returnAs: "usdt",
        },
        { maxGiftUsd: 20, dailyCapUsd: 1e9 },
      );
      expect(g.returnAs).toBe("usdt");
    });
  });
});
