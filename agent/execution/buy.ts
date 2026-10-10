// Buy pipeline (BUILD_PLAN.md Phase 6). Each step is recorded before its side effect and is resumable:
//   (no step) ─forward USDT vault→Agentic Wallet─► forwarded ─baw swap─► swapped ─baw send to vault─► in_vault ─► READY
// Before the swap completes, a bad quote or failed swap moves the gift to FAILED (then refund).
// After the swap, the gift never fails automatically: the stock exists and the send is retried.
import { formatUnits, parseUnits } from "viem";
import type { Db } from "../db/pool.js";
import { advanceStep, getGift, transition, type Gift } from "../gifts/ledger.js";
import { BawError } from "../baw/cli.js";
import { decideOrder, hasWaitingOrder, markTriggered, recordPrice } from "./order.js";
import { StillPendingError, type AgenticWalletPort, type ChainPort, type ExecKind, type MarketPort, type VaultPort } from "./ports.js";

export interface ExecConfig {
  liveTrading: boolean;
  maxGiftUsd: number;
  maxQuoteDriftPct: number;
  slippagePct: number;
  giftExpiryDays: number;
  /** How long to wait for a swap or send to land before returning PENDING. */
  waitMs: number;
  pollMs: number;
  usdt: { address: string; decimals: number };
}

export interface ExecDeps {
  db: Db;
  wallet: AgenticWalletPort;
  vault: VaultPort;
  chain: ChainPort;
  market: MarketPort;
  cfg: ExecConfig;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Wall-clock time (ms) for deadlines, separate from the polling clock above. Defaults to Date.now. */
  wall?: () => number;
}

export type ExecOutcome =
  | { status: "READY" | "REFUNDED" | "RETURNED" | "CLAIMED"; gift: Gift }
  | { status: "QUEUED"; reason: string } // Agentic Wallet signed out: resumes after sign-in
  | { status: "PENDING"; reason: string } // waiting for a tx/order: run again later
  | { status: "FAILED"; reason: string; gift: Gift } // buy aborted before the swap: refund next
  | { status: "RELEASED"; reason: string; gift: Gift } // claim simulation failed: gift back to READY
  | { status: "WAITING"; reason: string } // a conditional order whose price hasn't been reached yet
  | { status: "NOOP"; gift: Gift };

/** Abort before the swap completed: safe to refund. */
class AbortBuy extends Error {}

const defaultSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const usdQty = (usd: number) => usd.toFixed(2);
export const usdRaw = (usd: number, decimals: number) => parseUnits(usd.toFixed(2), decimals);

/** Basis-point distance between two amounts, relative to `ref`. */
function driftBps(a: bigint, ref: bigint): bigint {
  if (ref === 0n) return 10_000n;
  return ((a > ref ? a - ref : ref - a) * 10_000n) / ref;
}

/**
 * Cross-checks the baw quote against the Trading API quote and against what the sender was quoted.
 * Returns a reason to abort, or null.
 */
export async function checkQuoteDrift(d: ExecDeps, g: Gift): Promise<string | null> {
  const maxBps = BigInt(Math.round(d.cfg.maxQuoteDriftPct * 100));
  const [bawOut, apiOut] = await Promise.all([d.wallet.quoteOut(g.tokenAddress, g.tokenDecimals, usdQty(g.usdCost)), d.market.apiQuoteOut(g.tokenAddress, g.usdCost)]);
  const vsApi = driftBps(bawOut, apiOut);
  if (vsApi > maxBps) return `baw quote differs from Trading API quote by ${Number(vsApi) / 100}% (max ${d.cfg.maxQuoteDriftPct}%)`;
  // Worse than quoted to the sender by more than the drift limit. Better is fine.
  if (bawOut < g.quotedTokenAmount && driftBps(bawOut, g.quotedTokenAmount) > maxBps)
    return `price moved: would receive ${Number(driftBps(bawOut, g.quotedTokenAmount)) / 100}% fewer tokens than quoted`;
  return null;
}

