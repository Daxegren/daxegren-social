import { readdirSync, readFileSync } from "node:fs";
import type { SqlClient } from "../postgres-store.js";

const MIGRATIONS_DIR = new URL("../../db/migrations/", import.meta.url);
const NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

export const migrationFiles = (dir: URL = MIGRATIONS_DIR) => readdirSync(dir).sort();

/** Applies db/migrations/*.sql that have not run yet. Each file and its bookkeeping row commit together. */
export async function migrate(sql: SqlClient, dir: URL = MIGRATIONS_DIR): Promise<string[]> {
  await sql.query(`create table if not exists social_migrations (name text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await sql.query<{ name: string }>(`select name from social_migrations`)).map((r) => r.name));

  const applied: string[] = [];
  for (const file of migrationFiles(dir)) {
    if (!NAME.test(file)) throw new Error(`unexpected file in migrations: ${file}`);
    if (done.has(file)) continue;
    // One simple-protocol query = one implicit transaction: the schema change and the record land together or not at all.
    await sql.query(`${readFileSync(new URL(file, dir), "utf8")}\n;\ninsert into social_migrations (name) values ('${file}');`);
    applied.push(file);
  }
  return applied;
}
