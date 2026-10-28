// The agent's autonomous jobs. Each one is small, idempotent and safe to run any number of times: every state
// change goes through the ledger's compare-and-set, and every money move through the recorded execution steps.
import type { Db } from "../db/pool.js";
import { StaleStateError, transition } from "../gifts/ledger.js";
import { reconcile, onchainBalanceOf, type BalanceOf } from "../gifts/reconcile.js";
import type { ExecOutcome } from "../execution/buy.js";
import * as baw from "../baw/cli.js";
import { recentRuns, type JobDef, type JobResult } from "./runner.js";
import { alert } from "./alert.js";
import { closeGroup, cancelGroup, groupsDueToClose, strandedContributions, GROUP_CLOSE_GRACE_MS, type PoolQuote } from "../gifts/groups.js";

export interface JobDeps {
  advance: (db: Db, id: string) => Promise<ExecOutcome>;
  vaultBalanceOf?: BalanceOf;
  bawStatus?: () => Promise<baw.WalletStatus>;
  bawSettings?: () => Promise<baw.WalletSettings>;
  keepaliveMinutes?: number;
  alert?: (text: string) => Promise<void>;
  /** Price for a closing group's pooled gift (the live picker by default). */
  poolQuote?: PoolQuote;
}

async function ids(db: Db, sql: string, params: unknown[] = []): Promise<string[]> {
  return (await db.query<{ id: string }>(sql, params)).rows.map((r) => r.id);
}

/** Moves gifts one step each, in order; stops early when a step says to wait (signed out / pending). */
async function advanceAll(db: Db, deps: JobDeps, giftIds: string[], stopOn: ExecOutcome["status"][] = []) {
  const done: Record<string, string> = {};
  for (const id of giftIds) {
    try {
      const r = await deps.advance(db, id);
      done[id] = r.status;
      if (stopOn.includes(r.status)) break;
    } catch (e) {
      done[id] = `error: ${(e as Error).message}`.slice(0, 200);
    }
  }
  return done;
}

/** "2026-10-12 19:16 UTC" */
const utc = (iso: string) => new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC";

const count = (o: Record<string, string>, status: string) => Object.values(o).filter((s) => s === status).length;

