// Gift ledger. Every status change is a compare-and-set (UPDATE ... WHERE status = <expected>) inside a
// transaction that also writes an audit event, so two requests can never move the same gift at once.
import { randomUUID } from "node:crypto";
import { getAddress, isAddress, zeroAddress } from "viem";
import { withTx, type Db, type Queryable } from "../db/pool.js";
import { canAdvanceStep, canTransition, type BuyStep, type GiftStatus } from "./states.js";
import { codeMatches, generateClaimCode, hashClaimCode, isWellFormedCode } from "./codes.js";
import { DEFAULT_CLAIM_LIMITS, hashIp, isRateLimited, recordAttempt, type ClaimRateLimits } from "./rateLimit.js";

export interface Gift {
  id: string;
  status: GiftStatus;
  step: BuyStep | null;
  senderAddress: string;
  senderName: string;
  recipientName: string;
  message: string;
  ticker: string;
  issuer: string;
  tokenAddress: string;
  tokenDecimals: number;
  quotedTokenAmount: bigint;
  tokenAmount: bigint | null;
  usdCost: number;
  feeUsd: number;
  quoteId: string | null;
  claimCodeHash: Buffer;
  claimAddress: string | null;
  paymentTx: string | null;
  forwardTx: string | null;
  buyTx: string | null;
  vaultTx: string | null;
  claimTx: string | null;
  returnTx: string | null;
  refundTx: string | null;
  failureReason: string | null;
  paymentExpiresAt: Date;
  claimExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Created with LIVE_TRADING=false: synthetic tx hashes, excluded from caps and reconciliation. */
  dryRun: boolean;
  /** The x402 requirements offered in the 402 response (JSON). */
  paymentRequirements: unknown[] | null;
  claimCodeIssued: boolean;
  readyAt: Date | null;
  claimedAt: Date | null;
  /** What the sender wants if the gift goes back to them: the stock itself, or USDT from selling it. */
  returnAs: ReturnAs;
}

export type ReturnAs = "stock" | "usdt";

// ---- Errors ----

export class GiftNotFoundError extends Error {
  constructor(id: string) {
    super(`Gift ${id} not found`);
  }
}

export class IllegalTransitionError extends Error {
  constructor(public readonly from: string, public readonly to: string) {
    super(`Illegal transition ${from} → ${to}`);
  }
}

/** The compare-and-set lost: the gift is no longer in the expected status/step. */
export class StaleStateError extends Error {
  constructor(public readonly expected: string, public readonly actual: string | null) {
    super(`Gift state changed: expected ${expected}, found ${actual ?? "nothing"}`);
  }
}

export class CapExceededError extends Error {
  constructor(public readonly code: "OVER_MAX_GIFT" | "OVER_DAILY_CAP", message: string) {
    super(message);
  }
}

// ---- Row mapping ----

const big = (v: string | null) => (v === null ? null : BigInt(v));

function toGift(r: any): Gift {
  return {
    id: r.id,
    status: r.status,
    step: r.step,
    senderAddress: r.sender_address,
    senderName: r.sender_name,
    recipientName: r.recipient_name,
    message: r.message,
    ticker: r.ticker,
    issuer: r.issuer,
    tokenAddress: r.token_address,
    tokenDecimals: r.token_decimals,
    quotedTokenAmount: BigInt(r.quoted_token_amount),
    tokenAmount: big(r.token_amount),
    usdCost: Number(r.usd_cost),
    feeUsd: Number(r.fee_usd),
    quoteId: r.quote_id,
    claimCodeHash: r.claim_code_hash,
    claimAddress: r.claim_address,
    paymentTx: r.payment_tx,
    forwardTx: r.forward_tx,
    buyTx: r.buy_tx,
    vaultTx: r.vault_tx,
    claimTx: r.claim_tx,
    returnTx: r.return_tx,
    refundTx: r.refund_tx,
    failureReason: r.failure_reason,
    paymentExpiresAt: r.payment_expires_at,
    claimExpiresAt: r.claim_expires_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    dryRun: r.dry_run,
    paymentRequirements: r.payment_requirements ?? null,
    claimCodeIssued: r.claim_code_issued ?? false,
    readyAt: r.ready_at ?? null,
    claimedAt: r.claimed_at ?? null,
    returnAs: r.return_as ?? "stock",
  };
}

