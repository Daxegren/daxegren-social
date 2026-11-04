import { describe, expect, it } from "vitest";
import { ContentEngine } from "../src/engine.js";
import { MemoryStore } from "../src/store.js";
import { FakeAdapter, FakeGenerator, permanent, transient } from "./helpers.js";

const T0 = new Date("2026-11-02T08:00:00Z");

function setup(opts: { autoApprove?: Array<"linkedin" | "instagram"> } = {}) {
  const store = new MemoryStore();
  const linkedin = new FakeAdapter("linkedin");
  const instagram = new FakeAdapter("instagram");
  let now = T0;
  const engine = new ContentEngine({
    store,
    adapters: { linkedin, instagram },
    generator: new FakeGenerator(),
    autoApprove: opts.autoApprove,
    scheduler: { maxAttempts: 3, backoffMs: () => 60_000 },
    now: () => now,
  });
  return { store, engine, linkedin, instagram, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe("review gate", () => {
  it("puts generated variants in draft and publishes nothing until approved", async () => {
    const { engine, linkedin } = setup();
    const brief = await engine.createBrief({ idea: "why we build in public" });
    const variants = await engine.proposeVariants(brief.id, ["linkedin"]);

    expect(variants.map((v) => v.status)).toEqual(["draft"]);
    expect((await engine.tick()).published).toEqual([]);
    expect(linkedin.published).toHaveLength(0);
  });

  it("approve schedules, tick publishes, and the post enters the learning corpus", async () => {
    const { engine, store, linkedin } = setup();
    const brief = await engine.createBrief({ idea: "x" });
    const [v] = await engine.proposeVariants(brief.id, ["linkedin"]);
    await engine.approve(v!.id);

    const res = await engine.tick();
    expect(res.published).toEqual([v!.id]);
    expect(linkedin.published).toHaveLength(1);

    const stored = await store.getVariant(v!.id);
    expect(stored).toMatchObject({ status: "published", externalId: "ext-1", attempts: 1 });
    const posts = await store.listPosts({ channel: "linkedin" });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.variantId).toBe(v!.id);
  });

  it("does not publish before scheduledAt", async () => {
    const { engine, linkedin } = setup();
    const brief = await engine.createBrief({ idea: "x" });
    const [v] = await engine.proposeVariants(brief.id, ["linkedin"]);
    await engine.approve(v!.id, { scheduledAt: new Date(T0.getTime() + 3_600_000) });

    expect((await engine.tick()).published).toEqual([]);
    expect(linkedin.published).toHaveLength(0);
  });

  it("refuses to approve a variant that violates channel limits", async () => {
    const { engine } = setup();
    const brief = await engine.createBrief({ idea: "x" });
    const [v] = await engine.proposeVariants(brief.id, ["instagram"]); // instagram needs media
    await expect(engine.approve(v!.id)).rejects.toThrow(/requires media/);
  });

  it("rejected drafts are never published", async () => {
    const { engine, linkedin } = setup();
    const brief = await engine.createBrief({ idea: "x" });
    const [v] = await engine.proposeVariants(brief.id, ["linkedin"]);
    await engine.reject(v!.id);
    await engine.tick();
    expect(linkedin.published).toHaveLength(0);
  });
});

describe("auto-approve", () => {
  it("schedules valid variants on opted-in channels, leaves the rest as drafts", async () => {
    const { engine } = setup({ autoApprove: ["linkedin"] });
    const brief = await engine.createBrief({ idea: "x" });
    const variants = await engine.proposeVariants(brief.id, ["linkedin", "instagram"]);

    const byChannel = Object.fromEntries(variants.map((v) => [v.channel, v]));
    expect(byChannel.linkedin!.status).toBe("scheduled");
    expect(byChannel.instagram!.status).toBe("draft");
  });

  it("keeps an invalid variant as draft and records why", async () => {
    const { engine } = setup({ autoApprove: ["instagram"] });
    const brief = await engine.createBrief({ idea: "x" });
    const [v] = await engine.proposeVariants(brief.id, ["instagram"]);
    expect(v!.status).toBe("draft");
    expect(v!.lastError).toMatch(/not auto-approved/);
  });
});

describe("retry behaviour", () => {
  async function scheduled() {
    const ctx = setup();
    const brief = await ctx.engine.createBrief({ idea: "x" });
    const [v] = await ctx.engine.proposeVariants(brief.id, ["linkedin"]);
    await ctx.engine.approve(v!.id);
    return { ...ctx, id: v!.id };
  }

  it("retries transient failures with backoff and then succeeds", async () => {
    const { engine, store, linkedin, advance, id } = await scheduled();
    linkedin.failures = [transient()];

    expect((await engine.tick()).retried).toEqual([id]);
    expect((await store.getVariant(id))!.status).toBe("scheduled");

    // Not due again until the backoff has elapsed.
    expect((await engine.tick()).published).toEqual([]);
    advance(61_000);
    expect((await engine.tick()).published).toEqual([id]);
    expect((await store.getVariant(id))!.attempts).toBe(2);
  });

  it("fails permanently on a permanent error without retrying", async () => {
    const { engine, store, linkedin, id } = await scheduled();
    linkedin.failures = [permanent()];

    expect((await engine.tick()).failed).toEqual([id]);
    expect(await store.getVariant(id)).toMatchObject({ status: "failed", attempts: 1, lastError: "rejected" });
  });

  it("gives up after maxAttempts", async () => {
    const { engine, store, linkedin, advance, id } = await scheduled();
    linkedin.failures = [transient(), transient(), transient()];

    for (let i = 0; i < 3; i++) {
      await engine.tick();
      advance(61_000);
    }
    expect((await store.getVariant(id))!.status).toBe("failed");
  });

  it("failed variants can be put back in the queue", async () => {
    const { engine, store, linkedin, id } = await scheduled();
    linkedin.failures = [permanent()];
    await engine.tick();

    await engine.retry(id);
    expect((await engine.tick()).published).toEqual([id]);
    expect((await store.getVariant(id))!.status).toBe("published");
  });
});

describe("concurrency", () => {
  it("two overlapping ticks publish a variant exactly once", async () => {
    const { engine, linkedin } = setup();
    const brief = await engine.createBrief({ idea: "x" });
    const [v] = await engine.proposeVariants(brief.id, ["linkedin"]);
    await engine.approve(v!.id);

    await Promise.all([engine.tick(), engine.tick()]);
    expect(linkedin.published).toHaveLength(1);
  });
});

describe("learning loop", () => {
  it("imported posts with metrics shape insights and scheduling", async () => {
    const { engine } = setup();
    const post = (hour: number, likes: number, text = "hello") => ({
      channel: "linkedin" as const,
      externalId: `p-${hour}-${likes}`,
      text,
      mediaKinds: [] as never[],
      publishedAt: `2026-10-0${1 + (likes % 5)}T${String(hour).padStart(2, "0")}:00:00Z`,
      metrics: { impressions: 1000, likes, collectedAt: T0.toISOString() },
    });
    await engine.importPosts([post(9, 80), post(9, 70), post(15, 5), post(15, 3)]);

    const insights = await engine.analyze(["linkedin"]);
    expect(insights.linkedin!.bestHoursUtc[0]).toBe(9);
    expect(insights.linkedin!.topPosts[0]!.engagementRate).toBeCloseTo(0.08);
  });

  it("importPosts is idempotent per (channel, externalId)", async () => {
    const { engine, store } = setup();
    const p = {
      channel: "linkedin" as const,
      externalId: "same",
      text: "a",
      mediaKinds: [] as never[],
      publishedAt: T0.toISOString(),
    };
    await engine.importPosts([p]);
    await engine.importPosts([{ ...p, text: "a (edited)" }]);
    const posts = await store.listPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toBe("a (edited)");
  });
});

describe("assets", () => {
  it("publishes a variant with a captured asset", async () => {
    const { engine, instagram } = setup();
    const photo = await engine.addCapturedAsset("image", "https://cdn.example.test/me.jpg");
    const brief = await engine.createBrief({ idea: "x", assetIds: [photo.id] });
    // A generator that attaches the captured asset to its variant.
    const store = new MemoryStore();
    const e2 = new ContentEngine({
      store,
      adapters: { instagram },
      generator: new FakeGenerator(() => ({ assetIds: [photo.id] })),
      now: () => T0,
    });
    await store.putAsset(photo);
    await store.putBrief(brief);
    const [v] = await e2.proposeVariants(brief.id, ["instagram"]);
    await e2.approve(v!.id);
    expect((await e2.tick()).published).toEqual([v!.id]);
    expect(instagram.published[0]!.assetIds).toEqual([photo.id]);
  });
});

describe("requests from the review app", () => {
  async function requested(over: Partial<Parameters<MemoryStore["putBrief"]>[0]> = {}) {
    const ctx = setup();
    const brief = {
      id: crypto.randomUUID(), idea: "from the phone", sourcePostIds: [], assetIds: [], channels: ["linkedin" as const],
      status: "requested" as const, createdAt: T0.toISOString(), ...over,
    };
    await ctx.store.putBrief(brief);
    return { ...ctx, brief };
  }

  it("tick turns a request into drafts and marks it ready", async () => {
    const { engine, store, brief } = await requested();
    const res = await engine.tick();
    expect(res.requests).toEqual({ processed: [brief.id], failed: [] });
    expect((await store.getBrief(brief.id))!.status).toBe("ready");
    const drafts = await store.listVariants({ briefId: brief.id });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ channel: "linkedin", status: "draft" });
  });

  it("a request is drafted once even when two ticks overlap", async () => {
    const { engine, store, brief } = await requested();
    await Promise.all([engine.tick(), engine.tick()]);
    expect(await store.listVariants({ briefId: brief.id })).toHaveLength(1);
  });

  it("a generator failure is written back to the request instead of crashing the tick", async () => {
    const store = new MemoryStore();
    const engine = new ContentEngine({
      store, adapters: {}, now: () => T0,
      generator: { generate: async () => { throw new Error("Claude is down"); } },
    });
    const id = crypto.randomUUID();
    await store.putBrief({ id, idea: "x", sourcePostIds: [], assetIds: [], channels: ["linkedin"], status: "requested", createdAt: T0.toISOString() });
    const res = await engine.tick();
    expect(res.requests.failed).toEqual([id]);
    expect(await store.getBrief(id)).toMatchObject({ status: "failed", error: "Claude is down" });
    expect((await engine.tick()).requests).toEqual({ processed: [], failed: [] }); // not retried forever
  });

  it("leaves briefs that are not requests alone, and rejects a request without channels", async () => {
    const { engine, store } = await requested({ status: "ready" });
    expect((await engine.tick()).requests.processed).toEqual([]);
    const id = crypto.randomUUID();
    await store.putBrief({ id, idea: "x", sourcePostIds: [], assetIds: [], channels: [], status: "requested", createdAt: T0.toISOString() });
    expect((await engine.tick()).requests.failed).toEqual([id]);
    expect((await store.getBrief(id))!.error).toMatch(/no channels/);
  });

  it("uses the request's assets when drafting", async () => {
    const ctx = setup();
    const photo = await ctx.engine.addCapturedAsset("image", "https://cdn.example.test/me.jpg");
    const seen: string[][] = [];
    const engine = new ContentEngine({
      store: ctx.store, adapters: {}, now: () => T0,
      generator: { generate: async (i) => { seen.push(i.assets.map((a) => a.id)); return i.channels.map((channel) => ({ channel, text: "t", assetIds: [] })); } },
    });
    await ctx.store.putBrief({ id: crypto.randomUUID(), idea: "x", sourcePostIds: [], assetIds: [photo.id], channels: ["linkedin"], status: "requested", createdAt: T0.toISOString() });
    await engine.tick();
    expect(seen).toEqual([[photo.id]]);
  });
});
