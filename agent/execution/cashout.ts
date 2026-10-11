// Pay out a gift as USDT instead of stock: to the sender on a return (gift.returnAs = "usdt"), or to the recipient
// on a claim (gift.claimAs = "usdt").
//
//   vault ──stock──► Agentic Wallet ──baw sell──► USDT ──baw send──► vault ──USDT──► sender or recipient
//   (to_wallet)         (sell)                    (proceeds)          (cashout)
//
// Every step is recorded before its side effect and resumes where it stopped. If selling isn't possible, the
// payee still gets the stock, so the choice can never leave a gift stuck:
//   - before anything moves: a return waits up to RETURN_WAIT_MS (market closed, wallet signed out, no quote); a claim
//     doesn't wait (the recipient is on the page), it pays the shares right away
//   - after the stock reached the Agentic Wallet and the sell is refused: send it back to the vault (unwind), then pay the stock
import { formatUnits } from "viem";
import type { Db } from "../db/pool.js";
import { completeClaim, recordTx, transition, type Gift } from "../gifts/ledger.js";
import { BawError } from "../baw/cli.js";
import { StillPendingError, type AgenticWalletPort } from "./ports.js";
import { awSendOnce, driftBps, getRecord, startRecord, updateRecord, waitTransfer, type ExecDeps, type ExecOutcome } from "./buy.js";

export const RETURN_WAIT_MS = 24 * 3_600_000;

const defaultSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function returningSince(db: Db, giftId: string): Promise<number | null> {
  const { rows } = await db.query<{ at: Date }>("SELECT at FROM gift_events WHERE gift_id = $1 AND to_status = 'RETURNING' ORDER BY at DESC LIMIT 1", [giftId]);
  return rows[0] ? rows[0].at.getTime() : null;
}

async function note(db: Db, giftId: string, text: string) {
  await db.query("UPDATE gifts SET failure_reason = $2, updated_at = now() WHERE id = $1", [giftId, text.slice(0, 300)]);
}

/** Why a sell can't go ahead right now, or null. Compares the baw quote with the Trading API (drift check). */
async function sellBlocker(d: ExecDeps, g: Gift, amountHuman: string): Promise<string | null> {
  let bawOut: bigint;
  let apiOut: bigint;
  try {
    [bawOut, apiOut] = await Promise.all([d.wallet.quoteSellOut(g.tokenAddress, amountHuman), d.market.apiSellQuoteOut(g.tokenAddress, g.tokenAmount!)]);
  } catch (e) {
    return `no sell quote available (${(e as Error).message})`;
  }
  if (bawOut <= 0n) return "the sell quote is zero";
  const maxBps = BigInt(Math.round(d.cfg.maxQuoteDriftPct * 100));
  const drift = driftBps(bawOut, apiOut);
  if (drift > maxBps) return `sell quotes disagree by ${Number(drift) / 100}% (max ${d.cfg.maxQuoteDriftPct}%)`;
  return null;
}

/** Who gets paid and how the gift finishes. */
interface SellPlan {
  /** Receives the USDT, or the stock when it can't be sold. */
  to: string;
  /** Vault transfer kind for paying the stock after an unwind. */
  stockKind: "return" | "claim";
  /** How long to keep trying before anything has moved, before paying the stock instead. */
  waitMs: number;
  /** Wall-clock time the payout started (ms). */
  startedAt: number;
  /** Pays the stock when nothing has moved yet. */
  payStock: () => Promise<ExecOutcome>;
  finish: (txHash: string) => Promise<ExecOutcome>;
  /** Runs after a payout tx is recorded and before it's broadcast. */
  onSigned?: (txHash: string) => Promise<void>;
  /** "returned as stock" / "sent as shares": completes the note shown to the user. */
  stockWords: string;
}

export async function returnAsUsdt(d: ExecDeps, g: Gift, returnStock: () => Promise<ExecOutcome>): Promise<ExecOutcome> {
  return sellAndPay(d, g, {
    to: g.senderAddress,
    stockKind: "return",
    waitMs: RETURN_WAIT_MS,
    // Wall-clock age (the event time comes from the database), not the injectable polling clock.
    startedAt: (await returningSince(d.db, g.id)) ?? Date.now(),
    payStock: returnStock,
    finish: async (txHash) => ({ status: "RETURNED", gift: await transition(d.db, g.id, "RETURNING", "RETURNED", { returnTx: txHash }) }),
    stockWords: "it was returned as stock instead",
  });
}

