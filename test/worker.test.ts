import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/store.js";
import { runCli } from "../src/worker/cli.js";
import { buildEngine } from "../src/worker/env.js";
import { migrate } from "../src/worker/migrate.js";
import { json, mockFetch } from "./helpers.js";
import { bareDb, freshDb } from "./pg.js";

describe("buildEngine", () => {
  it("enables a channel only when all of its credentials are present", () => {
    const none = buildEngine({}, new MemoryStore());
    expect(none.configuredChannels).toEqual([]);

    const partial = buildEngine({ LINKEDIN_AUTHOR_URN: "urn:li:person:1" }, new MemoryStore());
    expect(partial.configuredChannels).toEqual([]);

    const both = buildEngine(
      { LINKEDIN_AUTHOR_URN: "u", LINKEDIN_ACCESS_TOKEN: "t", INSTAGRAM_USER_ID: "1", INSTAGRAM_ACCESS_TOKEN: "t" },
      new MemoryStore(),
    );
    expect(both.configuredChannels.sort()).toEqual(["instagram", "linkedin"]);
  });

  it("rejects an unknown channel in AUTO_APPROVE_CHANNELS instead of silently ignoring it", () => {
    expect(() => buildEngine({ AUTO_APPROVE_CHANNELS: "linkedin,myspace" }, new MemoryStore())).toThrow(/myspace/);
  });
});

describe("migrate", () => {
  it("applies every migration once and is a no-op the second time", async () => {
    const { sql } = await bareDb();
    expect(await migrate(sql)).toEqual(["0001_init.sql", "0002_review_access.sql"]);
    expect(await migrate(sql)).toEqual([]);
    const tables = await sql.query<{ n: number }>(`select count(*)::int as n from social_variants`);
    expect(tables[0]!.n).toBe(0);
  });

  it("rolls a failing migration back completely and does not record it", async () => {
    const { sql } = await bareDb();
    const dir = new URL("./fixtures/bad-migrations/", import.meta.url);
    await expect(migrate(sql, dir)).rejects.toThrow();
    expect(await sql.query(`select * from social_migrations`)).toEqual([]);
    // the table created before the failing statement must not exist
    await expect(sql.query(`select * from half_applied`)).rejects.toThrow();
  });
});

describe("cli: generate → review in the database → tick", () => {
  it("drafts content, publishes it once approved, and learns from the result", async () => {
    const { sql } = await freshDb();
    const { fn, calls } = mockFetch([
      {
        match: (u) => u === "https://api.anthropic.com/v1/messages",
        reply: () => json({ content: [{ type: "text", text: '{"variants":[{"channel":"linkedin","text":"Hej från motorn","assetIds":[],"rationale":"test"}]}' }] }),
      },
      {
        match: (u) => u.endsWith("/rest/posts"),
        reply: () => new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:42" } }),
      },
    ]);
    const env = { ANTHROPIC_API_KEY: "k", LINKEDIN_AUTHOR_URN: "urn:li:person:me", LINKEDIN_ACCESS_TOKEN: "t" };
    const deps = { env, sql, fetch: fn, now: () => new Date("2026-11-02T08:00:00Z") };

    const generated = await runCli(["generate", "Varför vi bygger öppet", "--channels", "linkedin", "--goal", "räckvidd"], deps);
    const [channel, status, id] = generated.split("\t");
    expect([channel, status]).toEqual(["linkedin", "draft"]);

    // Nothing is published while the draft is unreviewed.
    expect(JSON.parse(await runCli(["tick"], deps)).published).toEqual([]);
    expect(calls.some((c) => c.url.endsWith("/rest/posts"))).toBe(false);

    // The review UI does exactly this update.
    await sql.query(`update social_variants set status = 'scheduled', scheduled_at = $2 where id = $1`, [id, "2026-11-02T07:00:00Z"]);

    expect(JSON.parse(await runCli(["tick"], deps)).published).toEqual([id]);
    const [row] = await sql.query<{ status: string; external_id: string }>(`select status, external_id from social_variants where id = $1`, [id]);
    expect(row).toEqual({ status: "published", external_id: "urn:li:share:42" });
    const [post] = await sql.query<{ variant_id: string }>(`select variant_id from social_posts where external_id = 'urn:li:share:42'`);
    expect(post!.variant_id).toBe(id);
  });

  it("uses the configured channels when --channels is omitted", async () => {
    const { sql } = await freshDb();
    const { fn } = mockFetch([
      { match: () => true, reply: () => json({ content: [{ type: "text", text: '{"variants":[{"channel":"linkedin","text":"x"}]}' }] }) },
    ]);
    const out = await runCli(["generate", "idé"], { env: { ANTHROPIC_API_KEY: "k", LINKEDIN_AUTHOR_URN: "u", LINKEDIN_ACCESS_TOKEN: "t" }, sql, fetch: fn });
    expect(out).toMatch(/^linkedin\tdraft\t/);
  });

  it("fails clearly on missing config and bad input", async () => {
    const { sql } = await freshDb();
    await expect(runCli(["generate", "idé", "--channels", "linkedin"], { env: {}, sql })).rejects.toThrow(/ANTHROPIC_API_KEY/);
    await expect(runCli(["generate"], { env: {}, sql })).rejects.toThrow(/needs an idea/);
    await expect(runCli(["ingest", "myspace"], { env: {}, sql })).rejects.toThrow(/expected a channel/);
    await expect(runCli(["ingest", "linkedin"], { env: {}, sql })).rejects.toThrow(/no adapter configured/);
    await expect(runCli(["bogus"], { env: {}, sql })).rejects.toThrow(/unknown command/);
  });
});
