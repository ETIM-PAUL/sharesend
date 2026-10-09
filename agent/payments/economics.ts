// Self-funding ledger: fees earned vs gas, runtime and paid-API spend. Live entries only.
import type { Db, Queryable } from "../db/pool.js";

export async function economics(db: Queryable) {
  const { rows } = await db.query<{ kind: string; usd: string | null; native_wei: string | null; n: string }>(
    "SELECT kind, sum(usd) AS usd, sum(native_wei) AS native_wei, count(*) AS n FROM agent_ledger WHERE NOT dry_run GROUP BY kind",
  );
  const by = Object.fromEntries(rows.map((r) => [r.kind, r]));
  const usd = (k: string) => Number(by[k]?.usd ?? 0);
  const spentUsd = usd("gas") + usd("runtime") + usd("api");
  return {
    feesEarnedUsd: usd("fee_income"),
    giftsWithFees: Number(by.fee_income?.n ?? 0),
    spentUsd,
    gasBnbWei: by.gas?.native_wei ?? "0",
    netUsd: usd("fee_income") - spentUsd,
    note: "gas is also tracked in BNB wei; USD for gas is filled in when a BNB price is recorded with the entry",
  };
}

/** Manual spend entry (e.g. hosting). */
export async function recordExpense(db: Db, kind: "runtime" | "api", usd: number, note: string) {
  await db.query("INSERT INTO agent_ledger (kind, usd, note, tx) VALUES ($1, $2, $3, $4)", [kind, usd, note, `manual:${Date.now()}`]);
}

/** Gas paid by the vault for a confirmed tx. */
export async function recordGas(db: Queryable, giftId: string | null, tx: string, wei: bigint, usd: number | null, dryRun = false) {
  await db.query("INSERT INTO agent_ledger (kind, native_wei, usd, gift_id, tx, dry_run) VALUES ('gas', $1, $2, $3, $4, $5) ON CONFLICT DO NOTHING", [
    wei.toString(),
    usd,
    giftId,
    tx,
    dryRun,
  ]);
}
