import { describe, expect, it } from "vitest";
import { runCli } from "../src/worker/cli.js";
import { formatReport, runDoctor, scrubSecrets, type Check } from "../src/worker/doctor.js";
import { migrate } from "../src/worker/migrate.js";
import { json, mockFetch } from "./helpers.js";
import { bareDb, freshDb } from "./pg.js";

const byName = (checks: Check[], name: string) => checks.find((c) => c.name === name)!;

describe("doctor", () => {
  it("reports a clean, minimal setup without calling any external service", async () => {
    const { sql } = await freshDb();
    const { fn, calls } = mockFetch([]);
    // freshDb applies migrations by hand, so record them the way `migrate` would
    await bareMigrated(sql);
    const checks = await runDoctor({ env: {}, sql, fetch: fn });
    expect(byName(checks, "database").status).toBe("ok");
    expect(byName(checks, "channels").status).toBe("warn");
    expect(byName(checks, "storage").status).toBe("skip");
    expect(calls).toHaveLength(0);
  });

  it("fails, with the fix, when migrations have not run", async () => {
    const { sql } = await bareDb();
    const checks = await runDoctor({ env: {}, sql, fetch: mockFetch([]).fn });
    expect(byName(checks, "database")).toMatchObject({ status: "fail", detail: expect.stringContaining("migrate") });
  });

  it("warns when nobody can review, and fails when only some migrations ran", async () => {
    const { sql } = await bareDb();
    await migrate(sql);
    expect(byName(await runDoctor({ env: {}, sql }), "reviewer").status).toBe("warn");

    const partial = await bareDb();
    await partial.sql.query(`create table social_migrations (name text primary key, applied_at timestamptz default now()); insert into social_migrations (name) values ('0001_init.sql');`);
    const c = byName(await runDoctor({ env: {}, sql: partial.sql }), "database");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("0002_review_access.sql");
  });

  it("checks storage: ok when public, fail when missing or private", async () => {
    const { sql } = await freshDb();
    await bareMigrated(sql);
    const env = { SUPABASE_URL: "https://abc.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "srv-role-key-123" };
    const run = (reply: () => Response) => runDoctor({ env, sql, fetch: mockFetch([{ match: (u) => u.includes("/storage/v1/bucket/social-media"), reply }]).fn }).then((c) => byName(c, "storage"));
    expect((await run(() => json({ public: true }))).status).toBe("ok");
    expect(await run(() => json({ public: false }))).toMatchObject({ status: "fail", detail: expect.stringContaining("private") });
    expect(await run(() => new Response("{}", { status: 404 }))).toMatchObject({ status: "fail", detail: expect.stringContaining("not found") });
  });

  it("gemini: confirms the model, or lists the image models that exist", async () => {
    const { sql } = await freshDb();
    await bareMigrated(sql);
    const run = (models: unknown, status = 200, env: Record<string, string> = {}) =>
      runDoctor({ env: { GEMINI_API_KEY: "AIza-key-123456", ...env }, sql, fetch: mockFetch([{ match: (u) => u.includes("generativelanguage"), reply: () => json(models, { status }) }]).fn }).then((c) => byName(c, "gemini"));

    expect((await run({ models: [{ name: "models/gemini-2.5-flash-image", supportedGenerationMethods: ["generateContent"] }] })).status).toBe("ok");
    const missing = await run({ models: [{ name: "models/gemini-3-pro-image-preview" }, { name: "models/gemini-2.5-pro" }] });
    expect(missing).toMatchObject({ status: "warn", detail: expect.stringContaining("gemini-3-pro-image-preview") });
    expect((await run({ models: [{ name: "models/custom-image" }] }, 200, { GEMINI_IMAGE_MODEL: "custom-image" })).status).toBe("ok");
    expect(await run({}, 403)).toMatchObject({ status: "fail", detail: expect.stringContaining("AI Studio") });
  });

  it("anthropic and instagram: classify keys", async () => {
    const { sql } = await freshDb();
    await bareMigrated(sql);
    const env = { ANTHROPIC_API_KEY: "sk-ant-key-123456", INSTAGRAM_USER_ID: "178", INSTAGRAM_ACCESS_TOKEN: "EAAB-token-123456" };
    const good = await runDoctor({
      env, sql,
      fetch: mockFetch([
        { match: (u) => u.includes("api.anthropic.com"), reply: () => json({ data: [{ id: "claude-sonnet-5-5" }] }) },
        { match: (u) => u.includes("graph.facebook.com"), reply: () => json({ id: "178", username: "david" }) },
      ]).fn,
    });
    expect(byName(good, "anthropic").status).toBe("ok");
    expect(byName(good, "instagram")).toMatchObject({ status: "ok", detail: expect.stringContaining("david") });

    const bad = await runDoctor({
      env, sql,
      fetch: mockFetch([
        { match: (u) => u.includes("api.anthropic.com"), reply: () => new Response("{}", { status: 401 }) },
        { match: (u) => u.includes("graph.facebook.com"), reply: () => json({ error: { message: "Invalid OAuth access token EAAB-token-123456" } }, { status: 400 }) },
      ]).fn,
    });
    expect(byName(bad, "anthropic").status).toBe("fail");
    const ig = byName(bad, "instagram");
    expect(ig.status).toBe("fail");
    expect(ig.detail).not.toContain("EAAB-token-123456"); // never echoes the token
  });

  it("a crashing check becomes a failed line instead of aborting the report, with secrets removed", async () => {
    const { sql } = await freshDb();
    await bareMigrated(sql);
    const throwing = (async () => { throw new Error("connect ECONNREFUSED using key AIza-key-123456"); }) as typeof fetch;
    const checks = await runDoctor({ env: { GEMINI_API_KEY: "AIza-key-123456" }, sql, fetch: throwing });
    const g = byName(checks, "gemini");
    expect(g.status).toBe("fail");
    expect(g.detail).not.toContain("AIza-key-123456");
    expect(byName(checks, "database").status).toBe("ok");
  });

  it("invalid configuration is reported, not thrown", async () => {
    const { sql } = await freshDb();
    const checks = await runDoctor({ env: { AUTO_APPROVE_CHANNELS: "myspace" }, sql, fetch: mockFetch([]).fn });
    expect(byName(checks, "config")).toMatchObject({ status: "fail", detail: expect.stringContaining("myspace") });
  });

  it("validates the LinkedIn URN format", async () => {
    const { sql } = await freshDb();
    const c = byName(await runDoctor({ env: { LINKEDIN_AUTHOR_URN: "me", LINKEDIN_ACCESS_TOKEN: "tok-123456" }, sql, fetch: mockFetch([]).fn }), "linkedin");
    expect(c.status).toBe("fail");
  });

  it("scrubSecrets removes secret values and their `id:secret` halves, nothing else", () => {
    const env = { HIGGSFIELD_API_KEY: "keyid1234:secretsecret99", NAME: "keyid1234" };
    expect(scrubSecrets("bad keyid1234:secretsecret99 / secretsecret99 / keyid1234", env)).toBe("bad [redacted] / [redacted] / [redacted]");
    expect(scrubSecrets("keep me", env)).toBe("keep me");
  });

  it("cli: prints the report, and exits non-zero (throws) only on failures", async () => {
    const { sql } = await freshDb();
    await bareMigrated(sql);
    const okReport = await runCli(["doctor"], { env: {}, sql, fetch: mockFetch([]).fn });
    expect(okReport).toMatch(/✓ database/);
    expect(okReport).toMatch(/no problems found/);

    const bad = await bareDb();
    await expect(runCli(["doctor"], { env: {}, sql: bad.sql, fetch: mockFetch([]).fn })).rejects.toThrow(/✗ database[\s\S]*problem\(s\) to fix/);
  });

  it("formatReport aligns names and counts problems", () => {
    const text = formatReport([
      { name: "a", status: "ok", detail: "fine" },
      { name: "longer", status: "fail", detail: "broken" },
      { name: "b", status: "warn", detail: "hmm" },
    ]);
    expect(text).toContain("✓ a       fine");
    expect(text).toContain("1 problem(s) to fix, 1 warning(s)");
  });
});

/** freshDb applies the SQL by hand; record the files in social_migrations as `migrate` would. */
async function bareMigrated(sql: Parameters<typeof migrate>[0]) {
  await sql.query(`create table if not exists social_migrations (name text primary key, applied_at timestamptz default now())`);
  const { migrationFiles } = await import("../src/worker/migrate.js");
  for (const name of migrationFiles()) await sql.query(`insert into social_migrations (name) values ($1) on conflict do nothing`, [name]);
}
