import pg from "pg";

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

// numeric → string (default), bigint-safe. timestamptz stays a Date.
let pool: pg.Pool | undefined;

/** Shared pool from DATABASE_URL, created on first use. */
export function getDb(): Db {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("Missing env var DATABASE_URL");
    pool = createDb(url);
  }
  return pool;
}

export function createDb(connectionString: string, max = 10, schema?: string): Db {
  if (schema && !/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("invalid schema name");
  const p = new pg.Pool({ connectionString, max, ...(schema ? { options: `-c search_path=${schema}` } : {}) });
  // An idle client erroring (e.g. the server restarted) must not crash the process.
  p.on("error", (e) => console.error("postgres pool error:", e.message));
  return p;
}

/** Runs fn in a transaction on one connection; rolls back on any error. */
export async function withTx<T>(db: Db, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