// ---- exec_records helpers for Agentic Wallet steps ----

export type AwKind = ExecKind;
export interface AwRecord {
  ref: string | null;
  status: string;
  amount: string | null;
  started_at: number;
}

export async function getRecord(db: Db, giftId: string, kind: AwKind): Promise<AwRecord | null> {
  const { rows } = await db.query<AwRecord>(
    "SELECT ref, status, amount, (extract(epoch FROM created_at) * 1000)::bigint AS started_at FROM exec_records WHERE gift_id = $1 AND kind = $2",
    [giftId, kind],
  );
  const r = rows[0];
  return r ? { ...r, started_at: Number(r.started_at) } : null;
}

export async function startRecord(db: Db, giftId: string, kind: AwKind, dryRun: boolean): Promise<boolean> {
  const r = await db.query("INSERT INTO exec_records (gift_id, kind, status, dry_run) VALUES ($1, $2, 'started', $3) ON CONFLICT DO NOTHING", [giftId, kind, dryRun]);
  return (r.rowCount ?? 0) > 0;
}

export async function updateRecord(db: Db, giftId: string, kind: AwKind, f: { ref?: string; status?: string; amount?: bigint; detail?: unknown }) {
  await db.query(
    `UPDATE exec_records SET ref = coalesce($3, ref), status = coalesce($4, status), amount = coalesce($5, amount),
       detail = coalesce($6, detail), updated_at = now() WHERE gift_id = $1 AND kind = $2`,
    [giftId, kind, f.ref ?? null, f.status ?? null, f.amount?.toString() ?? null, f.detail === undefined ? null : JSON.stringify(f.detail)],
  );
}

/** Polls until the tx moved `token` to `to`, or returns null when still pending after waitMs. */
async function waitTransfer(d: ExecDeps, txHash: string, token: string, to: string): Promise<bigint | null> {
  const sleep = d.sleep ?? defaultSleep;
  const deadline = (d.now ?? Date.now)() + d.cfg.waitMs;
  for (;;) {
    const r = await d.chain.transferIn(txHash, token, to);
    if (r.state === "success") return r.amount;
    if (r.state === "reverted") throw new Error(`tx ${txHash} reverted`);
    if ((d.now ?? Date.now)() >= deadline) return null;
    await sleep(d.cfg.pollMs);
  }
}

/** Sends `amountHuman` of `token` from the Agentic Wallet to the vault, once per (gift, kind). Returns the tx hash. */
async function awSendOnce(d: ExecDeps, g: Gift, kind: "vault_send" | "sweep" | "proceeds" | "unwind", token: string, amountHuman: string): Promise<string> {
  let rec = await getRecord(d.db, g.id, kind);
  if (!rec) {
    if (!(await startRecord(d.db, g.id, kind, g.dryRun))) rec = await getRecord(d.db, g.id, kind);
    else {
      const hash = await d.wallet.sendToVault(token, amountHuman);
      await updateRecord(d.db, g.id, kind, { ref: hash, status: "submitted" });
      return hash;
    }
  }
  if (rec!.ref) return rec!.ref;
  // Crashed between submit and record: adopt the send if baw shows one, else send now.
  const adopted = await d.wallet.findSendSince(token, rec!.started_at - 60_000);
  const hash = adopted ?? (await d.wallet.sendToVault(token, amountHuman));
  await updateRecord(d.db, g.id, kind, { ref: hash, status: "submitted", detail: adopted ? { adopted: true } : undefined });
  return hash;
}

// ---- The pipeline ----

