import { beforeEach, describe, expect, it } from "vitest";
import { PostgresStore } from "../src/postgres-store.js";
import { freshDb } from "./pg.js";

type Db = Awaited<ReturnType<typeof freshDb>>["db"];

const ADMIN = "00000000-0000-0000-0000-0000000000a1";
const STRANGER = "00000000-0000-0000-0000-0000000000b2";
const T = "2026-11-02T08:00:00.000Z";

let db: Db;
let draftId: string;
let scheduledId: string;

async function as<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role authenticated; select set_config('test.uid', '${uid}', false);`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role; select set_config('test.uid', '', false);`);
  }
}

beforeEach(async () => {
  const f = await freshDb();
  db = f.db;
  await db.exec(`
    insert into auth.users (id) values ('${ADMIN}'), ('${STRANGER}');
    insert into social_admins (user_id) values ('${ADMIN}');
  `);
  const store = new PostgresStore(f.sql);
  const briefId = crypto.randomUUID();
  await store.putBrief({ id: briefId, idea: "i", sourcePostIds: [], assetIds: [], createdAt: T });
  draftId = crypto.randomUUID();
  scheduledId = crypto.randomUUID();
  const base = { briefId, channel: "linkedin" as const, text: "t", assetIds: [], attempts: 0, createdAt: T };
  await store.putVariant({ ...base, id: draftId, status: "draft" });
  await store.putVariant({ ...base, id: scheduledId, status: "scheduled", scheduledAt: T });
});

describe("review queue access (RLS)", () => {
  it("a signed-in user who is not an admin sees nothing", async () => {
    const rows = await as(STRANGER, async () => (await db.query(`select * from social_variants`)).rows);
    expect(rows).toHaveLength(0);
  });

  it("an admin can read variants", async () => {
    const rows = await as(ADMIN, async () => (await db.query(`select id from social_variants`)).rows);
    expect(rows).toHaveLength(2);
  });

  it("an admin can approve a draft: edit text, set time, schedule", async () => {
    const res = await as(ADMIN, () =>
      db.query(`update social_variants set body = 'edited', scheduled_at = $2, status = 'scheduled' where id = $1 returning status, body`, [draftId, T]),
    );
    expect(res.rows).toEqual([{ status: "scheduled", body: "edited" }]);
  });

  it("an admin can reject a draft", async () => {
    const res = await as(ADMIN, () => db.query(`update social_variants set status = 'rejected' where id = $1 returning status`, [draftId]));
    expect(res.rows).toEqual([{ status: "rejected" }]);
  });

  it("an admin cannot publish-by-hand: 'published' and 'publishing' are refused", async () => {
    for (const status of ["published", "publishing"]) {
      await expect(
        as(ADMIN, () => db.query(`update social_variants set status = '${status}' where id = $1`, [draftId])),
      ).rejects.toThrow(/row-level security/);
    }
  });

  it("an admin cannot touch non-draft rows", async () => {
    const res = await as(ADMIN, () => db.query(`update social_variants set body = 'x' where id = $1 returning id`, [scheduledId]));
    expect(res.rows).toHaveLength(0);
  });

  it("an admin cannot edit columns outside the review surface", async () => {
    await expect(
      as(ADMIN, () => db.query(`update social_variants set attempts = 0 where id = $1`, [draftId])),
    ).rejects.toThrow(/permission denied/);
  });

  it("a non-admin cannot approve anything", async () => {
    const res = await as(STRANGER, () => db.query(`update social_variants set status = 'scheduled' where id = $1 returning id`, [draftId]));
    expect(res.rows).toHaveLength(0);
  });

  it("media jobs are readable by admins only, and read-only", async () => {
    await db.exec(`insert into social_media_jobs (kind, provider, model, prompt, estimated_cost_usd) values ('video', 'p', 'm', 'x', 0.1)`);
    expect((await as(ADMIN, () => db.query(`select id from social_media_jobs`))).rows).toHaveLength(1);
    expect((await as(STRANGER, () => db.query(`select id from social_media_jobs`))).rows).toHaveLength(0);
    await expect(as(ADMIN, () => db.query(`update social_media_jobs set status = 'completed'`))).rejects.toThrow(/permission denied/);
  });

  it("nobody authenticated can delete, or insert where no insert is granted", async () => {
    await expect(as(ADMIN, () => db.query(`delete from social_variants where id = $1`, [draftId]))).rejects.toThrow(/permission denied/);
    await expect(as(ADMIN, () => db.query(`insert into social_variants (brief_id, channel, body) values (gen_random_uuid(), 'x', 'y')`))).rejects.toThrow(/permission denied/);
    await expect(as(ADMIN, () => db.query(`insert into social_media_jobs (kind, provider, model, prompt, estimated_cost_usd) values ('video','p','m','x',0)`))).rejects.toThrow(/permission denied/);
  });
});

const PUBLIC_UPLOAD = (uid: string, file = "a.jpg") => `https://abc.supabase.co/storage/v1/object/public/social-media/uploads/${uid}/${file}`;

