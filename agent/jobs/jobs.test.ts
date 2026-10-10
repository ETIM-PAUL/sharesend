// Jobs against Postgres (TEST_DATABASE_URL, schema test_jobs wiped). Skipped if unset.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/pool.js";
import { freshTestDb } from "../db/testDb.js";
import { createGift, getGift, transition, type NewGift } from "../gifts/ledger.js";
import type { ExecOutcome } from "../execution/buy.js";
import { buildJobs, type JobDeps } from "./jobs.js";
import { latestRuns, runJobOnce, type JobDef } from "./runner.js";

const url = process.env.TEST_DATABASE_URL;
const TOKEN = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";

describe.skipIf(!url)("autonomous jobs (Postgres)", () => {
  let db: Db;
  let advanced: string[];
  let alerts: string[];
  let nextOutcome: (id: string) => ExecOutcome["status"];

  beforeAll(async () => {
    db = await freshTestDb(url!, "test_jobs");
  });
  afterAll(async () => {
    await db?.end();
  });
  beforeEach(async () => {
    await db.query("TRUNCATE gifts, gift_events, claim_attempts, payments, exec_records, job_runs, agent_ledger CASCADE");
    advanced = [];
    alerts = [];
    nextOutcome = () => "NOOP";
  });

  const deps = (over: Partial<JobDeps> = {}): JobDeps => ({
    advance: async (_db, id) => {
      advanced.push(id);
      return { status: nextOutcome(id), reason: "test" } as ExecOutcome;
    },
    alert: async (t) => void alerts.push(t),
    vaultBalanceOf: async () => 0n,
    ...over,
  });
  const job = (name: string, over: Partial<JobDeps> = {}) => buildJobs(deps(over)).find((j) => j.name === name)!;

  async function gift(over: Partial<NewGift> = {}) {
    const { gift } = await createGift(
      db,
      {
        senderAddress: "0x5e78822d6326360c51d746E164d878210E0FEbff",
        senderName: "Paul",
        recipientName: "Ada",
        ticker: "NVDA",
        issuer: "bstock",
        tokenAddress: TOKEN,
        tokenDecimals: 18,
        quotedTokenAmount: 10n ** 16n,
        usdCost: 5,
        feeUsd: 0.1,
        paymentExpiresAt: new Date(Date.now() + 300_000),
        ...over,
      },
      { maxGiftUsd: 20, dailyCapUsd: 1e9 },
    );
    return gift.id;
  }
  const status = async (id: string) => (await getGift(db, id))!.status;
  const set = (id: string, sql: string) => db.query(`UPDATE gifts SET ${sql} WHERE id = $1`, [id]);

  describe("runner", () => {
    it("records each run, including failures", async () => {
      const bad: JobDef = { name: "boom", title: "", everyMs: 1000, run: async () => { throw new Error("kaput"); } };
      const r = await runJobOnce(db, bad);
      expect(r).toMatchObject({ ok: false, summary: "failed: kaput" });
      expect((await latestRuns(db)).boom).toMatchObject({ ok: false, runsLastDay: 1, failuresLastDay: 1 });
    });

    it("never overlaps a job with itself", async () => {
      let release!: () => void;
      const slow: JobDef = { name: "slow", title: "", everyMs: 1000, run: () => new Promise((ok) => (release = () => ok({ summary: "done" }))) };
      const first = runJobOnce(db, slow);
      await new Promise((ok) => setTimeout(ok, 100));
      expect(await runJobOnce(db, slow)).toBe("busy");
      release();
      expect(await first).toMatchObject({ ok: true, summary: "done" });
    });
  });

  it("expire-unpaid closes unpaid gifts past their window, but never one mid-payment", async () => {
    const stale = await gift({ paymentExpiresAt: new Date(Date.now() - 5 * 60_000) });
    const fresh = await gift();
    const settling = await gift({ paymentExpiresAt: new Date(Date.now() - 5 * 60_000) });
    await db.query("INSERT INTO payments (gift_id, payload_hash, payer, asset, method, amount, status) VALUES ($1, 'h', '0x1', '0x2', 'eip3009', 1, 'settling')", [settling]);
    expect(await runJobOnce(db, job("expire-unpaid"))).toMatchObject({ summary: "expired 1 unpaid gift" });
    expect([await status(stale), await status(fresh), await status(settling)]).toEqual(["EXPIRED", "AWAITING_PAYMENT", "AWAITING_PAYMENT"]);
  });

  it("expiry-returns starts returns for gifts past the claim window and drives them", async () => {
    const due = await gift();
    const notDue = await gift();
    for (const id of [due, notDue]) await set(id, "status = 'READY', token_amount = 1, claim_expires_at = now() + interval '1 day'");
    await set(due, "claim_expires_at = now() - interval '1 minute'");
    nextOutcome = () => "RETURNED";
    const r = await runJobOnce(db, job("expiry-returns"));
    expect(r).toMatchObject({ ok: true, summary: "1 expired, 1 returned to sender, 0 still in progress" });
    expect(await status(due)).toBe("RETURNING"); // the fake advance doesn't move it; the real one returns it
    expect(await status(notDue)).toBe("READY");
    expect(advanced).toEqual([due]);
  });

  it("resume-payouts picks up stuck claims and refunds, not fresh ones", async () => {
    const stuck = await gift();
    const fresh = await gift();
    const refunding = await gift();
    await set(stuck, "status = 'CLAIMING', token_amount = 1, claim_expires_at = now() + interval '1 day', claim_address = '0x1', updated_at = now() - interval '5 minutes'");
    await set(fresh, "status = 'CLAIMING', token_amount = 1, claim_expires_at = now() + interval '1 day', claim_address = '0x1'");
    await set(refunding, "status = 'REFUNDING', updated_at = now() - interval '5 minutes'");
    nextOutcome = (id) => (id === stuck ? "CLAIMED" : "REFUNDED");
    expect(await runJobOnce(db, job("resume-payouts"))).toMatchObject({ summary: "1 claims and 1 refunds finished, 0 still waiting" });
    expect(advanced.sort()).toEqual([stuck, refunding].sort());
  });

  it("buy-queue buys oldest first and stops as soon as the wallet says wait", async () => {
    const a = await gift();
    const b = await gift();
    for (const id of [a, b]) await transition(db, id, "AWAITING_PAYMENT", "PAID");
    nextOutcome = () => "QUEUED";
    expect(await runJobOnce(db, job("buy-queue"))).toMatchObject({ summary: "queued: the Agentic Wallet is signed out (2 waiting)" });
    expect(advanced).toEqual([a]);
  });

  describe("conditional orders", () => {
    const order = (hours = 2) => ({ dropPct: 0.5, baseline: 230, deadline: new Date(Date.now() + hours * 3_600_000) });
    const paid = async (withOrder = true) => {
      const id = await gift({ order: withOrder ? order() : undefined } as never);
      await transition(db, id, "AWAITING_PAYMENT", "PAID");
      return id;
    };

    it("price-watch looks at every waiting order, oldest deadline first, and nothing else", async () => {
      const a = await paid();
      const plain = await paid(false);
      await set(a, "order_deadline = now() + interval '1 hour'");
      nextOutcome = () => "WAITING";
      const r = await runJobOnce(db, job("price-watch"));
      expect(r).toMatchObject({ ok: true, summary: "1 waiting order: 1 still waiting, 0 bought, 0 refunded after their deadline" });
      expect(advanced).toEqual([a]);
      expect(advanced).not.toContain(plain);
    });

    it("reports bought and refunded orders", async () => {
      const bought = await paid();
      const expired = await paid();
      await set(bought, "order_deadline = now() + interval '1 hour'");
      await set(expired, "order_deadline = now() + interval '2 hours'");
      nextOutcome = (id) => (id === bought ? "READY" : "FAILED");
      expect(await runJobOnce(db, job("price-watch"))).toMatchObject({ summary: "2 waiting orders: 0 still waiting, 1 bought, 1 refunded after their deadline" });
    });

    it("an order already triggered is the buy queue's, not the watcher's", async () => {
      const id = await paid();
      await set(id, "order_triggered_at = now()");
      nextOutcome = () => "READY";
      expect(await runJobOnce(db, job("price-watch"))).toMatchObject({ summary: "no orders waiting for a price" });
      await runJobOnce(db, job("buy-queue"));
      expect(advanced).toEqual([id]);
    });

    it("the buy queue leaves waiting orders alone, so they can't crowd out ordinary gifts", async () => {
      const waiting = await Promise.all([1, 2, 3, 4, 5, 6].map(() => paid()));
      const plain = await paid(false);
      nextOutcome = () => "READY";
      await runJobOnce(db, job("buy-queue"));
      expect(advanced).toEqual([plain]);
      expect(waiting).toHaveLength(6);
    });
  });

  it("reconcile alerts once when holdings fall short, not on every run", async () => {
    const id = await gift();
    await set(id, "status = 'READY', token_amount = 100, claim_expires_at = now() + interval '1 day'");
    const short = job("reconcile", { vaultBalanceOf: async () => 99n });
    expect(await runJobOnce(db, short)).toMatchObject({ ok: false, summary: "SHORT on NVDA" });
    expect(await runJobOnce(db, short)).toMatchObject({ ok: false });
    expect(alerts).toHaveLength(1);
    const fine = job("reconcile", { vaultBalanceOf: async () => 100n });
    expect(await runJobOnce(db, fine)).toMatchObject({ ok: true, summary: "covered: the vault holds enough for all 1 unclaimed gifts" });
  });

  describe("keepalive", () => {
    const settings = (inactive: string, expire = new Date(Date.now() + 40 * 3_600_000).toISOString()) => async () =>
      ({ inactiveSignOutTime: inactive, sessionExpireTime: expire, quotaLeft: 100, dailyLimit: 100 }) as never;

    it("records the session and whether the check extended the inactivity timer", async () => {
      await runJobOnce(db, job("keepalive", { bawStatus: async () => "CONNECTED", bawSettings: settings("2026-10-12T10:00:00Z") }));
      const r = await runJobOnce(db, job("keepalive", { bawStatus: async () => "CONNECTED", bawSettings: settings("2026-10-12T11:00:00Z") }));
      expect(r).toMatchObject({ ok: true, detail: { connected: true, activityExtended: true } });
      expect(alerts).toEqual([]);
    });

    it("alerts once when the wallet signs out", async () => {
      const out = job("keepalive", { bawStatus: async () => "UNCONNECTED" });
      expect(await runJobOnce(db, out)).toMatchObject({ ok: false, summary: "signed out: buys are queued until the next sign-in" });
      await runJobOnce(db, out);
      expect(alerts).toHaveLength(1);
    });

    it("warns once inside the last 12 hours of a session", async () => {
      const soon = new Date(Date.now() + 6 * 3_600_000).toISOString();
      const k = job("keepalive", { bawStatus: async () => "CONNECTED", bawSettings: settings("2026-10-12T10:00:00Z", soon) });
      await runJobOnce(db, k);
      await runJobOnce(db, k);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toContain("session ends");
    });
  });
});
