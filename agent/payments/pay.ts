// Gift payment: check → B402 verify → on-chain balance/allowance check → settle → PAID → claim code.
// B402 verify only checks the signature (it accepts an unfunded payer), so a gift is PAID only after settle.
import { createPublicClient, erc20Abi, http, type Address } from "viem";
import { bsc } from "viem/chains";
import type { Db } from "../db/pool.js";
import { getGift, StaleStateError, transition, type Gift } from "../gifts/ledger.js";
import { generateClaimCode, hashClaimCode } from "../gifts/codes.js";
import { RPC_URL } from "../chain/bsc.js";
import { PERMIT2_ADDRESS, type Facilitator, type PaymentPayload, type PaymentRequirements } from "./b402.js";
import { checkPayload, payloadHash } from "./x402.js";

export interface FundsCheck {
  /** Payer's balance of the asset, and (for Permit2) its allowance to the Permit2 contract. */
  check(asset: string, payer: string, method: string): Promise<{ balance: bigint; allowance: bigint | null }>;
}

export const onchainFunds: FundsCheck = {
  async check(asset, payer, method) {
    const pc = createPublicClient({ chain: bsc, transport: http(RPC_URL, { timeout: 10_000, retryCount: 2 }) });
    const [balance, allowance] = await Promise.all([
      pc.readContract({ address: asset as Address, abi: erc20Abi, functionName: "balanceOf", args: [payer as Address] }),
      method.startsWith("permit2")
        ? pc.readContract({ address: asset as Address, abi: erc20Abi, functionName: "allowance", args: [payer as Address, PERMIT2_ADDRESS] })
        : Promise.resolve(null),
    ]);
    return { balance, allowance };
  },
};

export interface PayDeps {
  db: Db;
  facilitator: Facilitator;
  funds: FundsCheck;
  liveTrading: boolean;
  nowSec?: () => number;
}

export type PayResult =
  | { ok: true; gift: Gift; claimCode: string | null; settleTx: string | null; alreadyPaid: boolean }
  | { ok: false; status: 400 | 402 | 404 | 409 | 410 | 502; error: string; retryable?: boolean };

const fail = (status: 400 | 402 | 404 | 409 | 410 | 502, error: string, retryable = false): PayResult => ({ ok: false, status, error, retryable });

/** Issues the claim code once, right after payment. Returns null if it was already issued. */
async function issueClaimCode(db: Db, giftId: string): Promise<string | null> {
  const code = generateClaimCode();
  const r = await db.query("UPDATE gifts SET claim_code_hash = $2, claim_code_issued = true, updated_at = now() WHERE id = $1 AND status <> 'AWAITING_PAYMENT' AND NOT claim_code_issued", [
    giftId,
    hashClaimCode(code),
  ]);
  return r.rowCount ? code : null;
}

async function recordFee(db: Db, g: Gift, tx: string | null) {
  await db.query("INSERT INTO agent_ledger (kind, usd, gift_id, tx, note, dry_run) VALUES ('fee_income', $1, $2, $3, $4, $5) ON CONFLICT DO NOTHING", [
    g.feeUsd,
    g.id,
    tx ?? `fee:${g.id}`,
    `service fee for ${g.ticker} gift`,
    g.dryRun,
  ]);
}