export function buildJobs(deps: JobDeps): JobDef[] {
  const notify = deps.alert ?? alert;

  const expireUnpaid: JobDef = {
    name: "expire-unpaid",
    title: "Closes gifts nobody paid for once their price hold runs out",
    everyMs: 60_000,
    async run(db) {
      // A gift with a payment row may be mid-settlement: never expire it here. The other stocks in a basket are covered
      // by their lead's payment, so they wait for it too.
      const list = await ids(
        db,
        `SELECT id FROM gifts g WHERE status = 'AWAITING_PAYMENT' AND payment_expires_at < now() - interval '1 minute'
           AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.gift_id = coalesce(g.basket_id, g.id)) ORDER BY created_at LIMIT 200`,
      );
      let n = 0;
      for (const id of list) {
        try {
          await transition(db, id, "AWAITING_PAYMENT", "EXPIRED");
          n++;
        } catch (e) {
          if (!(e instanceof StaleStateError)) throw e;
        }
      }
      return { summary: n ? `expired ${n} unpaid gift${n === 1 ? "" : "s"}` : "nothing to expire", detail: { expired: n } };
    },
  };

  const expiryReturns: JobDef = {
    name: "expiry-returns",
    title: "Returns unclaimed gifts to their senders when the claim window ends",
    everyMs: 10 * 60_000,
    async run(db) {
      const due = await ids(db, "SELECT id FROM gifts WHERE status = 'READY' AND claim_expires_at <= now() ORDER BY claim_expires_at LIMIT 20");
      let started = 0;
      for (const id of due) {
        try {
          await transition(db, id, "READY", "RETURNING", {}, { detail: { reason: "claim window ended" } });
          started++;
        } catch (e) {
          if (!(e instanceof StaleStateError)) throw e;
        }
      }
      // Returns in flight (just started, or interrupted earlier).
      const returning = await ids(db, "SELECT id FROM gifts WHERE status = 'RETURNING' ORDER BY updated_at LIMIT 20");
      const r = await advanceAll(db, deps, returning);
      const returned = count(r, "RETURNED");
      return {
        ok: !Object.values(r).some((s) => s.startsWith("error")),
        summary: started || returning.length ? `${started} expired, ${returned} returned to sender, ${returning.length - returned} still in progress` : "no gifts past their claim window",
        detail: { started, results: r },
      };
    },
  };

  const resumePayouts: JobDef = {
    name: "resume-payouts",
    title: "Finishes claims and refunds that were interrupted",
    everyMs: 2 * 60_000,
    async run(db) {
      const list = await ids(
        db,
        `SELECT id FROM gifts WHERE (status = 'CLAIMING' AND updated_at < now() - interval '90 seconds')
            OR (status IN ('REFUNDING', 'FAILED') AND updated_at < now() - interval '2 minutes')
         ORDER BY updated_at LIMIT 20`,
      );
      if (!list.length) return { summary: "nothing waiting" };
      const r = await advanceAll(db, deps, list);
      return {
        ok: !Object.values(r).some((s) => s.startsWith("error")),
        summary: `${count(r, "CLAIMED")} claims and ${count(r, "REFUNDED")} refunds finished, ${list.length - count(r, "CLAIMED") - count(r, "REFUNDED")} still waiting`,
        detail: r,
      };
    },
  };

  const buyQueue: JobDef = {
    name: "buy-queue",
    title: "Buys the stock for paid gifts, one at a time",
    everyMs: 60_000,
    needsBaw: true,
    async run(db) {
      // Orders still waiting for their price belong to price-watch.
      const list = await ids(db, "SELECT id FROM gifts WHERE status IN ('PAID', 'BUYING') AND (order_trigger IS NULL OR order_triggered_at IS NOT NULL) AND group_role IS DISTINCT FROM 'contribution' ORDER BY created_at LIMIT 5");
      if (!list.length) return { summary: "no paid gifts waiting" };
      // The Agentic Wallet handles one transaction at a time; stop as soon as it says wait.
      const r = await advanceAll(db, deps, list, ["QUEUED", "PENDING"]);
      const ready = count(r, "READY");
      const queued = Object.values(r).includes("QUEUED");
      return {
        ok: !Object.values(r).some((s) => s.startsWith("error")),
        summary: queued ? `queued: the Agentic Wallet is signed out (${list.length} waiting)` : `${ready} bought, ${list.length - ready} in progress`,
        detail: r,
      };
    },
  };

  const priceWatch: JobDef = {
    name: "price-watch",
    title: "Watches the price for orders waiting to buy, and refunds the ones that run out of time",
    everyMs: 60_000,
    async run(db) {
      const list = await ids(
        db,
        "SELECT id FROM gifts WHERE status = 'PAID' AND order_trigger IS NOT NULL AND order_triggered_at IS NULL ORDER BY order_deadline LIMIT 50",
      );
      if (!list.length) return { summary: "no orders waiting for a price" };
      const r = await advanceAll(db, deps, list);
      const waiting = count(r, "WAITING");
      const started = Object.values(r).filter((x) => ["READY", "QUEUED", "PENDING"].includes(x)).length;
      const refunded = count(r, "FAILED");
      return {
        ok: !Object.values(r).some((x) => x.startsWith("error")),
        summary: `${list.length} waiting order${list.length === 1 ? "" : "s"}: ${waiting} still waiting, ${started} bought, ${refunded} refunded after their deadline`,
        detail: r,
      };
    },
  };

  const groupClose: JobDef = {
    name: "group-close",
    title: "Closes group gifts at their closing time: buys one gift from everyone's contributions, or refunds them",
    everyMs: 60_000,
    async run(db) {
      const quote = deps.poolQuote ?? (await import("../payments/openGift.js")).poolQuote;
      let pooled = 0;
      let cancelled = 0;
      let waiting = 0;
      const refund: string[] = [];
      const buy: string[] = [];
      for (const g of await groupsDueToClose(db)) {
        const r = await closeGroup(db, g.id, quote);
        if (r.ok && r.outcome === "pooled") {
          pooled++;
          buy.push(r.gift.id);
        } else if (r.ok) {
          cancelled++;
          refund.push(...r.refunding);
        } else if (Date.now() - g.closesAt.getTime() > GROUP_CLOSE_GRACE_MS) {
          // No price for a whole day past closing: give everyone their money back.
          const c = await cancelGroup(db, g.id, `couldn't be bought (${r.error})`);
          if (c.ok) {
            cancelled++;
            refund.push(...c.refunding);
          }
        } else waiting++;
      }
      // A payment that settled while its group was closing was never pooled: refund it.
      const stranded = await strandedContributions(db);
      refund.push(...stranded);
      const r = await advanceAll(db, deps, refund);
      // The pooled gift is bought by buy-queue; nudge it now where buys run on this host.
      if (process.env.AUTO_EXECUTE === "true" && buy.length) void advanceAll(db, deps, buy);
      const parts = [pooled && `${pooled} bought as one gift`, cancelled && `${cancelled} cancelled`, waiting && `${waiting} waiting for a price`, stranded.length && `${stranded.length} late payments refunded`].filter(Boolean);
      return { ok: !Object.values(r).some((x) => x.startsWith("error")), summary: parts.length ? parts.join(", ") : "no group gifts closing", detail: { refunds: r } };
    },
  };

  const reconciliation: JobDef = {
    name: "reconcile",
    title: "Checks the vault holds every unclaimed gift's stock (proof of holdings)",
    everyMs: 15 * 60_000,
    async run(db) {
      const vault = process.env.VAULT_ADDRESS;
      if (!vault && !deps.vaultBalanceOf) return { ok: false, summary: "VAULT_ADDRESS not set" };
      const r = await reconcile(db, deps.vaultBalanceOf ?? onchainBalanceOf(vault as `0x${string}`));
      const short = r.rows.filter((x) => !x.ok);
      const detail = {
        ok: r.ok,
        checkedAt: r.checkedAt,
        tokens: r.rows.map((x) => ({ ticker: x.ticker, token: x.tokenAddress, gifts: x.gifts, owedRaw: x.amountRaw.toString(), heldRaw: x.holdingRaw.toString(), surplusRaw: x.surplusRaw.toString(), ok: x.ok })),
      };
      const summary = r.ok
        ? r.rows.length
          ? `covered: the vault holds enough for all ${r.rows.reduce((s, x) => s + x.gifts, 0)} unclaimed gifts`
          : "no unclaimed gifts to cover"
        : `SHORT on ${short.map((x) => x.ticker).join(", ")}`;
      const prev = (await recentRuns(db, "reconcile", 1))[0];
      if (!r.ok && prev?.ok !== false) await notify(`ShareSend reconciliation: vault is ${summary}. Holdings are below what unclaimed gifts are owed.`);
      return { ok: r.ok, summary, detail };
    },
  };

  const keepalive: JobDef = {
    name: "keepalive",
    title: "Keeps the Agentic Wallet session alive and warns before it ends",
    everyMs: (deps.keepaliveMinutes ?? Number(process.env.KEEPALIVE_MINUTES ?? 60)) * 60_000,
    needsBaw: true,
    async run(db) {
      const status = await (deps.bawStatus ?? baw.walletStatus)();
      const prev = (await recentRuns(db, "keepalive", 1))[0];
      const prevDetail = (prev?.detail ?? {}) as { connected?: boolean; inactiveSignOutTime?: string };
      if (status !== "CONNECTED") {
        if (prevDetail.connected !== false) await notify("ShareSend: the Agentic Wallet is signed out. New gifts will queue until you sign in again (npm run cli -- admin signin).");
        return { ok: false, summary: "signed out: buys are queued until the next sign-in", detail: { connected: false, status } };
      }
      // A read call; whether it counts as "activity" is measured: did the inactivity sign-out time move?
      const s = await (deps.bawSettings ?? baw.walletSettings)();
      const extended = prevDetail.inactiveSignOutTime ? Date.parse(s.inactiveSignOutTime) > Date.parse(prevDetail.inactiveSignOutTime) : null;
      const hoursLeft = (Date.parse(s.sessionExpireTime) - Date.now()) / 3_600_000;
      // Warn once, on the first check inside the last 12 hours (or the first check ever, if already inside).
      const prevExpire = (prev?.detail as { sessionExpireTime?: string } | undefined)?.sessionExpireTime;
      const prevHoursLeft = prev && prevExpire ? (Date.parse(prevExpire) - new Date(prev.startedAt).getTime()) / 3_600_000 : Infinity;
      if (hoursLeft < 12 && prevHoursLeft >= 12)
        await notify(`ShareSend: the Agentic Wallet session ends ${new Date(s.sessionExpireTime).toUTCString()}. Sign in again before then (npm run cli -- admin signin).`);
      return {
        summary: `signed in until ${utc(s.sessionExpireTime)}${extended === null ? "" : extended ? "; activity extended the inactivity timer" : "; this check did not extend the inactivity timer"}`,
        detail: { connected: true, sessionExpireTime: s.sessionExpireTime, inactiveSignOutTime: s.inactiveSignOutTime, activityExtended: extended, quotaLeft: s.quotaLeft, dailyLimit: s.dailyLimit },
      };
    },
  };

  return [expireUnpaid, expiryReturns, resumePayouts, priceWatch, buyQueue, groupClose, reconciliation, keepalive];
}

export type { JobResult };
