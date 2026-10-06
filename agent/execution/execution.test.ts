// Pipeline tests with fake Agentic Wallet / chain / market and the real vault logic on a fake signer,
// against Postgres (TEST_DATABASE_URL, schema test_execution wiped). Skipped if unset.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getAddress, parseUnits } from "viem";
import type { Db } from "../db/pool.js";
import { freshTestDb } from "../db/testDb.js";
import { beginClaim, createGift, getGift, transition } from "../gifts/ledger.js";
import { runBuy, type ExecConfig, type ExecDeps } from "./buy.js";
import { payoutClaim, refundGift, returnGift } from "./payouts.js";
import { createVault, type VaultBackend } from "./vault.js";
import { NeedsGasError, type AgenticWalletPort, type ChainPort, type MarketPort } from "./ports.js";

const url = process.env.TEST_DATABASE_URL;
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const TOKEN = getAddress("0x02fca66c1d1afb4e2a7884261eb00f63598a7436");
const AW = "0x3Dd47653417043C09C303d507B243c527529D892";
const VAULT = "0xF72ae96cB04c5A8036617474d13eED8610ff260C";
const SENDER = "0x5e78822d6326360c51d746E164d878210E0FEbff";
const QUOTED = parseUnits("0.0416", 18);

type Tx = { state: "pending" | "success" | "reverted"; token: string; to: string; amount: bigint };

/** In-memory chain shared by the fakes. */
class FakeChain implements ChainPort {
  txs = new Map<string, Tx>();
  async transferIn(hash: string, token: string, to: string) {
    const t = this.txs.get(hash);
    if (!t) return { state: "pending" as const, amount: 0n };
    if (t.state !== "success") return { state: t.state, amount: 0n };
    return { state: "success" as const, amount: t.token.toLowerCase() === token.toLowerCase() && t.to.toLowerCase() === to.toLowerCase() ? t.amount : 0n };
  }
}

class FakeWallet implements AgenticWalletPort {
  address = AW;
  connected = true;
  quote = QUOTED;
  orders = new Map<string, { status: "PENDING" | "FINISHED" | "FAILED"; txHash: string | null; toToken: string; at: number }>();
  sends: { hash: string; token: string; at: number }[] = [];
  swapCalls = 0;
  sendCalls = 0;
  nextOrderStatus: "PENDING" | "FINISHED" | "FAILED" = "FINISHED";
  swapOut = QUOTED;
  crashAfterSwap = false;
  crashAfterSend = false;
  constructor(private chain: FakeChain) {}
  async isConnected() {
    return this.connected;
  }
  async quoteOut() {
    return this.quote;
  }
  async submitSwap(toToken: string) {
    this.swapCalls++;
    const id = `order-${this.swapCalls}`;
    const txHash = `0xswap${this.swapCalls}`;
    this.orders.set(id, { status: this.nextOrderStatus, txHash: this.nextOrderStatus === "FAILED" ? null : txHash, toToken, at: Date.now() });
    if (this.nextOrderStatus !== "FAILED") this.chain.txs.set(txHash, { state: "success", token: toToken, to: AW, amount: this.swapOut });
    if (this.crashAfterSwap) {
      this.crashAfterSwap = false;
      throw new Error("process crashed after submitting the swap");
    }
    return id;
  }
  async getOrder(id: string) {
    const o = this.orders.get(id);
    return o ? { status: o.status, txHash: o.txHash } : null;
  }
  async findOrderSince(toToken: string, since: number) {
    for (const [id, o] of this.orders) if (o.toToken === toToken && o.at >= since && o.status !== "FAILED") return id;
    return null;
  }
  async sendToVault(token: string, amountHuman: string) {
    this.sendCalls++;
    const hash = `0xsend${this.sendCalls}`;
    this.sends.push({ hash, token, at: Date.now() });
    this.chain.txs.set(hash, { state: "success", token, to: VAULT, amount: parseUnits(amountHuman, 18) });
    if (this.crashAfterSend) {
      this.crashAfterSend = false;
      throw new Error("process crashed after sending");
    }
    return hash;
  }
  async findSendSince(token: string, since: number) {
    return this.sends.find((s) => s.token === token && s.at >= since)?.hash ?? null;
  }
}

