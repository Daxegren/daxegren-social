#!/usr/bin/env node
import pg from "pg";
import { runCli, USAGE } from "./cli.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(`DATABASE_URL is not set.\n\n${USAGE}`);
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: url, max: 2 });
try {
  console.log(await runCli(process.argv.slice(2), { env: process.env, sql: { query: async (t, p) => (await pool.query(t, p as never[])).rows } }));
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