// ---- Create ----

export interface NewGift {
  senderAddress: string;
  senderName: string;
  recipientName: string;
  message?: string;
  ticker: string;
  issuer: string;
  tokenAddress: string;
  tokenDecimals: number;
  quotedTokenAmount: bigint;
  usdCost: number;
  feeUsd: number;
  quoteId?: string;
  paymentExpiresAt: Date;
  dryRun?: boolean;
  paymentRequirements?: unknown[];
  returnAs?: ReturnAs;
}

export interface GiftCaps {
  maxGiftUsd: number;
  dailyCapUsd: number;
}

function text(name: string, v: string | undefined, max: number, required = true): string {
  const s = (v ?? "").trim();
  if (required && !s) throw new Error(`${name} is required`);
  if (s.length > max) throw new Error(`${name} is too long (max ${max})`);
  return s;
}

/** Gift USD counted against today's cap (UTC day): everything except expired and refunded gifts. */
export async function dailyUsedUsd(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ used: string }>(
    `SELECT coalesce(sum(usd_cost), 0) AS used FROM gifts
     WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
       AND status NOT IN ('EXPIRED', 'REFUNDED') AND NOT dry_run
       -- An unpaid gift stops counting once its payment window has passed.
       AND NOT (status = 'AWAITING_PAYMENT' AND payment_expires_at <= now())`,
  );
  return Number(rows[0]!.used);
}

/**
 * Creates a gift in AWAITING_PAYMENT and returns its claim code. The code is returned once, here, and is
 * never stored: the caller puts it in the link and must not log it. Caps are checked under a lock so
 * concurrent creates can't exceed the daily cap together.
 */
export async function createGift(db: Db, input: NewGift, caps: GiftCaps): Promise<{ gift: Gift; claimCode: string }> {
  if (!isAddress(input.senderAddress)) throw new Error("senderAddress is not a valid address");
  if (!isAddress(input.tokenAddress)) throw new Error("tokenAddress is not a valid address");
  if (!(input.usdCost > 0) || !(input.feeUsd >= 0)) throw new Error("usdCost must be > 0 and feeUsd ≥ 0");
  if (input.quotedTokenAmount <= 0n) throw new Error("quotedTokenAmount must be > 0");
  if (input.usdCost > caps.maxGiftUsd) throw new CapExceededError("OVER_MAX_GIFT", `Gifts are limited to $${caps.maxGiftUsd} each`);

  const senderName = text("senderName", input.senderName, 60);
  const recipientName = text("recipientName", input.recipientName, 60);
  const message = text("message", input.message, 280, false);
  const claimCode = generateClaimCode();

  return withTx(db, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('sharesend:daily-cap'))");
    const used = await dailyUsedUsd(c);
    if (!input.dryRun && used + input.usdCost > caps.dailyCapUsd)
      throw new CapExceededError("OVER_DAILY_CAP", `Daily limit reached: $${Math.max(0, caps.dailyCapUsd - used).toFixed(2)} of $${caps.dailyCapUsd} left today`);

    const { rows } = await c.query(
      `INSERT INTO gifts (id, status, sender_address, sender_name, recipient_name, message, ticker, issuer,
         token_address, token_decimals, quoted_token_amount, usd_cost, fee_usd, quote_id, claim_code_hash, payment_expires_at, dry_run, payment_requirements, return_as)
       VALUES ($1, 'AWAITING_PAYMENT', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING *`,
      [
        randomUUID(),
        getAddress(input.senderAddress),
        senderName,
        recipientName,
        message,
        input.ticker.toUpperCase(),
        input.issuer,
        getAddress(input.tokenAddress),
        input.tokenDecimals,
        input.quotedTokenAmount.toString(),
        input.usdCost,
        input.feeUsd,
        input.quoteId ?? null,
        hashClaimCode(claimCode),
        input.paymentExpiresAt,
        input.dryRun ?? false,
        input.paymentRequirements ? JSON.stringify(input.paymentRequirements) : null,
        input.returnAs === "usdt" ? "usdt" : "stock",
      ],
    );
    const gift = toGift(rows[0]);
    await c.query("INSERT INTO gift_events (gift_id, from_status, to_status) VALUES ($1, NULL, 'AWAITING_PAYMENT')", [gift.id]);
    return { gift, claimCode };
  });
}

