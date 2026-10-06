// Test helper: a freshly migrated, isolated schema per test file, so files can run in parallel.
import { createDb, type Db } from "./pool.js";
import { migrate } from "./migrate.js";

export async function freshTestDb(url: string, schema: string, max = 20): Promise<Db> {
  const admin = createDb(url, 1);
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }
  const db = createDb(url, max, schema);
  await migrate(db);
  return db;
}
