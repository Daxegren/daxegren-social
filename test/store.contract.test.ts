import { beforeEach, describe, expect, it } from "vitest";
import type { Asset, ContentBrief, PostVariant, PublishedPost } from "../src/domain.js";
import { ContentEngine } from "../src/engine.js";
import { PostgresStore } from "../src/postgres-store.js";
import { MemoryStore, type Store } from "../src/store.js";
import { FakeAdapter, FakeGenerator } from "./helpers.js";
import { freshDb } from "./pg.js";

const uuid = () => crypto.randomUUID();
const T = "2026-11-02T08:00:00.000Z";

const makers: Array<[string, () => Promise<Store>]> = [
  ["MemoryStore", async () => new MemoryStore()],
  ["PostgresStore (PGlite)", async () => new PostgresStore((await freshDb()).sql)],
];

describe.each(makers)("Store contract: %s", (_name, make) => {
  let store: Store;
  beforeEach(async () => {
    store = await make();
  });

  const brief = (): ContentBrief => ({ id: uuid(), idea: "i", angle: "a", sourcePostIds: [], assetIds: [], createdAt: T });
  const variant = (briefId: string, over: Partial<PostVariant> = {}): PostVariant => ({
    id: uuid(), briefId, channel: "linkedin", text: "t", assetIds: [], status: "draft", attempts: 0, createdAt: T, ...over,
  });
  const post = (over: Partial<PublishedPost> = {}): PublishedPost => ({
    id: uuid(), channel: "linkedin", externalId: "e1", text: "p", mediaKinds: ["image"], publishedAt: T, ...over,
  });

  it("round-trips assets, preserving the requested order and skipping unknown ids", async () => {
    const mk = (n: number): Asset => ({ id: uuid(), kind: "image", origin: "captured", uri: `https://x.test/${n}`, createdAt: T, meta: { n } });
    const [a, b] = [mk(1), mk(2)];
    await store.putAsset(a);
    await store.putAsset(b);
    expect(await store.getAssets([b.id, uuid(), a.id])).toEqual([b, a]);
    expect(await store.getAssets([])).toEqual([]);
  });

  it("round-trips briefs", async () => {
    const b = brief();
    await store.putBrief(b);
    expect(await store.getBrief(b.id)).toEqual(b);
    expect(await store.getBrief(uuid())).toBeUndefined();
  });

  it("round-trips variants, including optional fields, and filters by status and brief", async () => {
    const b = brief();
    await store.putBrief(b);
    const full = variant(b.id, {
      status: "published", rationale: "why", scheduledAt: T, attempts: 2, lastError: "e",
      externalId: "x", url: "https://u.test", publishedAt: T,
    });
    const plain = variant(b.id);
    await store.putVariant(full);
    await store.putVariant(plain);

    expect(await store.getVariant(full.id)).toEqual(full);
    expect(await store.getVariant(plain.id)).toEqual(plain);
    expect((await store.listVariants({ status: "draft" })).map((v) => v.id)).toEqual([plain.id]);
    expect(await store.listVariants({ briefId: b.id })).toHaveLength(2);
  });

  it("putVariant updates in place", async () => {
    const b = brief();
    await store.putBrief(b);
    const v = variant(b.id);
    await store.putVariant(v);
    await store.putVariant({ ...v, text: "edited", status: "scheduled", scheduledAt: T });
    expect(await store.getVariant(v.id)).toMatchObject({ text: "edited", status: "scheduled", scheduledAt: T });
    expect(await store.listVariants()).toHaveLength(1);
  });

  it("transitionVariant is a compare-and-swap: only one of two claims wins", async () => {
    const b = brief();
    await store.putBrief(b);
    const v = variant(b.id, { status: "scheduled", scheduledAt: T });
    await store.putVariant(v);

    const results = await Promise.all([
      store.transitionVariant(v.id, "scheduled", "publishing"),
      store.transitionVariant(v.id, "scheduled", "publishing"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.getVariant(v.id))!.status).toBe("publishing");
    expect(await store.transitionVariant(v.id, "scheduled", "publishing")).toBeUndefined();
  });

  it("upsertPost is keyed on (channel, externalId) and keeps id, metrics and provenance", async () => {
    const variantId = uuid();
    const b = brief();
    await store.putBrief(b);
    await store.putVariant(variant(b.id, { id: variantId }));

    const first = await store.upsertPost(post({ variantId, metrics: { likes: 3, collectedAt: T } }));
    const again = await store.upsertPost(post({ text: "edited" })); // re-ingest: no metrics, no variantId

    expect(again.id).toBe(first.id);
    expect(again).toMatchObject({ text: "edited", variantId, metrics: { likes: 3 } });
    expect(await store.listPosts()).toHaveLength(1);
    await store.upsertPost(post({ channel: "x", externalId: "e1" }));
    expect(await store.listPosts({ channel: "x" })).toHaveLength(1);
    expect(await store.getPost(first.id)).toEqual(again);
  });
});

describe("ContentEngine on PostgresStore", () => {
  it("runs generate → approve → publish → learn end to end", async () => {
    const { sql } = await freshDb();
    const store = new PostgresStore(sql);
    const linkedin = new FakeAdapter("linkedin");
    const engine = new ContentEngine({
      store,
      adapters: { linkedin },
      generator: new FakeGenerator(),
      now: () => new Date(T),
    });

    const b = await engine.createBrief({ idea: "x" });
    const [v] = await engine.proposeVariants(b.id, ["linkedin"]);
    await engine.approve(v!.id);
    expect((await engine.tick()).published).toEqual([v!.id]);

    expect(await store.getVariant(v!.id)).toMatchObject({ status: "published", externalId: "ext-1" });
    const posts = await store.listPosts({ channel: "linkedin" });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.variantId).toBe(v!.id);
  });
});
