// Group gifts: several people chip in, then one gift is bought for the recipient.
//
//   open ──► contributions (gift rows, group_role = 'contribution', each paid through B402 into the vault)
//        ──► close: paid contributions PAID → POOLED, one pooled gift (group_role = 'pool') inserted as PAID
//             └─► bought, claimed and returned like any gift (returns go to the organizer)
//        ──► cancel: paid contributions PAID → REFUNDING, each refunded to whoever paid it
//
// Each contribution is a normal gift row, so payment, refund and cancel reuse the tested gift code. A contribution is
// never bought on its own (runBuy skips it). If the pooled gift's buy fails, the refund goes back per contribution.
import { randomUUID } from "node:crypto";
import { getAddress, isAddress } from "viem";
import { withTx, type Db, type Queryable } from "../db/pool.js";
import { generateClaimCode, hashClaimCode } from "./codes.js";
import { getGift, StaleStateError, transitionOn, type Gift } from "./ledger.js";
import { verifySigned, type SignatureVerifier } from "./senderAuth.js";

export type GroupStatus = "OPEN" | "POOLED" | "CANCELLED";

export interface Group {
  id: string;
  status: GroupStatus;
  organizerAddress: string;
  organizerName: string;
  recipientName: string;
  message: string;
  ticker: string;
  companyName: string | null;
  closesAt: Date;
  pooledGiftId: string | null;
  closeReason: string | null;
  dryRun: boolean;
  createdAt: Date;
}

export const MAX_GROUP_DAYS = 7;
/** An auto-close that can't get a price keeps trying this long past closes_at, then refunds everyone. */
export const GROUP_CLOSE_GRACE_MS = 24 * 3_600_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toGroup(r: any): Group {
  return {
    id: r.id,
    status: r.status,
    organizerAddress: r.organizer_address,
    organizerName: r.organizer_name,
    recipientName: r.recipient_name,
    message: r.message,
    ticker: r.ticker,
    companyName: r.company_name ?? null,
    closesAt: r.closes_at,
    pooledGiftId: r.pooled_gift_id,
    closeReason: r.close_reason,
    dryRun: r.dry_run,
    createdAt: r.created_at,
  };
}

function text(name: string, v: unknown, max: number, required = true): string {
  const s = (typeof v === "string" ? v : "").trim();
  if (required && !s) throw new Error(`${name} is required`);
  if (s.length > max) throw new Error(`${name} is too long (max ${max})`);
  return s;
}

export interface NewGroup {
  ticker: string;
  organizerAddress: string;
  organizerName: string;
  recipientName: string;
  message?: string;
  closesAt: Date;
  dryRun: boolean;
  companyName?: string;
}

