import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { SqlClient } from "../src/postgres-store.js";

const migration = (name: string) => readFileSync(new URL(`../db/migrations/${name}`, import.meta.url), "utf8");

/** Minimal stand-in for the parts of Supabase the migrations rely on. */
export const SUPABASE_STUB = `
  create role authenticated;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  grant usage on schema auth to authenticated;
  grant execute on function auth.uid() to authenticated;
`;

let shared: Promise<PGlite> | undefined;

/** One migrated database per test file (booting PGlite is slow); data is wiped on every call. */
export async function freshDb() {
  shared ??= (async () => {
    const db = new PGlite();
    await db.exec(SUPABASE_STUB);
    await db.exec(migration("0001_init.sql"));
    await db.exec(migration("0002_review_access.sql"));
    await db.exec(migration("0003_media_jobs.sql"));
    return db;
  })();
  const db = await shared;
  await db.exec(
    `reset role; truncate social_media_jobs, social_admins, social_posts, social_variants, social_briefs, social_assets, auth.users cascade;`,
  );
  const sql: SqlClient = { query: async (text, params) => (await db.query(text, params)).rows as never };
  return { db, sql };
}

/** A database with only the Supabase stub — no migrations applied. */
export async function bareDb() {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  // pg runs a parameterless multi-statement string as one simple query; PGlite needs exec() for that.
  const sql: SqlClient = {
    query: async (text, params) => {
      if (params) return (await db.query(text, params)).rows as never;
      const results = await db.exec(text);
      return (results.at(-1)?.rows ?? []) as never;
    },
  };
  return { db, sql };
}