export async function runBuy(d: ExecDeps, giftId: string): Promise<ExecOutcome> {
  let g = await getGift(d.db, giftId);
  if (!g) throw new Error(`Gift ${giftId} not found`);
  if (g.dryRun === d.cfg.liveTrading) throw new Error(`Gift ${giftId} is ${g.dryRun ? "a dry run" : "live"} but LIVE_TRADING=${d.cfg.liveTrading}`);

  if (g.status === "PAID") {
    // Caps are enforced at creation; re-checked here because this is where money moves.
    if (g.usdCost > d.cfg.maxGiftUsd) {
      g = await transition(d.db, g.id, "PAID", "REFUNDING", { failureReason: `over MAX_GIFT_USD (${d.cfg.maxGiftUsd})` });
      return { status: "FAILED", reason: g.failureReason!, gift: g };
    }
    // A conditional order waits here until its price is reached, and refunds at its deadline. None of this needs the
    // Agentic Wallet, so it keeps working (and keeps its deadline) while the wallet is signed out.
    if (hasWaitingOrder(g)) {
      const price = await d.market.pricePerShare(g.tokenAddress, g.usdCost).catch(() => null);
      await recordPrice(d.db, g.id, price);
      const decision = decideOrder(g.order!, price, (d.wall ?? Date.now)());
      if (decision.action === "wait") return { status: "WAITING", reason: decision.reason };
      if (decision.action === "expire") {
        const reason = `Not bought: ${decision.reason}. Your payment is being refunded.`;
        g = await transition(d.db, g.id, "PAID", "REFUNDING", { failureReason: reason });
        return { status: "FAILED", reason, gift: g };
      }
      await markTriggered(d.db, g.id);
    }
    if (!(await d.wallet.isConnected())) return { status: "QUEUED", reason: "Agentic Wallet signed out" };
    const drift = await checkQuoteDrift(d, g);
    if (drift) {
      g = await transition(d.db, g.id, "PAID", "REFUNDING", { failureReason: drift });
      return { status: "FAILED", reason: drift, gift: g };
    }
    g = await transition(d.db, g.id, "PAID", "BUYING");
  }
  if (g.status !== "BUYING") return { status: "NOOP", gift: g };

  try {
    if (g.step === null) {
      if (!(await d.wallet.isConnected())) return { status: "QUEUED", reason: "Agentic Wallet signed out" };
      const fwd = await d.vault.transfer({ giftId: g.id, kind: "forward", token: d.cfg.usdt.address, to: d.wallet.address, amount: usdRaw(g.usdCost, d.cfg.usdt.decimals) });
      g = await advanceStep(d.db, g.id, null, "forwarded", { forwardTx: fwd.txHash });
    }

    if (g.step === "forwarded") {
      if (!(await d.wallet.isConnected())) return { status: "QUEUED", reason: "Agentic Wallet signed out" };
      let rec = await getRecord(d.db, g.id, "swap");
      let orderId = rec?.ref ?? null;
      if (!rec) {
        const drift = await checkQuoteDrift(d, g);
        if (drift) throw new AbortBuy(drift);
        if (await startRecord(d.db, g.id, "swap", g.dryRun)) {
          try {
            orderId = await d.wallet.submitSwap(g.tokenAddress, usdQty(g.usdCost), d.cfg.slippagePct);
          } catch (e) {
            // The CLI refused the order: nothing was submitted.
            if (e instanceof BawError && e.kind === "cli" && !e.isSessionError) {
              await updateRecord(d.db, g.id, "swap", { status: "failed", detail: { error: e.message } });
              throw new AbortBuy(e.message);
            }
            throw e;
          }
          await updateRecord(d.db, g.id, "swap", { ref: orderId, status: "submitted" });
        } else rec = await getRecord(d.db, g.id, "swap");
      }
      if (!orderId && rec) {
        if (rec.status === "failed") throw new AbortBuy("swap was rejected earlier");
        orderId = await d.wallet.findOrderSince(g.tokenAddress, rec.started_at - 60_000);
        if (!orderId) orderId = await d.wallet.submitSwap(g.tokenAddress, usdQty(g.usdCost), d.cfg.slippagePct);
        await updateRecord(d.db, g.id, "swap", { ref: orderId, status: "submitted" });
      }

      // Poll the order to a terminal state: an orderId is not a completed swap.
      const sleep = d.sleep ?? defaultSleep;
      const deadline = (d.now ?? Date.now)() + d.cfg.waitMs;
      // The id the CLI returned can differ from the one `market-order list` knows (seen live). When the saved id
      // isn't found, adopt the matching order by token and time instead of polling a ghost forever.
      const sinceMs = (rec?.started_at ?? (d.now ?? Date.now)()) - 10_000;
      const { id: giftId, tokenAddress } = g;
      const lookup = async () => {
        let o = await d.wallet.getOrder(orderId!);
        if (!o) {
          const adopted = await d.wallet.findOrderSince(tokenAddress, sinceMs);
          if (adopted && adopted !== orderId) {
            orderId = adopted;
            await updateRecord(d.db, giftId, "swap", { ref: orderId, status: "submitted" });
            o = await d.wallet.getOrder(orderId);
          }
        }
        return o;
      };
      let order = await lookup();
      while (!order || order.status === "PENDING") {
        if ((d.now ?? Date.now)() >= deadline) return { status: "PENDING", reason: `swap order ${orderId} still processing` };
        await sleep(d.cfg.pollMs);
        order = await lookup();
      }
      if (order.status === "FAILED" || !order.txHash) {
        await updateRecord(d.db, g.id, "swap", { status: "failed" });
        throw new AbortBuy(`swap order ${orderId} failed`);
      }
      const received = await waitTransfer(d, order.txHash, g.tokenAddress, d.wallet.address);
      if (received === null) return { status: "PENDING", reason: `swap tx ${order.txHash} not confirmed yet` };
      if (received === 0n) throw new Error(`swap tx ${order.txHash} delivered no ${g.tokenAddress} to the Agentic Wallet`);
      await updateRecord(d.db, g.id, "swap", { status: "confirmed", amount: received });
      g = await advanceStep(d.db, g.id, "forwarded", "swapped", { buyTx: order.txHash });
    }

    if (g.step === "swapped") {
      const swapRec = await getRecord(d.db, g.id, "swap");
      const received = BigInt(swapRec?.amount ?? "0");
      if (received === 0n) throw new Error(`gift ${g.id}: swapped but no received amount recorded`);
      if (!(await d.wallet.isConnected())) return { status: "QUEUED", reason: "Agentic Wallet signed out (stock is in the Agentic Wallet)" };
      const hash = await awSendOnce(d, g, "vault_send", g.tokenAddress, formatUnits(received, g.tokenDecimals));
      const arrived = await waitTransfer(d, hash, g.tokenAddress, d.vault.address);
      if (arrived === null) return { status: "PENDING", reason: `send to vault ${hash} not confirmed yet` };
      if (arrived === 0n) throw new Error(`send tx ${hash} delivered nothing to the vault`);
      // Owe the recipient what actually reached the vault (never more than was bought).
      const owed = arrived < received ? arrived : received;
      await updateRecord(d.db, g.id, "vault_send", { status: "confirmed", amount: arrived, detail: arrived !== received ? { received: received.toString(), arrived: arrived.toString() } : undefined });
      g = await advanceStep(d.db, g.id, "swapped", "in_vault", { vaultTx: hash, tokenAmount: owed });
    }

    if (g.step === "in_vault") g = await transition(d.db, g.id, "BUYING", "READY", {}, { claimExpiryDays: d.cfg.giftExpiryDays });
    return { status: "READY", gift: g };
  } catch (e) {
    if (e instanceof AbortBuy) {
      g = await transition(d.db, g.id, "BUYING", "FAILED", { failureReason: e.message });
      return { status: "FAILED", reason: e.message, gift: g };
    }
    if (e instanceof StillPendingError) return { status: "PENDING", reason: e.message };
    if (e instanceof BawError && e.isSessionError) return { status: "QUEUED", reason: e.message };
    throw e; // unexpected: gift stays where it is and the next run resumes
  }
}

export { awSendOnce, waitTransfer, driftBps };