class FakeBackend implements VaultBackend {
  address = VAULT;
  simulateOk = true;
  gas = true;
  confirmImmediately = true;
  nonce = 0;
  signed: { hash: string; token: string; to: string; amount: bigint }[] = [];
  broadcasts: string[] = [];
  constructor(private chain: FakeChain) {}
  async simulate() {
    return this.simulateOk ? { ok: true, reason: "" } : { ok: false, reason: "execution reverted: blocked" };
  }
  async hasGas() {
    return this.gas;
  }
  async pendingNonce() {
    return this.nonce;
  }
  async sign(token: string, to: string, amount: bigint, nonce: number) {
    const hash = `0xvault${nonce}-${randomUUID().slice(0, 8)}`;
    this.signed.push({ hash, token, to, amount });
    return { hash, raw: `raw:${hash}` };
  }
  async broadcast(raw: string) {
    this.broadcasts.push(raw);
    const hash = raw.slice(4);
    const s = this.signed.find((x) => x.hash === hash)!;
    this.nonce++;
    if (this.confirmImmediately) this.chain.txs.set(hash, { state: "success", token: s.token, to: s.to, amount: s.amount });
  }
  transferIn = (h: string, t: string, to: string) => this.chain.transferIn(h, t, to);
}

class FakeMarket implements MarketPort {
  out = QUOTED;
  async apiQuoteOut() {
    return this.out;
  }
}