describe("requests and uploads from the app (RLS)", () => {
  const request = (channels = `array['linkedin','instagram']`, status = "requested") =>
    `insert into social_briefs (idea, channels, status) values ('an idea', ${channels}, '${status}') returning id, status`;

  it("a reviewer can request drafts, and the request starts as 'requested'", async () => {
    const res = await as(ADMIN, () => db.query(request()));
    expect(res.rows).toEqual([{ id: expect.any(String), status: "requested" }]);
    expect((await as(ADMIN, () => db.query(`select count(*)::int as n from social_briefs where status = 'requested'`))).rows).toEqual([{ n: 1 }]);
  });

  it("anyone else is refused", async () => {
    await expect(as(STRANGER, () => db.query(request()))).rejects.toThrow(/row-level security/);
  });

  it("a reviewer cannot insert a brief in any other state, or write results", async () => {
    for (const status of ["ready", "processing", "failed"]) {
      await expect(as(ADMIN, () => db.query(request(`array['linkedin']`, status)))).rejects.toThrow(/row-level security/);
    }
    await expect(as(ADMIN, () => db.query(`insert into social_briefs (idea, channels, status, error) values ('x', array['x'], 'requested', 'e')`))).rejects.toThrow(/permission denied/);
    await expect(as(ADMIN, () => db.query(`update social_briefs set status = 'ready'`))).rejects.toThrow(/permission denied/);
  });

  it("rejects requests with unknown, empty or missing channels, and oversized ideas", async () => {
    await expect(as(ADMIN, () => db.query(request(`array['myspace']`)))).rejects.toThrow(/social_briefs_requested_valid/);
    await expect(as(ADMIN, () => db.query(request(`array[]::text[]`)))).rejects.toThrow(/social_briefs_requested_valid/);
    await expect(as(ADMIN, () => db.query(request(`null`)))).rejects.toThrow(/social_briefs_requested_valid/);
    await expect(as(ADMIN, () => db.query(`insert into social_briefs (idea, channels, status) values ('${"x".repeat(2001)}', array['x'], 'requested')`))).rejects.toThrow(/social_briefs_idea_length/);
  });

  it("a reviewer can register an upload from this project's media folder, as 'captured' only", async () => {
    const ok = await as(ADMIN, () => db.query(`insert into social_assets (kind, origin, uri) values ('image', 'captured', '${PUBLIC_UPLOAD(ADMIN)}') returning id`));
    expect(ok.rows).toHaveLength(1);
    await expect(as(ADMIN, () => db.query(`insert into social_assets (kind, origin, uri) values ('image', 'generated', '${PUBLIC_UPLOAD(ADMIN)}')`))).rejects.toThrow(/row-level security/);
  });

  it("refuses assets that point anywhere else, including a link with a query string", async () => {
    for (const uri of ["https://evil.example/x.jpg", "http://abc.supabase.co/storage/v1/object/public/social-media/uploads/a.jpg",
      "https://abc.supabase.co/storage/v1/object/public/other-bucket/uploads/a.jpg", `${PUBLIC_UPLOAD(ADMIN)}?token=1`]) {
      await expect(as(ADMIN, () => db.query(`insert into social_assets (kind, origin, uri) values ('image', 'captured', '${uri}')`)), uri).rejects.toThrow(/row-level security/);
    }
    await expect(as(STRANGER, () => db.query(`insert into social_assets (kind, origin, uri) values ('image', 'captured', '${PUBLIC_UPLOAD(STRANGER)}')`))).rejects.toThrow(/row-level security/);
  });

  it("a reviewer can upload only into uploads/<own id>/ in the media bucket", async () => {
    const put = (uid: string, bucket: string, name: string) =>
      as(uid, () => db.query(`insert into storage.objects (bucket_id, name) values ('${bucket}', '${name}')`));
    await expect(put(ADMIN, "social-media", `uploads/${ADMIN}/a.jpg`)).resolves.toBeDefined();
    await expect(put(ADMIN, "social-media", `uploads/${STRANGER}/a.jpg`)).rejects.toThrow(/row-level security/); // someone else's folder
    await expect(put(ADMIN, "social-media", `generated/a.jpg`)).rejects.toThrow(/row-level security/); // the worker's folder
    await expect(put(ADMIN, "other-bucket", `uploads/${ADMIN}/a.jpg`)).rejects.toThrow(/row-level security/);
    await expect(put(STRANGER, "social-media", `uploads/${STRANGER}/a.jpg`)).rejects.toThrow(/row-level security/); // not a reviewer
  });

  it("the migration creates the public media bucket", async () => {
    const { migrate } = await import("../src/worker/migrate.js");
    const { bareDb } = await import("./pg.js");
    const fresh = await bareDb();
    await migrate(fresh.sql);
    const rows = (await fresh.db.query(`select id, public, file_size_limit::int as limit, allowed_mime_types from storage.buckets`)).rows;
    expect(rows).toEqual([{ id: "social-media", public: true, limit: 52428800, allowed_mime_types: ["image/*", "video/*"] }]);
  });
});
