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
    expect(await migrate(sql)).toEqual(["0001_init.sql", "0002_review_access.sql", "0003_media_jobs.sql", "0004_media_jobs_images.sql", "0005_requests_and_uploads.sql", "0006_recovery.sql"]);
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

describe("cli: own and generated media into drafts", () => {
  it("registers a photo, generates a video, and uses both in a draft", async () => {
    const { sql } = await freshDb();
    const { fn, calls } = mockFetch([
      { match: (u) => u.includes("api.higgsfield.ai/estimate/"), reply: () => json({ type: "estimate", usd: "0.10" }) },
      { match: (u) => u === "https://api.higgsfield.ai/kling-video/v2.5-turbo/standard/image-to-video", reply: () => json({ request_id: "req-abcdefgh1" }) },
      { match: (u) => u.includes("/requests/req-abcdefgh1/status"), reply: () => json({ status: "completed", video: { url: "https://cdn.higgsfield.test/v.mp4" } }) },
      { match: (u) => u === "https://cdn.higgsfield.test/v.mp4", reply: () => new Response(new Uint8Array([1, 2, 3])) },
      { match: (u) => u.includes("/storage/v1/object/social-media/generated/"), reply: () => json({ Key: "ok" }) },
    ]);
    const env = {
      ANTHROPIC_API_KEY: "k", HIGGSFIELD_API_KEY: "kid12345:secret6789", SUPABASE_URL: "https://abc.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "srv", INSTAGRAM_USER_ID: "1", INSTAGRAM_ACCESS_TOKEN: "t",
    };
    const deps = { env, sql, fetch: fn, now: () => new Date("2026-11-02T08:00:00Z"), sleep: async () => {} };

    const photoId = await runCli(["add-asset", "image", "https://cdn.test/me.jpg"], deps);
    const videoOut = await runCli(["media", "video", "slow pan", "--source", "https://cdn.test/product.jpg"], deps);
    const videoId = videoOut.replace("asset ", "");
    expect(videoOut).toMatch(/^asset [0-9a-f-]{36}$/);

    const [asset] = await sql.query<{ origin: string; uri: string }>(`select origin, uri from social_assets where id = $1`, [videoId]);
    expect(asset).toMatchObject({ origin: "generated", uri: expect.stringContaining("/storage/v1/object/public/social-media/generated/") });

    // The draft references both assets; the fake model answers with them.
    const reply = JSON.stringify({ variants: [{ channel: "instagram", text: "Se klippet", assetIds: [videoId] }] });
    const patched = mockFetch([
      { match: (u) => u === "https://api.anthropic.com/v1/messages", reply: () => json({ content: [{ type: "text", text: reply }] }) },
    ]);
    const out = await runCli(["generate", "ny produkt", "--channels", "instagram", "--assets", `${photoId},${videoId}`], { ...deps, fetch: patched.fn });
    expect(out).toMatch(/^instagram\tdraft\t/);
    const prompt = JSON.parse(String(patched.calls[0]!.init!.body)).messages[0].content as string;
    expect(prompt).toContain(videoId);
    expect(prompt).toContain('"origin":"generated"');
    expect(calls.some((c) => c.url.includes("/estimate/"))).toBe(true);

    const [draft] = await sql.query<{ asset_ids: string[] }>(`select asset_ids from social_variants`);
    expect(draft!.asset_ids).toEqual([videoId]);
  });

  it("--async leaves the job for tick to collect", async () => {
    const { sql } = await freshDb();
    let done = false;
    const { fn } = mockFetch([
      { match: (u) => u.includes("/estimate/"), reply: () => json({ type: "estimate", usd: "0.10" }) },
      { match: (u) => u.endsWith("/image-to-video") && !u.includes("estimate"), reply: () => json({ request_id: "req-abcdefgh2" }) },
      { match: (u) => u.includes("/status"), reply: () => json(done ? { status: "completed", video: { url: "https://cdn.higgsfield.test/v.mp4" } } : { status: "in_progress" }) },
      { match: (u) => u === "https://cdn.higgsfield.test/v.mp4", reply: () => new Response(new Uint8Array([1])) },
      { match: (u) => u.includes("/storage/v1/"), reply: () => json({}) },
    ]);
    const env = { HIGGSFIELD_API_KEY: "kid12345:secret6789", SUPABASE_URL: "https://abc.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "srv" };
    const deps = { env, sql, fetch: fn, sleep: async () => {} };

    const started = await runCli(["media", "video", "x", "--source", "https://cdn.test/p.jpg", "--async"], deps);
    expect(started).toMatch(/started/);
    expect(JSON.parse(await runCli(["tick"], deps)).media).toMatchObject({ completed: [], pending: 1 });
    done = true;
    expect(JSON.parse(await runCli(["tick"], deps)).media).toMatchObject({ pending: 0, completed: [expect.any(String)] });
  });

  it("explains bad input", async () => {
    const { sql } = await freshDb();
    await expect(runCli(["add-asset", "image", "http://insecure.test/a.jpg"], { env: {}, sql })).rejects.toThrow(/https/);
    await expect(runCli(["add-asset", "gif", "https://x.test/a"], { env: {}, sql })).rejects.toThrow(/usage/);
    await expect(runCli(["media", "video", "x", "--source", "https://x.test/a.jpg"], { env: {}, sql })).rejects.toThrow(/HIGGSFIELD_API_KEY/);
    await expect(runCli(["media", "image", "x"], { env: {}, sql })).rejects.toThrow(/GEMINI_API_KEY/);
    await expect(runCli(["media", "audio", "x"], { env: {}, sql })).rejects.toThrow(/usage/);
  });
});

describe("buildEngine: media", () => {
  it("rejects a non-numeric monthly cap", () => {
    expect(() => buildEngine({ MEDIA_MONTHLY_CAP_USD: "lots" }, new MemoryStore())).toThrow(/MEDIA_MONTHLY_CAP_USD/);
  });
});

describe("cli: images", () => {
  it("media image stores a Gemini image as a generated asset and accepts --aspect and --source", async () => {
    const { sql } = await freshDb();
    const png = Buffer.from([137, 80, 78, 71]).toString("base64");
    const { fn, calls } = mockFetch([
      { match: (u) => u === "https://cdn.test/p.jpg", reply: () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/jpeg" } }) },
      { match: (u) => u.includes(":generateContent"), reply: () => json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png } }] } }] }) },
      { match: (u) => u.includes("/storage/v1/"), reply: () => json({}) },
    ]);
    const env = { GEMINI_API_KEY: "AIza-test-key-1", SUPABASE_URL: "https://abc.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "srv" };
    const out = await runCli(["media", "image", "a fox on a hill", "--aspect", "9:16", "--source", "https://cdn.test/p.jpg"], { env, sql, fetch: fn });
    const id = out.replace("asset ", "");

    const [asset] = await sql.query<{ kind: string; origin: string }>(`select kind, origin from social_assets where id = $1`, [id]);
    expect(asset).toEqual({ kind: "image", origin: "generated" });
    const [job] = await sql.query<{ kind: string; status: string }>(`select kind, status from social_media_jobs where id = $1`, [id]);
    expect(job).toEqual({ kind: "image", status: "completed" });
    const gemini = calls.find((c) => c.url.includes(":generateContent"))!;
    expect(JSON.parse(String(gemini.init!.body)).generationConfig.imageConfig.aspectRatio).toBe("9:16");
  });

  it("rejects an unsupported aspect ratio before spending", async () => {
    const { sql } = await freshDb();
    const env = { GEMINI_API_KEY: "AIza-test-key-1", SUPABASE_URL: "https://abc.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "srv" };
    await expect(runCli(["media", "image", "x", "--aspect", "3:7"], { env, sql })).rejects.toThrow(/--aspect/);
  });
});