export async function createGroup(db: Queryable, input: NewGroup): Promise<Group> {
  if (!isAddress(input.organizerAddress)) throw new Error("organizerAddress is not a valid address");
  if (!/^[A-Za-z.]{1,10}$/.test(input.ticker)) throw new Error("ticker required");
  const ms = input.closesAt.getTime() - Date.now();
  if (!(ms >= 10 * 60_000)) throw new Error("the group must stay open for at least 10 minutes");
  if (ms > MAX_GROUP_DAYS * 86_400_000) throw new Error(`a group can stay open for at most ${MAX_GROUP_DAYS} days`);
  const { rows } = await db.query(
    `INSERT INTO gift_groups (id, status, organizer_address, organizer_name, recipient_name, message, ticker, closes_at, dry_run, company_name)
     VALUES ($1, 'OPEN', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      randomUUID(),
      getAddress(input.organizerAddress),
      text("organizerName", input.organizerName, 60),
      text("recipientName", input.recipientName, 60),
      text("message", input.message, 280, false),
      input.ticker.toUpperCase(),
      input.closesAt,
      input.dryRun,
      input.companyName ?? null,
    ],
  );
  return toGroup(rows[0]);
}

export async function getGroup(db: Queryable, id: string): Promise<Group | null> {
  if (!UUID_RE.test(id)) return null;
  const { rows } = await db.query("SELECT * FROM gift_groups WHERE id = $1", [id]);
  return rows[0] ? toGroup(rows[0]) : null;
}

/** USD already promised to a group: paid or pooled contributions, plus unpaid ones whose price hold hasn't run out. */
export async function committedUsd(db: Queryable, groupId: string): Promise<number> {
  const { rows } = await db.query<{ usd: string }>(
    `SELECT coalesce(sum(usd_cost), 0) AS usd FROM gifts WHERE group_id = $1 AND group_role = 'contribution'
       AND (status IN ('PAID', 'POOLED') OR (status = 'AWAITING_PAYMENT' AND payment_expires_at > now()))`,
    [groupId],
  );
  return Number(rows[0]!.usd);
}

export interface Contributor {
  name: string;
  note: string;
  usd: number;
  at: Date;
}

/** Everyone whose contribution is paid (or pooled), oldest first. Names and notes only: no addresses. */
export async function groupContributors(db: Queryable, groupId: string): Promise<Contributor[]> {
  const { rows } = await db.query<{ sender_name: string; message: string; usd_cost: string; paid_at: Date | null; created_at: Date }>(
    `SELECT sender_name, message, usd_cost, paid_at, created_at FROM gifts
     WHERE group_id = $1 AND group_role = 'contribution' AND status IN ('PAID', 'POOLED') ORDER BY coalesce(paid_at, created_at)`,
    [groupId],
  );
  return rows.map((r) => ({ name: r.sender_name, note: r.message, usd: Number(r.usd_cost), at: r.paid_at ?? r.created_at }));
}

// ---- Organizer-signed actions ----

export type GroupAction = "close" | "cancel";
const GROUP_ACTION_TEXT: Record<GroupAction, string> = {
  close: "Close this group gift and buy it now",
  cancel: "Cancel this group gift and refund everyone",
};

/** The exact text the organizer's wallet signs (personal_sign). */
export function groupMessage(action: GroupAction, groupId: string, isoTime: string): string {
  return `ShareSend\n${GROUP_ACTION_TEXT[action]}\nGroup: ${groupId}\nTime: ${isoTime}`;
}

export function verifyOrganizer(db: Queryable, group: Group, action: GroupAction, message: unknown, signature: unknown, verify: SignatureVerifier, now = Date.now()) {
  return verifySigned(db, group.organizerAddress, (t) => groupMessage(action, group.id, t), message, signature, verify, now, "this group's organizer");
}

// ---- Close and cancel ----

/** A fresh quote for the pooled amount (raw token units), from the issuer picker. */
export type PoolQuote = (ticker: string, usd: number) => Promise<
  { ok: true; issuer: string; tokenAddress: string; tokenDecimals: number; tokenAmountRaw: string; quoteId?: string; name?: string } | { ok: false; message: string }
>;

export type CloseResult =
  | { ok: true; outcome: "pooled"; group: Group; gift: Gift; claimCode: string; contributions: string[] }
  | { ok: true; outcome: "cancelled"; group: Group; refunding: string[] }
  | { ok: false; status: 404 | 409 | 422; error: string };

/**
 * Closes an open group. With at least one paid contribution, its paid contributions become one pooled gift (status
 * PAID, ready to buy) and the organizer gets the claim code once. With none, the group is cancelled.
 */
export async function closeGroup(db: Db, groupId: string, quote: PoolQuote): Promise<CloseResult> {
  return withTx(db, async (c) => {
    const { rows } = await c.query("SELECT * FROM gift_groups WHERE id = $1 FOR UPDATE", [groupId]);
    if (!rows[0]) return { ok: false as const, status: 404 as const, error: "group not found" };
    const group = toGroup(rows[0]);
    if (group.status !== "OPEN") return { ok: false as const, status: 409 as const, error: `this group gift is already ${group.status.toLowerCase()}` };

    const paid = await c.query<{ id: string; usd_cost: string }>(
      "SELECT id, usd_cost FROM gifts WHERE group_id = $1 AND group_role = 'contribution' AND status = 'PAID' ORDER BY created_at FOR UPDATE",
      [groupId],
    );
    if (!paid.rows.length) {
      const g = await cancelIn(c, group, "closed with no contributions");
      return { ok: true as const, outcome: "cancelled" as const, group: g.group, refunding: g.refunding };
    }

    const totalCents = paid.rows.reduce((s, r) => s + Math.round(Number(r.usd_cost) * 100), 0);
    const total = totalCents / 100;
    const q = await quote(group.ticker, total);
    if (!q.ok) return { ok: false as const, status: 422 as const, error: `couldn't get a price for ${group.ticker} right now: ${q.message}` };

    const code = generateClaimCode();
    const poolId = randomUUID();
    await c.query(
      `INSERT INTO gifts (id, status, sender_address, sender_name, recipient_name, message, ticker, issuer, token_address, token_decimals,
         quoted_token_amount, usd_cost, fee_usd, quote_id, claim_code_hash, claim_code_issued, payment_expires_at, paid_at, dry_run, group_id, group_role)
       VALUES ($1, 'PAID', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, $13, true, now(), now(), $14, $15, 'pool')`,
      [
        poolId,
        group.organizerAddress,
        group.organizerName,
        group.recipientName,
        group.message,
        group.ticker,
        q.issuer,
        getAddress(q.tokenAddress),
        q.tokenDecimals,
        q.tokenAmountRaw,
        total,
        q.quoteId ?? null,
        hashClaimCode(code),
        group.dryRun,
        group.id,
      ],
    );
    await c.query("INSERT INTO gift_events (gift_id, from_status, to_status, detail) VALUES ($1, NULL, 'PAID', $2)", [
      poolId,
      { group: group.id, contributions: paid.rows.length, usd: total },
    ]);
    for (const r of paid.rows) await transitionOn(c, r.id, "PAID", "POOLED", {}, { detail: { pool: poolId } });

    const up = await c.query("UPDATE gift_groups SET status = 'POOLED', pooled_gift_id = $2, close_reason = 'closed', updated_at = now() WHERE id = $1 RETURNING *", [
      group.id,
      poolId,
    ]);
    const gift = (await getGift(c, poolId))!;
    return { ok: true as const, outcome: "pooled" as const, group: toGroup(up.rows[0]), gift, claimCode: code, contributions: paid.rows.map((r) => r.id) };
  });
}