export async function payForGift(d: PayDeps, giftId: string, payload: PaymentPayload): Promise<PayResult> {
  const now = (d.nowSec ?? (() => Math.floor(Date.now() / 1000)))();
  const gift = await getGift(d.db, giftId);
  if (!gift) return fail(404, "gift not found");
  if (gift.dryRun === d.liveTrading) return fail(409, `gift is ${gift.dryRun ? "a dry run" : "live"} but this server has LIVE_TRADING=${d.liveTrading}`);

  const offered = (gift.paymentRequirements ?? []) as PaymentRequirements[];
  const local = checkPayload(payload, offered, gift.senderAddress, now);
  if (!local.ok) return fail(402, local.error);
  const { requirement, payer } = local;
  const hash = payloadHash(payload);

  // Already paid (e.g. a retry after a lost response): idempotent success, but the code was given out once only.
  const existing = await d.db.query<{ payload_hash: string; status: string; settle_tx: string | null }>("SELECT payload_hash, status, settle_tx FROM payments WHERE gift_id = $1", [giftId]);
  const prev = existing.rows[0];
  if (prev && (prev.status === "settled" || prev.status === "verified_dry_run")) {
    if (prev.payload_hash !== hash) return fail(409, "gift is already paid");
    return { ok: true, gift, claimCode: null, settleTx: prev.settle_tx, alreadyPaid: true };
  }
  if (prev && prev.status === "settling" && prev.payload_hash !== hash) return fail(409, "another payment for this gift is in progress");

  if (gift.status !== "AWAITING_PAYMENT") return fail(409, `gift is ${gift.status}`);
  // A settlement already in flight for this exact payload may have moved money: always let it finish.
  const resuming = prev?.status === "settling";
  if (!resuming && gift.paymentExpiresAt.getTime() / 1000 <= now) {
    await transition(d.db, giftId, "AWAITING_PAYMENT", "EXPIRED").catch(() => {});
    return fail(410, "payment window expired; request a new quote");
  }

  const verify = await d.facilitator.verify(payload, requirement);
  if (!verify.isValid) return fail(402, `payment rejected: ${verify.invalidReason ?? "invalid"}${verify.invalidMessage ? ` (${verify.invalidMessage})` : ""}`);

  // Verify doesn't check funds; settling an unfunded payment would just fail on-chain.
  const funds = await d.funds.check(requirement.asset, payer, requirement.extra.assetTransferMethod);
  const amount = BigInt(requirement.amount);
  if (funds.balance < amount) return fail(402, "insufficient balance for this payment");
  if (funds.allowance !== null && funds.allowance < amount) return fail(402, "Permit2 approval needed: approve the token for Permit2 once, then pay");

  // Claim the right to settle: one row per gift, written before settlement.
  if (!prev) {
    const ins = await d.db.query(
      `INSERT INTO payments (gift_id, payload_hash, payer, asset, method, amount, status) VALUES ($1, $2, $3, $4, $5, $6, 'settling')
       ON CONFLICT (gift_id) DO NOTHING`,
      [giftId, hash, payer, requirement.asset, requirement.extra.assetTransferMethod, requirement.amount],
    );
    if (!ins.rowCount) return fail(409, "another payment for this gift is in progress", true);
  }

  if (!d.liveTrading) {
    // Dry run: everything except moving the sender's money.
    await d.db.query("UPDATE payments SET status = 'verified_dry_run', updated_at = now() WHERE gift_id = $1", [giftId]);
    const paid = await transition(d.db, giftId, "AWAITING_PAYMENT", "PAID", { paymentTx: `dryrun:verified:${hash.slice(0, 16)}` });
    await recordFee(d.db, paid, null);
    return { ok: true, gift: paid, claimCode: await issueClaimCode(d.db, giftId), settleTx: null, alreadyPaid: false };
  }

  let settled;
  try {
    settled = await d.facilitator.settle(payload, requirement);
  } catch (e) {
    // Unknown outcome: keep 'settling'. Settle is idempotent on the signed payload, so the same payment can be retried.
    await d.db.query("UPDATE payments SET error = $2, updated_at = now() WHERE gift_id = $1", [giftId, (e as Error).message.slice(0, 500)]);
    return fail(502, "settlement didn't complete; retry the same payment", true);
  }
  if (!settled.success || !settled.transaction) {
    await d.db.query("DELETE FROM payments WHERE gift_id = $1 AND status = 'settling'", [giftId]);
    return fail(402, `settlement failed: ${settled.errorReason ?? "unknown"}`);
  }

  await d.db.query("UPDATE payments SET status = 'settled', settle_tx = $2, error = NULL, updated_at = now() WHERE gift_id = $1", [giftId, settled.transaction]);
  let paid: Gift;
  try {
    paid = await transition(d.db, giftId, "AWAITING_PAYMENT", "PAID", { paymentTx: settled.transaction });
  } catch (e) {
    if (!(e instanceof StaleStateError)) throw e;
    paid = (await getGift(d.db, giftId))!; // a concurrent retry got there first
  }
  await recordFee(d.db, paid, settled.transaction!);
  return { ok: true, gift: paid, claimCode: await issueClaimCode(d.db, giftId), settleTx: settled.transaction!, alreadyPaid: false };
}