describe.skipIf(!url)("execution pipeline (Postgres + fakes)", () => {
  let db: Db;
  let chain: FakeChain;
  let wallet: FakeWallet;
  let backend: FakeBackend;
  let market: FakeMarket;
  let d: ExecDeps;
  let clock = 0;

  const cfg: ExecConfig = {
    liveTrading: true,
    maxGiftUsd: 20,
    maxQuoteDriftPct: 1,
    slippagePct: 1,
    giftExpiryDays: 30,
    waitMs: 1_000,
    pollMs: 100,
    usdt: { address: USDT, decimals: 18 },
  };

  beforeAll(async () => {
    db = await freshTestDb(url!, "test_execution");
  });
  afterAll(async () => {
    await db?.end();
  });

  beforeEach(() => {
    chain = new FakeChain();
    wallet = new FakeWallet(chain);
    backend = new FakeBackend(chain);
    market = new FakeMarket();
    const sleep = async (ms: number) => {
      clock += ms;
    };
    const now = () => clock;
    d = { db, wallet, chain, market, cfg, sleep, now, vault: createVault(db, backend, { waitMs: 1_000, pollMs: 100, sleep }) };
  });

  async function paidGift(usdCost = 5) {
    const { gift, claimCode } = await createGift(
      db,
      {
        senderAddress: SENDER,
        senderName: "Paul",
        recipientName: "Ada",
        ticker: "NVDA",
        issuer: "bstock",
        tokenAddress: TOKEN,
        tokenDecimals: 18,
        quotedTokenAmount: QUOTED,
        usdCost,
        feeUsd: 0.1,
        paymentExpiresAt: new Date(Date.now() + 60_000),
      },
      { maxGiftUsd: 20, dailyCapUsd: 1e9 },
    );
    await transition(db, gift.id, "AWAITING_PAYMENT", "PAID", { paymentTx: "0xpay" });
    return { id: gift.id, claimCode };
  }

  const records = async (id: string) =>
    Object.fromEntries((await db.query("SELECT kind, status FROM exec_records WHERE gift_id = $1", [id])).rows.map((r) => [r.kind, r.status]));

  describe("buy", () => {
    it("runs PAID → READY: forward, swap, send to vault, each exactly once", async () => {
      const { id } = await paidGift(5);
      const r = await runBuy(d, id);
      expect(r.status).toBe("READY");
      const g = (await getGift(db, id))!;
      expect(g.status).toBe("READY");
      expect(g.step).toBe("in_vault");
      expect(g.tokenAmount).toBe(QUOTED);
      expect(g.forwardTx).toMatch(/^0xvault0/);
      expect(g.buyTx).toBe("0xswap1");
      expect(g.vaultTx).toBe("0xsend1");
      expect(g.claimExpiresAt).not.toBeNull();
      expect(backend.signed).toEqual([expect.objectContaining({ token: USDT, to: AW, amount: parseUnits("5", 18) })]);
      expect([wallet.swapCalls, wallet.sendCalls]).toEqual([1, 1]);
      expect(await records(id)).toEqual({ forward: "confirmed", swap: "confirmed", vault_send: "confirmed" });
    });

    it("running again after READY does nothing", async () => {
      const { id } = await paidGift();
      await runBuy(d, id);
      expect((await runBuy(d, id)).status).toBe("NOOP");
      expect([backend.signed.length, wallet.swapCalls, wallet.sendCalls]).toEqual([1, 1, 1]);
    });

    it("concurrent runs on one gift move it once", async () => {
      const { id } = await paidGift();
      const results = await Promise.allSettled([runBuy(d, id), runBuy(d, id), runBuy(d, id)]);
      expect(results.some((r) => r.status === "fulfilled" && r.value.status === "READY")).toBe(true);
      expect([backend.signed.length, wallet.swapCalls, wallet.sendCalls]).toEqual([1, 1, 1]);
    });

    it("queues while the Agentic Wallet is signed out, then resumes", async () => {
      const { id } = await paidGift();
      wallet.connected = false;
      expect(await runBuy(d, id)).toMatchObject({ status: "QUEUED" });
      expect((await getGift(db, id))!.status).toBe("PAID");
      expect(backend.signed).toHaveLength(0);
      wallet.connected = true;
      expect((await runBuy(d, id)).status).toBe("READY");
    });

    it("resumes after a crash right after submitting the swap, without swapping twice", async () => {
      const { id } = await paidGift();
      wallet.crashAfterSwap = true;
      await expect(runBuy(d, id)).rejects.toThrow(/crashed/);
      expect((await getGift(db, id))!.step).toBe("forwarded");
      expect((await runBuy(d, id)).status).toBe("READY");
      expect(wallet.swapCalls).toBe(1); // adopted via market-order list
      expect(backend.signed).toHaveLength(1);
    });

    it("resumes after a crash right after sending to the vault, without sending twice", async () => {
      const { id } = await paidGift();
      wallet.crashAfterSend = true;
      await expect(runBuy(d, id)).rejects.toThrow(/crashed/);
      expect((await getGift(db, id))!.step).toBe("swapped");
      expect((await runBuy(d, id)).status).toBe("READY");
      expect(wallet.sendCalls).toBe(1); // adopted via tx-history
    });

    it("returns PENDING while the swap order is processing, then finishes", async () => {
      const { id } = await paidGift();
      wallet.nextOrderStatus = "PENDING";
      expect(await runBuy(d, id)).toMatchObject({ status: "PENDING" });
      const [orderId] = [...wallet.orders.keys()];
      wallet.orders.get(orderId!)!.status = "FINISHED";
      expect((await runBuy(d, id)).status).toBe("READY");
      expect(wallet.swapCalls).toBe(1);
    });

    it("owes only what reached the vault", async () => {
      const { id } = await paidGift();
      const orig = wallet.sendToVault.bind(wallet);
      wallet.sendToVault = async (token, amountHuman) => {
        const h = await orig(token, amountHuman);
        chain.txs.get(h)!.amount -= 1n;
        return h;
      };
      await runBuy(d, id);
      expect((await getGift(db, id))!.tokenAmount).toBe(QUOTED - 1n);
    });
  });

  describe("aborts and refunds", () => {
    it("baw vs Trading API drift above the limit: no money moves, then refund", async () => {
      const { id } = await paidGift(5);
      wallet.quote = (QUOTED * 98n) / 100n; // 2% off the Trading API
      const r = await runBuy(d, id);
      expect(r).toMatchObject({ status: "FAILED", reason: expect.stringContaining("Trading API") });
      expect((await getGift(db, id))!.status).toBe("REFUNDING");
      expect(backend.signed).toHaveLength(0);
      expect((await refundGift(d, id)).status).toBe("REFUNDED");
      expect(backend.signed).toEqual([expect.objectContaining({ token: USDT, to: SENDER, amount: parseUnits("5.1", 18) })]);
      expect(wallet.sendCalls).toBe(0); // nothing to sweep
    });

    it("price moved against the sender's quote: refund", async () => {
      const { id } = await paidGift();
      wallet.quote = market.out = (QUOTED * 97n) / 100n;
      expect(await runBuy(d, id)).toMatchObject({ status: "FAILED", reason: expect.stringContaining("fewer tokens") });
    });

    it("a better price than quoted is fine", async () => {
      const { id } = await paidGift();
      wallet.quote = market.out = (QUOTED * 105n) / 100n;
      expect((await runBuy(d, id)).status).toBe("READY");
    });

    it("failed swap after forwarding: FAILED, USDT swept back, then refunded", async () => {
      const { id } = await paidGift(5);
      wallet.nextOrderStatus = "FAILED";
      expect(await runBuy(d, id)).toMatchObject({ status: "FAILED" });
      expect((await getGift(db, id))!.status).toBe("FAILED");
      const r = await refundGift(d, id);
      expect(r.status).toBe("REFUNDED");
      expect(wallet.sends).toEqual([expect.objectContaining({ token: USDT })]); // sweep
      expect(backend.signed.map((s) => s.to)).toEqual([AW, SENDER]); // forward, refund
      expect(await records(id)).toMatchObject({ forward: "confirmed", swap: "failed", sweep: "confirmed", refund: "confirmed" });
    });

    it("refund waits for sign-in if forwarded USDT is in the Agentic Wallet", async () => {
      const { id } = await paidGift();
      wallet.nextOrderStatus = "FAILED";
      await runBuy(d, id);
      wallet.connected = false;
      expect(await refundGift(d, id)).toMatchObject({ status: "QUEUED" });
      wallet.connected = true;
      expect((await refundGift(d, id)).status).toBe("REFUNDED");
    });

    it("re-checks MAX_GIFT_USD before moving money", async () => {
      const { id } = await paidGift(15);
      const r = await runBuy({ ...d, cfg: { ...cfg, maxGiftUsd: 10 } }, id);
      expect(r).toMatchObject({ status: "FAILED", reason: expect.stringContaining("MAX_GIFT_USD") });
      expect(backend.signed).toHaveLength(0);
    });

    it("refuses a live gift in dry-run mode and vice versa", async () => {
      const { id } = await paidGift();
      await expect(runBuy({ ...d, cfg: { ...cfg, liveTrading: false } }, id)).rejects.toThrow(/LIVE_TRADING/);
    });
  });

  describe("vault payouts", () => {
    async function claimingGift() {
      const { id, claimCode } = await paidGift();
      await runBuy(d, id);
      const to = `0x${randomUUID().replace(/-/g, "")}00000000`;
      const r = await beginClaim(db, { giftId: id, code: claimCode, claimAddress: to, ip: randomUUID() });
      expect(r.ok).toBe(true);
      return { id, to };
    }

    it("pays a claim and records the claim tx", async () => {
      const { id, to } = await claimingGift();
      const r = await payoutClaim(d, id);
      expect(r.status).toBe("CLAIMED");
      const g = (await getGift(db, id))!;
      expect(g.claimTx).toBe(backend.signed[1]!.hash);
      expect(backend.signed[1]).toMatchObject({ token: TOKEN, to: expect.stringMatching(new RegExp(to.slice(2), "i")), amount: QUOTED });
    });

    it("a failed simulation releases the claim and signs nothing", async () => {
      const { id } = await claimingGift();
      backend.simulateOk = false;
      expect(await payoutClaim(d, id)).toMatchObject({ status: "RELEASED", reason: expect.stringContaining("blocked") });
      const g = (await getGift(db, id))!;
      expect([g.status, g.claimAddress, g.claimTx]).toEqual(["READY", null, null]);
      expect(backend.signed).toHaveLength(1); // only the forward
    });

    it("concurrent payouts of one claim sign one tx", async () => {
      const { id } = await claimingGift();
      await Promise.allSettled([payoutClaim(d, id), payoutClaim(d, id), payoutClaim(d, id)]);
      expect(backend.signed).toHaveLength(2); // forward + one claim
      expect((await getGift(db, id))!.status).toBe("CLAIMED");
    });

    it("an unconfirmed payout is rebroadcast as the same tx, never re-signed", async () => {
      const { id } = await claimingGift();
      backend.confirmImmediately = false;
      expect(await payoutClaim(d, id)).toMatchObject({ status: "PENDING" });
      const g = (await getGift(db, id))!;
      expect(g.status).toBe("CLAIMING");
      expect(g.claimTx).not.toBeNull();
      const claimTx = backend.signed[1]!;
      chain.txs.set(claimTx.hash, { state: "success", token: claimTx.token, to: claimTx.to, amount: claimTx.amount });
      expect((await payoutClaim(d, id)).status).toBe("CLAIMED");
      expect(backend.signed).toHaveLength(2);
      expect(backend.broadcasts.filter((b) => b === `raw:${claimTx.hash}`).length).toBeGreaterThanOrEqual(2);
    });

    it("returns an unclaimed gift to the sender", async () => {
      const { id } = await paidGift();
      await runBuy(d, id);
      const r = await returnGift(d, id);
      expect(r.status).toBe("RETURNED");
      expect(backend.signed[1]).toMatchObject({ token: TOKEN, to: SENDER, amount: QUOTED });
      expect((await getGift(db, id))!.returnTx).toBe(backend.signed[1]!.hash);
    });

    it("no gas: nothing is signed or recorded", async () => {
      const { id } = await paidGift();
      backend.gas = false;
      await expect(runBuy(d, id)).rejects.toBeInstanceOf(NeedsGasError);
      expect(backend.signed).toHaveLength(0);
      expect(await records(id)).toEqual({});
      expect((await getGift(db, id))!.step).toBeNull();
    });

    it("vault nonces never repeat across concurrent transfers", async () => {
      const ids = await Promise.all([paidGift(), paidGift(), paidGift()]);
      backend.confirmImmediately = false;
      await Promise.allSettled(ids.map((g) => runBuy(d, g.id)));
      const nonces = (await db.query("SELECT nonce FROM exec_records WHERE kind = 'forward' AND gift_id = ANY($1)", [ids.map((g) => g.id)])).rows.map((r) => r.nonce);
      expect(new Set(nonces).size).toBe(3);
    });
  });
});