export async function getGift(db: Queryable, id: string): Promise<Gift | null> {
  if (!UUID_RE.test(id)) return null;
  const { rows } = await db.query("SELECT * FROM gifts WHERE id = $1", [id]);
  return rows[0] ? toGift(rows[0]) : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Changes how a gift comes back to the sender. Allowed until the stock has actually left the vault for the
 * sell-back (an exec_records `to_wallet` row), and never once the gift is claimed, returned or refunded.
 */
export async function setReturnAs(db: Queryable, id: string, choice: ReturnAs): Promise<boolean> {
  const r = await db.query(
    `UPDATE gifts g SET return_as = $2, updated_at = now()
     WHERE g.id = $1 AND g.status IN ('AWAITING_PAYMENT', 'PAID', 'BUYING', 'READY', 'RETURNING')
       AND NOT EXISTS (SELECT 1 FROM exec_records e WHERE e.gift_id = g.id AND e.kind = 'to_wallet')`,
    [id, choice],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Gifts claimed (or being claimed) to an address, oldest first. */
export async function giftsClaimedBy(db: Queryable, address: string): Promise<Gift[]> {
  const { rows } = await db.query(
    "SELECT * FROM gifts WHERE lower(claim_address) = lower($1) AND status IN ('CLAIMING', 'CLAIMED') ORDER BY coalesce(claimed_at, updated_at)",
    [address],
  );
  return rows.map(toGift);
}

// ---- Transitions ----

/** Fields a transition may set. Column names are fixed here, never taken from input. */
export interface GiftPatch {
  tokenAmount?: bigint;
  claimAddress?: string | null;
  paymentTx?: string;
  forwardTx?: string;
  buyTx?: string;
  vaultTx?: string;
  claimTx?: string;
  returnTx?: string;
  refundTx?: string;
  failureReason?: string | null;
  claimExpiresAt?: Date;
}

const PATCH_COLUMNS: Record<keyof GiftPatch, string> = {
  tokenAmount: "token_amount",
  claimAddress: "claim_address",
  paymentTx: "payment_tx",
  forwardTx: "forward_tx",
  buyTx: "buy_tx",
  vaultTx: "vault_tx",
  claimTx: "claim_tx",
  returnTx: "return_tx",
  refundTx: "refund_tx",
  failureReason: "failure_reason",
  claimExpiresAt: "claim_expires_at",
};

const ARRIVAL_TIMESTAMP: Partial<Record<GiftStatus, string>> = {
  PAID: "paid_at",
  READY: "ready_at",
  CLAIMED: "claimed_at",
  RETURNED: "returned_at",
  REFUNDED: "refunded_at",
};

function patchSql(patch: GiftPatch, params: unknown[]): string[] {
  const sets: string[] = [];
  for (const [k, v] of Object.entries(patch) as [keyof GiftPatch, unknown][]) {
    const col = PATCH_COLUMNS[k];
    if (!col) throw new Error(`Unknown gift field ${String(k)}`);
    if (v === undefined) continue;
    params.push(typeof v === "bigint" ? v.toString() : v);
    sets.push(`${col} = $${params.length}`);
  }
  return sets;
}

export interface TransitionOpts {
  /** Extra WHERE condition that must also hold (SQL over the gifts row, no user input). */
  guard?: string;
  /** Days until an unclaimed gift returns; used when entering READY without claimExpiresAt. */
  claimExpiryDays?: number;
  detail?: Record<string, unknown>;
}

async function transitionOn(c: Queryable, id: string, from: GiftStatus, to: GiftStatus, patch: GiftPatch, opts: TransitionOpts): Promise<Gift> {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  const params: unknown[] = [id, from, to];
  const sets = ["status = $3", "updated_at = now()", ...patchSql(patch, params)];
  // Set once: a released claim (CLAIMING → READY) keeps its original ready time and claim window.
  const arrived = ARRIVAL_TIMESTAMP[to];
  if (arrived) sets.push(`${arrived} = coalesce(${arrived}, now())`);
  if (to === "READY" && !patch.claimExpiresAt) {
    params.push(opts.claimExpiryDays ?? 30);
    sets.push(`claim_expires_at = coalesce(claim_expires_at, now() + make_interval(days => $${params.length}))`);
  }
  const { rows } = await c.query(
    `UPDATE gifts SET ${sets.join(", ")} WHERE id = $1 AND status = $2${opts.guard ? ` AND (${opts.guard})` : ""} RETURNING *`,
    params,
  );
  if (!rows[0]) {
    const cur = await c.query<{ status: string }>("SELECT status FROM gifts WHERE id = $1", [id]);
    if (!cur.rows[0]) throw new GiftNotFoundError(id);
    throw new StaleStateError(from, cur.rows[0].status);
  }
  await c.query("INSERT INTO gift_events (gift_id, from_status, to_status, detail) VALUES ($1, $2, $3, $4)", [id, from, to, opts.detail ?? null]);
  return toGift(rows[0]);
}

/** Moves a gift from `from` to `to`, atomically. Throws IllegalTransitionError or StaleStateError. */
export async function transition(db: Db, id: string, from: GiftStatus, to: GiftStatus, patch: GiftPatch = {}, opts: TransitionOpts = {}): Promise<Gift> {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to); // before touching the DB
  return withTx(db, (c) => transitionOn(c, id, from, to, patch, opts));
}

/** Records progress inside BUYING. Each step can be recorded once, in order, so a retry never repeats one. */
export async function advanceStep(db: Db, id: string, from: BuyStep | null, to: BuyStep, patch: GiftPatch = {}): Promise<Gift> {
  if (!canAdvanceStep(from, to)) throw new IllegalTransitionError(from ?? "(no step)", to);
  return withTx(db, async (c) => {
    const params: unknown[] = [id, from, to];
    const sets = ["step = $3", "updated_at = now()", ...patchSql(patch, params)];
    const { rows } = await c.query(
      `UPDATE gifts SET ${sets.join(", ")} WHERE id = $1 AND status = 'BUYING' AND step IS NOT DISTINCT FROM $2 RETURNING *`,
      params,
    );
    if (!rows[0]) {
      const cur = await c.query<{ status: string; step: string | null }>("SELECT status, step FROM gifts WHERE id = $1", [id]);
      if (!cur.rows[0]) throw new GiftNotFoundError(id);
      throw new StaleStateError(`BUYING/${from ?? "(no step)"}`, `${cur.rows[0].status}/${cur.rows[0].step ?? "(no step)"}`);
    }
    await c.query("INSERT INTO gift_events (gift_id, from_status, to_status, step) VALUES ($1, 'BUYING', 'BUYING', $2)", [id, to]);
    return toGift(rows[0]);
  });
}

type TxField = "paymentTx" | "forwardTx" | "buyTx" | "vaultTx" | "claimTx" | "returnTx" | "refundTx";

/**
 * Records a tx hash without changing status (e.g. the claim tx right before broadcast, which blocks
 * releaseClaim from then on). Idempotent for the same hash; refuses to overwrite a different one.
 */
export async function recordTx(db: Queryable, id: string, status: GiftStatus, field: TxField, hash: string): Promise<void> {
  const col = PATCH_COLUMNS[field];
  const { rowCount } = await db.query(
    `UPDATE gifts SET ${col} = $3, updated_at = now() WHERE id = $1 AND status = $2 AND (${col} IS NULL OR ${col} = $3)`,
    [id, status, hash],
  );
  if (!rowCount) {
    const cur = await db.query<{ status: string }>("SELECT status FROM gifts WHERE id = $1", [id]);
    if (!cur.rows[0]) throw new GiftNotFoundError(id);
    throw new StaleStateError(`${status} with ${field} unset or equal`, cur.rows[0].status);
  }
}

/**
 * Replaces a gift's claim code (the old link stops working) and returns the new one. Only before anyone
 * has started claiming: PAID, BUYING or READY.
 */
export async function reissueClaimCode(db: Queryable, id: string): Promise<string | null> {
  const code = generateClaimCode();
  const r = await db.query(
    "UPDATE gifts SET claim_code_hash = $2, claim_code_issued = true, updated_at = now() WHERE id = $1 AND status IN ('PAID', 'BUYING', 'READY')",
    [id, hashClaimCode(code)],
  );
  return r.rowCount ? code : null;
}

// ---- Claims ----

export type ClaimFailure =
  | "RATE_LIMITED"
  | "INVALID" // unknown gift or wrong code: deliberately the same answer
  | "BAD_ADDRESS"
  | "NOT_READY" // paid but stock not bought yet
  | "IN_PROGRESS"
  | "ALREADY_CLAIMED"
  | "EXPIRED"
  | "RETURNED"
  | "REFUNDED";

export type ClaimResult = { ok: true; gift: Gift } | { ok: false; reason: ClaimFailure };

export interface ClaimRequest {
  giftId: string;
  code: string;
  claimAddress: string;
  ip: string;
  /** Addresses that must never receive a claim (the vault, the Agentic Wallet). */
  forbiddenAddresses?: string[];
}

function whyNotClaimable(g: Gift, now: Date): ClaimFailure {
  switch (g.status) {
    case "CLAIMED":
      return "ALREADY_CLAIMED";
    case "CLAIMING":
      return "IN_PROGRESS";
    case "RETURNING":
    case "RETURNED":
      return "RETURNED";
    case "REFUNDING":
    case "REFUNDED":
    case "FAILED":
      return "REFUNDED";
    case "EXPIRED":
      return "EXPIRED";
    case "READY":
      return g.claimExpiresAt && g.claimExpiresAt <= now ? "EXPIRED" : "IN_PROGRESS";
    default:
      return "NOT_READY";
  }
}

/**
 * Validates a claim and moves the gift READY → CLAIMING for this address. Exactly one of any number of
 * concurrent claims wins. The vault transfer (Phase 6) then finishes it with completeClaim or releaseClaim.
 */
/**
 * Checks a claim code under the claim rate limits (failed attempts count, per IP and per gift). Used to view a
 * gift as well as to claim it, so the card itself can't be brute-forced either.
 */
export async function verifyClaimCode(
  db: Queryable,
  giftId: string,
  code: string,
  ip: string,
  limits: ClaimRateLimits = DEFAULT_CLAIM_LIMITS,
): Promise<{ ok: true; gift: Gift } | { ok: false; reason: "RATE_LIMITED" | "INVALID" }> {
  const ipHash = hashIp(ip);
  const id = UUID_RE.test(giftId) ? giftId.toLowerCase() : null;
  if (await isRateLimited(db, ipHash, id, limits)) return { ok: false, reason: "RATE_LIMITED" };
  const gift = id && typeof code === "string" && isWellFormedCode(code) ? await getGift(db, id) : null;
  if (!gift || !codeMatches(code, gift.claimCodeHash)) {
    await recordAttempt(db, ipHash, id, false);
    return { ok: false, reason: "INVALID" };
  }
  return { ok: true, gift };
}

export async function beginClaim(db: Db, req: ClaimRequest, limits: ClaimRateLimits = DEFAULT_CLAIM_LIMITS): Promise<ClaimResult> {
  const ipHash = hashIp(req.ip);
  const checked = await verifyClaimCode(db, req.giftId, req.code, req.ip, limits);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  const gift = checked.gift;

  if (!isAddress(req.claimAddress) || req.claimAddress.toLowerCase() === zeroAddress) return { ok: false, reason: "BAD_ADDRESS" };
  const to = getAddress(req.claimAddress);
  const forbidden = [gift.tokenAddress, ...(req.forbiddenAddresses ?? [])].map((a) => a.toLowerCase());
  if (forbidden.includes(to.toLowerCase())) return { ok: false, reason: "BAD_ADDRESS" };

  try {
    const claimed = await transition(db, gift.id, "READY", "CLAIMING", { claimAddress: to }, { guard: "claim_expires_at > now()" });
    await recordAttempt(db, ipHash, gift.id, true);
    return { ok: true, gift: claimed };
  } catch (e) {
    if (!(e instanceof StaleStateError)) throw e;
    const cur = await getGift(db, gift.id);
    return { ok: false, reason: cur ? whyNotClaimable(cur, new Date()) : "INVALID" };
  }
}

export function completeClaim(db: Db, id: string, claimTx: string): Promise<Gift> {
  return transition(db, id, "CLAIMING", "CLAIMED", { claimTx });
}

/** Undo a claim whose transfer was never broadcast (e.g. simulation failed). Refuses once a claim tx exists. */
export function releaseClaim(db: Db, id: string, reason: string): Promise<Gift> {
  return transition(db, id, "CLAIMING", "READY", { claimAddress: null, failureReason: reason }, { guard: "claim_tx IS NULL", detail: { reason } });
}
