// Vault payouts: claims, returns and refunds. They only need the vault (no Binance session), so they keep
// working while the Agentic Wallet is signed out, except sweeping USDT stuck in the Agentic Wallet.
import { formatUnits } from "viem";
import { completeClaim, getGift, recordTx, releaseClaim, transition, type Gift } from "../gifts/ledger.js";
import { BawError } from "../baw/cli.js";
import { SimulationFailedError, StillPendingError } from "./ports.js";
import { awSendOnce, usdRaw, waitTransfer, type ExecDeps, type ExecOutcome } from "./buy.js";
import { claimAsUsdt, returnAsUsdt } from "./cashout.js";
import { unpool } from "../gifts/groups.js";

async function load(d: ExecDeps, id: string): Promise<Gift> {
  const g = await getGift(d.db, id);
  if (!g) throw new Error(`Gift ${id} not found`);
  if (g.dryRun === d.cfg.liveTrading) throw new Error(`Gift ${id} is ${g.dryRun ? "a dry run" : "live"} but LIVE_TRADING=${d.cfg.liveTrading}`);
  return g;
}

/**
 * Pays out a gift in CLAIMING to its claim address: the shares, or (the recipient's choice) USDT from selling them.
 * A failed simulation releases the claim (back to READY), but only while nothing has moved.
 */
export async function payoutClaim(d: ExecDeps, id: string): Promise<ExecOutcome> {
  const g = await load(d, id);
  if (g.status !== "CLAIMING") return { status: "NOOP", gift: g };
  const claimStock = async (): Promise<ExecOutcome> => {
    const r = await d.vault.transfer(
      { giftId: g.id, kind: "claim", token: g.tokenAddress, to: g.claimAddress!, amount: g.tokenAmount! },
      // Recorded before broadcast: from here on the claim can't be released.
      (hash) => recordTx(d.db, g.id, "CLAIMING", "claimTx", hash),
    );
    return { status: "CLAIMED", gift: await completeClaim(d.db, g.id, r.txHash) };
  };
  try {
    return g.claimAs === "usdt" ? await claimAsUsdt(d, g, claimStock) : await claimStock();
  } catch (e) {
    if (e instanceof SimulationFailedError) {
      // Once the stock has left the vault for a sale, the claim must finish where it is.
      const moved = await d.db.query("SELECT 1 FROM exec_records WHERE gift_id = $1 AND kind = 'to_wallet'", [g.id]);
      if (moved.rowCount) return { status: "PENDING", reason: `payout simulation failed after the sale started: ${e.reason}` };
      return { status: "RELEASED", reason: e.reason, gift: await releaseClaim(d.db, g.id, e.reason) };
    }
    if (e instanceof StillPendingError) return { status: "PENDING", reason: e.message };
    if (e instanceof BawError && e.isSessionError) return { status: "QUEUED", reason: e.message };
    throw e;
  }
}

/** Returns an unclaimed gift to the sender: as stock, or (the sender's choice) sold into USDT. */
export async function returnGift(d: ExecDeps, id: string): Promise<ExecOutcome> {
  let g = await load(d, id);
  if (g.status === "READY") g = await transition(d.db, g.id, "READY", "RETURNING");
  if (g.status !== "RETURNING") return { status: "NOOP", gift: g };
  try {
    const returnStock = async (): Promise<ExecOutcome> => {
      const r = await d.vault.transfer({ giftId: g.id, kind: "return", token: g.tokenAddress, to: g.senderAddress, amount: g.tokenAmount! });
      return { status: "RETURNED", gift: await transition(d.db, g.id, "RETURNING", "RETURNED", { returnTx: r.txHash }) };
    };
    return g.returnAs === "usdt" ? await returnAsUsdt(d, g, returnStock) : await returnStock();
  } catch (e) {
    if (e instanceof StillPendingError) return { status: "PENDING", reason: e.message };
    throw e; // stays RETURNING; retried by the expiry job
  }
}

/**
 * Refunds gift + fee in USDT to the sender, for gifts that were paid but never became READY.
 * USDT already forwarded to the Agentic Wallet is swept back to the vault first.
 */
export async function refundGift(d: ExecDeps, id: string): Promise<ExecOutcome> {
  let g = await load(d, id);
  if (g.status === "PAID") g = await transition(d.db, g.id, "PAID", "REFUNDING");
  else if (g.status === "FAILED") g = await transition(d.db, g.id, "FAILED", "REFUNDING");
  if (g.status !== "REFUNDING") return { status: "NOOP", gift: g };

  try {
    const recs = await d.db.query<{ kind: string; status: string }>("SELECT kind, status FROM exec_records WHERE gift_id = $1", [g.id]);
    const st = (k: string) => recs.rows.find((r) => r.kind === k)?.status;
    const forwarded = st("forward") === "confirmed";
    const swapped = st("swap") === "confirmed";
    if (swapped) throw new Error(`Gift ${g.id} was swapped; refunding it needs manual review`);

    if (forwarded && st("sweep") !== "confirmed") {
      if (!(await d.wallet.isConnected())) return { status: "QUEUED", reason: "Agentic Wallet signed out: forwarded USDT waits there" };
      const amount = usdRaw(g.usdCost, d.cfg.usdt.decimals);
      const hash = await awSendOnce(d, g, "sweep", d.cfg.usdt.address, formatUnits(amount, d.cfg.usdt.decimals));
      const arrived = await waitTransfer(d, hash, d.cfg.usdt.address, d.vault.address);
      if (arrived === null) return { status: "PENDING", reason: `sweep ${hash} not confirmed yet` };
      await d.db.query("UPDATE exec_records SET status = 'confirmed', amount = $3, updated_at = now() WHERE gift_id = $1 AND kind = $2", [g.id, "sweep", arrived.toString()]);
    }

    // A group's pooled gift was paid by its contributions: refund each one to its own payer, not the organizer.
    if (g.groupRole === "pool") {
      const u = await unpool(d.db, g, g.failureReason ?? "not bought");
      for (const cid of u.refunding) await refundGift(d, cid).catch((e) => console.error(`gift ${cid}: refund failed: ${(e as Error).message}`));
      return { status: "REFUNDED", gift: u.gift };
    }

    const r = await d.vault.transfer({ giftId: g.id, kind: "refund", token: d.cfg.usdt.address, to: g.senderAddress, amount: usdRaw(g.usdCost + g.feeUsd, d.cfg.usdt.decimals) });
    return { status: "REFUNDED", gift: await transition(d.db, g.id, "REFUNDING", "REFUNDED", { refundTx: r.txHash }) };
  } catch (e) {
    if (e instanceof StillPendingError) return { status: "PENDING", reason: e.message };
    if (e instanceof BawError && e.isSessionError) return { status: "QUEUED", reason: e.message };
    throw e; // stays REFUNDING
  }
}