async function cancelIn(c: Queryable, group: Group, reason: string): Promise<{ group: Group; refunding: string[] }> {
  const contrib = await c.query<{ id: string; status: string }>(
    "SELECT id, status FROM gifts WHERE group_id = $1 AND group_role = 'contribution' AND status IN ('PAID', 'AWAITING_PAYMENT') FOR UPDATE",
    [group.id],
  );
  const refunding: string[] = [];
  for (const r of contrib.rows) {
    try {
      if (r.status === "PAID") {
        await transitionOn(c, r.id, "PAID", "REFUNDING", { failureReason: `group gift ${reason}` });
        refunding.push(r.id);
      } else await transitionOn(c, r.id, "AWAITING_PAYMENT", "EXPIRED", { failureReason: `group gift ${reason}` });
    } catch (e) {
      if (!(e instanceof StaleStateError)) throw e;
    }
  }
  const up = await c.query("UPDATE gift_groups SET status = 'CANCELLED', close_reason = $2, updated_at = now() WHERE id = $1 RETURNING *", [group.id, reason]);
  return { group: toGroup(up.rows[0]), refunding };
}

/** Cancels an open group: paid contributions go to REFUNDING (refund them next), unpaid ones expire. */
export async function cancelGroup(db: Db, groupId: string, reason = "cancelled by the organizer"): Promise<{ ok: true; group: Group; refunding: string[] } | { ok: false; status: 404 | 409; error: string }> {
  return withTx(db, async (c) => {
    const { rows } = await c.query("SELECT * FROM gift_groups WHERE id = $1 FOR UPDATE", [groupId]);
    if (!rows[0]) return { ok: false as const, status: 404 as const, error: "group not found" };
    const group = toGroup(rows[0]);
    if (group.status !== "OPEN") return { ok: false as const, status: 409 as const, error: `this group gift is already ${group.status.toLowerCase()}` };
    return { ok: true as const, ...(await cancelIn(c, group, reason)) };
  });
}

/**
 * Paid contributions whose group is no longer open (a payment that settled while the group was closing). They were
 * never pooled, so they're refunded. Returns the ids moved to REFUNDING.
 */
export async function strandedContributions(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT g.id FROM gifts g JOIN gift_groups gr ON gr.id = g.group_id
     WHERE g.group_role = 'contribution' AND g.status = 'PAID' AND gr.status <> 'OPEN' LIMIT 50`,
  );
  const out: string[] = [];
  for (const r of rows) {
    try {
      await withTx(db, (c) => transitionOn(c, r.id, "PAID", "REFUNDING", { failureReason: "the group gift closed before this payment arrived" }));
      out.push(r.id);
    } catch (e) {
      if (!(e instanceof StaleStateError)) throw e;
    }
  }
  return out;
}

/**
 * The pooled gift won't be bought (its buy failed or the organizer cancelled before it): it ends REFUNDED without a
 * vault transfer of its own, and each contribution goes POOLED → REFUNDING to be refunded to its payer.
 */
export async function unpool(db: Db, pool: Gift, reason: string): Promise<{ gift: Gift; refunding: string[] }> {
  return withTx(db, async (c) => {
    const gift = await transitionOn(c, pool.id, "REFUNDING", "REFUNDED", { failureReason: reason }, { detail: { unpooled: true } });
    const { rows } = await c.query<{ id: string }>("SELECT id FROM gifts WHERE group_id = $1 AND group_role = 'contribution' AND status = 'POOLED' FOR UPDATE", [pool.groupId]);
    for (const r of rows) await transitionOn(c, r.id, "POOLED", "REFUNDING", { failureReason: `the group gift wasn't bought: ${reason}` });
    return { gift, refunding: rows.map((r) => r.id) };
  });
}

/** Open groups past their closing time. */
export async function groupsDueToClose(db: Queryable, limit = 20): Promise<Group[]> {
  const { rows } = await db.query("SELECT * FROM gift_groups WHERE status = 'OPEN' AND closes_at <= now() ORDER BY closes_at LIMIT $1", [limit]);
  return rows.map(toGroup);
}
