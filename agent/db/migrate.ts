// Applies agent/db/migrations/*.sql in name order, once each. Run: npm run migrate
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createDb, withTx, type Db } from "./pool.js";

const dir = fileURLToPath(new URL("./migrations/", import.meta.url));

export async function migrate(db: Db): Promise<string[]> {
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const applied = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = await readFile(dir + f, "utf8");
    await withTx(db, async (c) => {
      await c.query(sql);
      await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
    });
    ran.push(f);
  }
  return ran;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await import("dotenv/config");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Missing env var DATABASE_URL");
  const db = createDb(url, 1);
  try {
    const ran = await migrate(db);
    console.log(ran.length ? `applied: ${ran.join(", ")}` : "up to date");
  } finally {
    await db.end();
  }
}