/** The recipient chose USDT: sell the shares and pay them the proceeds, or send the shares if they can't be sold now. */
export async function claimAsUsdt(d: ExecDeps, g: Gift, claimStock: () => Promise<ExecOutcome>): Promise<ExecOutcome> {
  const record = (hash: string) => recordTx(d.db, g.id, "CLAIMING", "claimTx", hash);
  return sellAndPay(d, g, {
    to: g.claimAddress!,
    stockKind: "claim",
    waitMs: 0,
    startedAt: Date.now(),
    payStock: claimStock,
    finish: async (txHash) => ({ status: "CLAIMED", gift: await completeClaim(d.db, g.id, txHash) }),
    onSigned: record,
    stockWords: "you got the shares instead",
  });
}

async function sellAndPay(d: ExecDeps, g: Gift, plan: SellPlan): Promise<ExecOutcome> {
  const amount = g.tokenAmount!;
  const amountHuman = formatUnits(amount, g.tokenDecimals);
  const usdt = d.cfg.usdt;
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? defaultSleep;

  const toWallet = await getRecord(d.db, g.id, "to_wallet");
  const finish = plan.finish;

  // ---- Before anything has moved: can we sell? Otherwise wait, and eventually fall back to the stock. ----
  if (!toWallet) {
    const waited = Date.now() - plan.startedAt;
    let blocker: string | null = null;
    if (!(await d.wallet.isConnected())) blocker = "the trading wallet is signed out";
    else blocker = await sellBlocker(d, g, amountHuman);
    if (blocker) {
      if (waited < plan.waitMs) return { status: "PENDING", reason: `can't sell yet: ${blocker}` };
      await note(d.db, g.id, `Couldn't sell the stock (${blocker}), so ${plan.stockWords}.`);
      return plan.payStock();
    }
  }

  // Nothing below may be abandoned half-way: from here on the stock is in (or on its way to) the Agentic Wallet.
  try {
    // 1. Vault → Agentic Wallet
    await d.vault.transfer({ giftId: g.id, kind: "to_wallet", token: g.tokenAddress, to: d.wallet.address, amount });

    const unwindStarted = await getRecord(d.db, g.id, "unwind");
    let sell = await getRecord(d.db, g.id, "sell");
    if (!unwindStarted && sell?.status !== "failed") {
      // 2. Sell
      if (!(await d.wallet.isConnected())) return { status: "QUEUED", reason: "Agentic Wallet signed out: the stock waits there to be sold" };
      let orderId = sell?.ref ?? null;
      if (!sell) {
        if (await startRecord(d.db, g.id, "sell", g.dryRun)) {
          try {
            orderId = await d.wallet.submitSell(g.tokenAddress, amountHuman, d.cfg.slippagePct);
          } catch (e) {
            if (e instanceof BawError && e.kind === "cli" && !e.isSessionError) {
              await updateRecord(d.db, g.id, "sell", { status: "failed", detail: { error: e.message } });
              await note(d.db, g.id, `The sale was refused (${e.message}), so ${plan.stockWords}.`);
              return unwind(d, g, amountHuman, plan);
            }
            throw e;
          }
          await updateRecord(d.db, g.id, "sell", { ref: orderId, status: "submitted" });
        } else sell = await getRecord(d.db, g.id, "sell");
      }
      if (!orderId && sell) {
        if (sell.status === "failed") return unwind(d, g, amountHuman, plan);
        orderId = (await d.wallet.findSellSince(g.tokenAddress, sell.started_at - 60_000)) ?? (await d.wallet.submitSell(g.tokenAddress, amountHuman, d.cfg.slippagePct));
        await updateRecord(d.db, g.id, "sell", { ref: orderId, status: "submitted" });
      }

      // Poll to a terminal state: an orderId is not a completed sale.
      const deadline = now() + d.cfg.waitMs;
      // The id the CLI returned can differ from the one `market-order list` knows (seen live on buys). When the saved
      // id isn't found, adopt the matching sell by token and time instead of polling a ghost forever.
      const sinceMs = (sell?.started_at ?? now()) - 10_000;
      const { id: giftId, tokenAddress } = g;
      const lookup = async () => {
        let o = await d.wallet.getOrder(orderId!);
        if (!o) {
          const adopted = await d.wallet.findSellSince(tokenAddress, sinceMs);
          if (adopted && adopted !== orderId) {
            orderId = adopted;
            await updateRecord(d.db, giftId, "sell", { ref: orderId, status: "submitted" });
            o = await d.wallet.getOrder(orderId);
          }
        }
        return o;
      };
      let order = await lookup();
      while (!order || order.status === "PENDING") {
        if (now() >= deadline) return { status: "PENDING", reason: `sell order ${orderId} still processing` };
        await sleep(d.cfg.pollMs);
        order = await lookup();
      }
      if (order.status === "FAILED" || !order.txHash) {
        await updateRecord(d.db, g.id, "sell", { status: "failed" });
        await note(d.db, g.id, `The sale didn't go through, so ${plan.stockWords}.`);
        return unwind(d, g, amountHuman, plan);
      }
      const received = await waitTransfer(d, order.txHash, usdt.address, d.wallet.address);
      if (received === null) return { status: "PENDING", reason: `sell tx ${order.txHash} not confirmed yet` };
      if (received === 0n) throw new Error(`sell tx ${order.txHash} delivered no USDT to the Agentic Wallet`);
      await updateRecord(d.db, g.id, "sell", { status: "confirmed", amount: received });
      sell = await getRecord(d.db, g.id, "sell");
    } else {
      return unwind(d, g, amountHuman, plan);
    }

    // 3. Proceeds → vault
    const received = BigInt(sell!.amount ?? "0");
    const hash = await awSendOnce(d, g, "proceeds", usdt.address, formatUnits(received, usdt.decimals));
    const arrived = await waitTransfer(d, hash, usdt.address, d.vault.address);
    if (arrived === null) return { status: "PENDING", reason: `USDT send to vault ${hash} not confirmed yet` };
    if (arrived === 0n) throw new Error(`proceeds tx ${hash} delivered nothing to the vault`);
    await updateRecord(d.db, g.id, "proceeds", { status: "confirmed", amount: arrived });

    // 4. Vault → payee, exactly what arrived
    const paid = await d.vault.transfer({ giftId: g.id, kind: "cashout", token: usdt.address, to: plan.to, amount: arrived }, plan.onSigned);
    return finish(paid.txHash);
  } catch (e) {
    if (e instanceof StillPendingError) return { status: "PENDING", reason: e.message };
    if (e instanceof BawError && e.isSessionError) return { status: "QUEUED", reason: e.message };
    throw e; // stays RETURNING; the next run resumes
  }
}

/** The sale was refused after the stock reached the Agentic Wallet: send it back to the vault, then pay it as stock. */
async function unwind(d: ExecDeps, g: Gift, amountHuman: string, plan: SellPlan): Promise<ExecOutcome> {
  if (!(await d.wallet.isConnected())) return { status: "QUEUED", reason: "Agentic Wallet signed out: the unsold stock waits there to be sent back" };
  const hash = await awSendOnce(d, g, "unwind", g.tokenAddress, amountHuman);
  const back = await waitTransfer(d, hash, g.tokenAddress, d.vault.address);
  if (back === null) return { status: "PENDING", reason: `unsold stock send to vault ${hash} not confirmed yet` };
  if (back === 0n) throw new Error(`unwind tx ${hash} delivered nothing to the vault`);
  await updateRecord(d.db, g.id, "unwind", { status: "confirmed", amount: back });
  const r = await d.vault.transfer({ giftId: g.id, kind: plan.stockKind, token: g.tokenAddress, to: plan.to, amount: back < g.tokenAmount! ? back : g.tokenAmount! }, plan.onSigned);
  return plan.finish(r.txHash);
}

export type { AgenticWalletPort };
