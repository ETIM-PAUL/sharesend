// Vault payouts: claims, returns and refunds. They only need the vault (no Binance session), so they keep
// working while the Agentic Wallet is signed out, except sweeping USDT stuck in the Agentic Wallet.
import { formatUnits } from "viem";
import { completeClaim, getGift, recordTx, releaseClaim, transition, type Gift } from "../gifts/ledger.js";
import { BawError } from "../baw/cli.js";
import { SimulationFailedError, StillPendingError } from "./ports.js";
import { awSendOnce, usdRaw, waitTransfer, type ExecDeps, type ExecOutcome } from "./buy.js";

async function load(d: ExecDeps, id: string): Promise<Gift> {
  const g = await getGift(d.db, id);
  if (!g) throw new Error(`Gift ${id} not found`);
  if (g.dryRun === d.cfg.liveTrading) throw new Error(`Gift ${id} is ${g.dryRun ? "a dry run" : "live"} but LIVE_TRADING=${d.cfg.liveTrading}`);
  return g;
}

/** Pays out a gift in CLAIMING to its claim address. A failed simulation releases the claim (back to READY). */
export async function payoutClaim(d: ExecDeps, id: string): Promise<ExecOutcome> {
  const g = await load(d, id);
  if (g.status !== "CLAIMING") return { status: "NOOP", gift: g };
  try {
    const r = await d.vault.transfer(
      { giftId: g.id, kind: "claim", token: g.tokenAddress, to: g.claimAddress!, amount: g.tokenAmount! },
      // Recorded before broadcast: from here on the claim can't be released.
      (hash) => recordTx(d.db, g.id, "CLAIMING", "claimTx", hash),
    );
    return { status: "CLAIMED", gift: await completeClaim(d.db, g.id, r.txHash) };
  } catch (e) {
    if (e instanceof SimulationFailedError) return { status: "RELEASED", reason: e.reason, gift: await releaseClaim(d.db, g.id, e.reason) };
    if (e instanceof StillPendingError) return { status: "PENDING", reason: e.message };
    throw e;
  }
}

/** Returns an unclaimed gift's stock to the sender (sender cancelled, or the claim window ended). */
export async function returnGift(d: ExecDeps, id: string): Promise<ExecOutcome> {
  let g = await load(d, id);
  if (g.status === "READY") g = await transition(d.db, g.id, "READY", "RETURNING");
  if (g.status !== "RETURNING") return { status: "NOOP", gift: g };
  try {
    const r = await d.vault.transfer({ giftId: g.id, kind: "return", token: g.tokenAddress, to: g.senderAddress, amount: g.tokenAmount! });
    return { status: "RETURNED", gift: await transition(d.db, g.id, "RETURNING", "RETURNED", { returnTx: r.txHash }) };
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

    const r = await d.vault.transfer({ giftId: g.id, kind: "refund", token: d.cfg.usdt.address, to: g.senderAddress, amount: usdRaw(g.usdCost + g.feeUsd, d.cfg.usdt.decimals) });
    return { status: "REFUNDED", gift: await transition(d.db, g.id, "REFUNDING", "REFUNDED", { refundTx: r.txHash }) };
  } catch (e) {
    if (e instanceof StillPendingError) return { status: "PENDING", reason: e.message };
    if (e instanceof BawError && e.isSessionError) return { status: "QUEUED", reason: e.message };
    throw e; // stays REFUNDING
  }
}
