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

  it("nobody authenticated can insert or delete", async () => {
    await expect(as(ADMIN, () => db.query(`delete from social_variants where id = $1`, [draftId]))).rejects.toThrow(/permission denied/);
    await expect(
      as(ADMIN, () => db.query(`insert into social_briefs (idea) values ('x')`)),
    ).rejects.toThrow(/permission denied/);
  });
});
