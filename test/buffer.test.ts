import { describe, expect, it } from "vitest";
import { listBufferChannels } from "../src/adapters/buffer-channels.js";
import { BufferAdapter, toMetrics as bufferMetrics } from "../src/adapters/buffer.js";
import { AdapterError, type HandoffState } from "../src/adapters/types.js";
import type { Asset, Metrics, PostVariant } from "../src/domain.js";
import { ContentEngine } from "../src/engine.js";
import { MemoryStore } from "../src/store.js";
import { runCli } from "../src/worker/cli.js";
import { runDoctor } from "../src/worker/doctor.js";
import { buildEngine, parseBufferChannels } from "../src/worker/env.js";
import { FakeAdapter, FakeGenerator, json, mockFetch } from "./helpers.js";
import { freshDb } from "./pg.js";

const KEY = "buf-secret-key-123456";
const variant = (text = "Ett inlägg"): PostVariant => ({ id: "v1", briefId: "b", channel: "linkedin", text, assetIds: [], status: "publishing", attempts: 1, createdAt: "2026-11-12T00:00:00Z" });
const asset = (kind: Asset["kind"], uri: string): Asset => ({ id: uri, kind, origin: "captured", uri, createdAt: "" });
const gqlBody = (init?: RequestInit) => JSON.parse(String(init!.body)) as { query: string; variables?: Record<string, any> };
const has = (word: string) => (_u: string, init?: RequestInit) => String(init?.body).includes(word);
const data = (d: unknown) => json({ data: d });

const ORG = { match: has("account {"), reply: () => data({ account: { organizations: [{ id: "org1" }] } }) };
const CHANNELS = { match: has("channels(input"), reply: () => data({ channels: [{ id: "ch1" }] }) };

const adapter = (routes: Parameters<typeof mockFetch>[0], over: { channel?: "linkedin" | "x" } = {}) => {
  const m = mockFetch(routes);
  return { buffer: new BufferAdapter({ apiKey: KEY, channelId: "ch1", channel: over.channel ?? "linkedin", fetch: m.fn }), calls: m.calls };
};
const node = (over: Record<string, unknown> = {}) => ({ id: "p1", text: "Hej", status: "sent", dueAt: "2026-11-10T08:00:00Z", sentAt: "2026-11-10T08:00:05Z", externalLink: "https://linkedin.com/feed/update/1", assets: [], error: null, metrics: null, metricsUpdatedAt: null, ...over });
const page = (nodes: unknown[], more = false) => data({ posts: { edges: nodes.map((n) => ({ node: n })), pageInfo: { hasNextPage: more, endCursor: more ? "c" : null } } });

describe("BufferAdapter.publish", () => {
  it("hands the post to Buffer: automatic, shareNow, with images and videos as assets, marked AI-assisted", async () => {
    const { buffer, calls } = adapter([{ match: has("createPost"), reply: () => data({ createPost: { post: { id: "bp1", status: "sending", externalLink: null } } }) }]);
    const res = await buffer.publish(variant("Hej världen"), [asset("image", "https://cdn.test/a.jpg"), asset("video", "https://cdn.test/b.mp4")]);

    expect(res).toEqual({ externalId: "bp1", url: undefined });
    expect(calls[0]!.url).toBe("https://api.buffer.com");
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(gqlBody(calls[0]!.init).variables!.input).toEqual({
      text: "Hej världen", channelId: "ch1", schedulingType: "automatic", mode: "shareNow", aiAssisted: true,
      assets: [{ image: { url: "https://cdn.test/a.jpg" } }, { video: { url: "https://cdn.test/b.mp4" } }],
    });
    expect(gqlBody(calls[0]!.init).query).toContain("... on MutationError");
  });

  it("a refusal from Buffer is a permanent error carrying Buffer's message", async () => {
    const { buffer } = adapter([{ match: has("createPost"), reply: () => data({ createPost: { message: "Text is required" } }) }]);
    await expect(buffer.publish(variant(), [])).rejects.toMatchObject({ permanent: true, message: expect.stringContaining("Text is required") });
  });

  it("classifies API-level and HTTP errors by what retrying could achieve", async () => {
    const err = async (reply: () => Response) => adapter([{ match: () => true, reply }]).buffer.publish(variant(), []).catch((e: AdapterError) => e);
    const code = (c: string) => () => json({ data: null, errors: [{ message: "x", extensions: { code: c } }] });
    expect(await err(code("UNAUTHORIZED"))).toMatchObject({ permanent: true, message: expect.stringContaining("UNAUTHORIZED") });
    expect(await err(code("FORBIDDEN"))).toMatchObject({ permanent: true });
    expect(await err(code("UNEXPECTED"))).toMatchObject({ permanent: false });
    expect(await err(code("RATE_LIMIT_EXCEEDED"))).toMatchObject({ permanent: false });
    expect(await err(() => new Response("slow down", { status: 429 }))).toMatchObject({ permanent: false });
    expect(await err(() => new Response("oops", { status: 503 }))).toMatchObject({ permanent: false });
    expect(await err(() => new Response("no", { status: 401 }))).toMatchObject({ permanent: true });
  });

  it("after a broken connection it looks for the post before anyone retries, and does not post twice", async () => {
    let attempts = 0;
    const { buffer, calls } = adapter([
      { match: has("createPost"), reply: () => { attempts++; throw new Error("socket hang up"); } },
      ORG, CHANNELS,
      { match: has("posts("), reply: () => page([node({ id: "bp9", text: "Ett inlägg", status: "sending", externalLink: null })]) },
    ]);
    const res = await buffer.publish(variant("Ett inlägg"), []);
    expect(res.externalId).toBe("bp9");
    expect(attempts).toBe(1);
    expect(gqlBody(calls.find((c) => String(c.init!.body).includes("posts("))!.init).query).toContain("status: [sending, scheduled, sent]");
  });

  it("with no such post it reports the original transient failure", async () => {
    const { buffer } = adapter([
      { match: has("createPost"), reply: () => { throw new Error("socket hang up"); } },
      ORG, CHANNELS, { match: has("posts("), reply: () => page([node({ text: "Något annat" })]) },
    ]);
    await expect(buffer.publish(variant("Ett inlägg"), [])).rejects.toMatchObject({ permanent: false, message: expect.stringContaining("network error") });
  });

  it("never lets the key into an error message", async () => {
    const { buffer } = adapter([{ match: () => true, reply: () => new Response(`bad token ${KEY}`, { status: 401 }) }]);
    const e = (await buffer.publish(variant(), []).catch((x: Error) => x)) as Error;
    expect(e.message).not.toContain(KEY);
  });
});

describe("BufferAdapter: reading back", () => {
  it("finds the organization that owns the channel, then reads sent posts with metrics, newest first", async () => {
    const { buffer, calls } = adapter([
      { match: has("account {"), reply: () => data({ account: { organizations: [{ id: "other" }, { id: "org1" }] } }) },
      { match: (_u, init) => String(init?.body).includes("channels(input") && gqlBody(init).variables!.org === "other", reply: () => data({ channels: [{ id: "x9" }] }) },
      { match: (_u, init) => String(init?.body).includes("channels(input") && gqlBody(init).variables!.org === "org1", reply: () => data({ channels: [{ id: "ch1" }] }) },
      {
        match: has("posts("),
        reply: () => page([
          node({ id: "p1", text: "Med bild", assets: [{ mimeType: "image/jpeg" }, { mimeType: "video/mp4" }], metrics: [{ type: "reactions", value: 12 }, { type: "comments", value: 3 }, { type: "impressions", value: 900 }], metricsUpdatedAt: "2026-11-11T05:00:00Z" }),
          node({ id: "p2", sentAt: null, dueAt: null }), // no date: cannot be placed in time
        ]),
      },
    ]);
    const posts = await buffer.fetchPublished(new Date("2026-10-01T00:00:00Z"));

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      channel: "linkedin", externalId: "p1", url: "https://linkedin.com/feed/update/1", text: "Med bild", mediaKinds: ["image", "video"],
      publishedAt: "2026-11-10T08:00:05.000Z", metrics: { likes: 12, comments: 3, impressions: 900, collectedAt: "2026-11-11T05:00:00Z" },
    });
    const q = gqlBody(calls.find((c) => String(c.init!.body).includes("posts("))!.init).query;
    expect(q).toContain('organizationId: "org1"');
    expect(q).toContain('channelIds: ["ch1"]');
    expect(q).toContain("status: [sent]");
    expect(q).toContain('startDate: "2026-10-01T00:00:00.000Z"');
    expect(q).toContain("direction: desc");
  });

  it("pages through at most three pages, to protect the request allowance", async () => {
    let n = 0;
    const { buffer } = adapter([ORG, CHANNELS, { match: has("posts("), reply: () => page([node({ id: `p${++n}` })], true) }]);
    expect(await buffer.fetchPublished()).toHaveLength(3);
    expect(n).toBe(3);
  });

  it("reads one post's metrics, and none when Buffer has none yet", async () => {
    const withMetrics = adapter([{ match: has("post(input"), reply: () => data({ post: { id: "p1", metrics: [{ type: "views", value: 40 }], metricsUpdatedAt: "2026-11-11T05:00:00Z" } }) }]);
    expect(await withMetrics.buffer.fetchMetrics("p1")).toMatchObject({ views: 40 });
    const none = adapter([{ match: has("post(input"), reply: () => data({ post: { id: "p1", metrics: null, metricsUpdatedAt: null } }) }]);
    expect(await none.buffer.fetchMetrics("p1")).toBeNull();
  });

  it("reads metrics for many posts in one request and returns only the ones asked for", async () => {
    const { buffer, calls } = adapter([ORG, CHANNELS, { match: has("posts("), reply: () => page([node({ id: "a", metrics: [{ type: "reactions", value: 1 }] }), node({ id: "b", metrics: [{ type: "reactions", value: 2 }] }), node({ id: "c", metrics: [{ type: "reactions", value: 3 }] })]) }]);
    const out = await buffer.fetchMetricsBatch(["a", "c", "zzz"]);
    expect([...out.keys()]).toEqual(["a", "c"]);
    expect(out.get("c")).toMatchObject({ likes: 3 });
    expect(calls.filter((c) => String(c.init!.body).includes("posts("))).toHaveLength(1);
  });

  it("reconcile says which handed-over posts were sent, failed or are still pending", async () => {
    const { buffer } = adapter([ORG, CHANNELS, { match: has("posts("), reply: () => page([node({ id: "ok", status: "sent" }), node({ id: "bad", status: "error", error: { message: "Channel disconnected" }, externalLink: null })]) }]);
    const out = await buffer.reconcile(["ok", "bad", "waiting"]);
    expect(out.get("ok")).toEqual({ state: "sent", url: "https://linkedin.com/feed/update/1" });
    expect(out.get("bad")).toEqual({ state: "error", error: "Channel disconnected" });
    expect(out.get("waiting")).toEqual({ state: "pending" });
  });

  it("explains a channel that is not in the account", async () => {
    const { buffer } = adapter([ORG, { match: has("channels(input"), reply: () => data({ channels: [{ id: "someone-else" }] }) }]);
    await expect(buffer.fetchPublished()).rejects.toMatchObject({ permanent: true, message: expect.stringContaining("buffer-channels") });
  });
});

describe("bufferMetrics", () => {
  const at = "2026-11-11T00:00:00Z";
  it("maps Buffer's normalised names onto ours, adding shares and reposts", () => {
    expect(bufferMetrics([{ type: "reactions", value: 10 }, { type: "shares", value: 2 }, { type: "reposts", value: 3 }, { type: "impressions", value: 500 }, { type: "reach", value: 400 }, { type: "clicks", value: 7 }, { type: "saves", value: 1 }, { type: "engagementRate", value: 4.2 }], at)).toEqual({
      impressions: 500, reach: 400, views: undefined, likes: 10, comments: undefined, shares: 5, saves: 1, clicks: 7, collectedAt: at,
    });
  });
  it("returns nothing when there is nothing usable", () => {
    expect(bufferMetrics(null, at)).toBeUndefined();
    expect(bufferMetrics([], at)).toBeUndefined();
    expect(bufferMetrics([{ type: "engagementRate", value: 4 }, { type: "reactions", value: NaN }], at)).toBeUndefined();
  });
});

class HandoffAdapter extends FakeAdapter {
  states = new Map<string, HandoffState>();
  asked: string[][] = [];
  batch?: Map<string, Metrics>;
  batchCalls = 0;
  reconcileError?: Error;
  constructor(channel: "linkedin") {
    super(channel);
    this.capabilities = { canIngest: true, canMeasure: true };
  }
  async reconcile(ids: string[]) {
    this.asked.push(ids);
    if (this.reconcileError) throw this.reconcileError;
    return new Map(ids.map((id) => [id, this.states.get(id) ?? ({ state: "pending" } as HandoffState)]));
  }
  fetchMetricsBatch = async (ids: string[]) => {
    this.batchCalls++;
    return new Map([...(this.batch ?? new Map())].filter(([id]) => ids.includes(id)));
  };
}

describe("engine: hand-offs and batch metrics", () => {
  const T0 = new Date("2026-11-12T10:00:00Z");
  function setup() {
    const store = new MemoryStore();
    const adapter = new HandoffAdapter("linkedin");
    const events: Array<{ kind: string; title: string; message: string }> = [];
    const engine = new ContentEngine({ store, adapters: { linkedin: adapter }, generator: new FakeGenerator(), now: () => T0, notifier: { notify: async (e) => void events.push(e) } });
    return { store, adapter, engine, events };
  }
  const handedOver = async (store: MemoryStore, over: Partial<PostVariant> = {}) => {
    const brief = { id: crypto.randomUUID(), idea: "x", sourcePostIds: [], assetIds: [], createdAt: T0.toISOString() };
    await store.putBrief(brief);
    const v: PostVariant = { id: crypto.randomUUID(), briefId: brief.id, channel: "linkedin", text: "Ett viktigt inlägg", assetIds: [], status: "published", attempts: 1, externalId: `bp-${Math.random()}`, publishedAt: T0.toISOString(), createdAt: T0.toISOString(), ...over };
    await store.putVariant(v);
    await store.upsertPost({ id: crypto.randomUUID(), channel: "linkedin", externalId: v.externalId!, text: v.text, mediaKinds: [], publishedAt: v.publishedAt!, variantId: v.id });
    return v;
  };

  it("fills in the link once Buffer has sent the post, on the variant and on the post record", async () => {
    const { store, adapter, engine } = setup();
    const v = await handedOver(store);
    adapter.states.set(v.externalId!, { state: "sent", url: "https://linkedin.com/feed/update/77" });
    expect((await engine.reconcileHandoffs()).sent).toEqual([v.id]);
    expect((await store.getVariant(v.id))!.url).toBe("https://linkedin.com/feed/update/77");
    expect((await store.listPosts({ channel: "linkedin" }))[0]!.url).toBe("https://linkedin.com/feed/update/77");
  });

  it("marks a post Buffer could not publish as failed, with Buffer's reason, and tells you", async () => {
    const { store, adapter, engine, events } = setup();
    const v = await handedOver(store);
    adapter.states.set(v.externalId!, { state: "error", error: "LinkedIn rejected the image" });
    const res = await engine.tick();
    expect(await store.getVariant(v.id)).toMatchObject({ status: "failed", lastError: "Buffer kunde inte publicera: LinkedIn rejected the image" });
    expect(res.failed).toContain(v.id);
    expect(events).toEqual([expect.objectContaining({ kind: "failed", title: "Misslyckades på LinkedIn" })]);
    expect(events[0]!.message).toContain("LinkedIn rejected the image");
  });

  it("asks about nothing when there is nothing recent to ask about, so a quiet account costs no requests", async () => {
    const { store, adapter, engine } = setup();
    await handedOver(store, { publishedAt: new Date(T0.getTime() - 7 * 3_600_000).toISOString() }); // too old
    await handedOver(store, { url: "https://already.there" }); // already resolved
    await engine.reconcileHandoffs();
    expect(adapter.asked).toEqual([]);
  });

  it("leaves a still-pending post for the next run, and survives Buffer being unreachable", async () => {
    const { store, adapter, engine } = setup();
    const v = await handedOver(store);
    expect(await engine.reconcileHandoffs()).toEqual({ sent: [], failed: [] });
    adapter.reconcileError = new Error("Buffer down");
    await expect(engine.reconcileHandoffs()).resolves.toEqual({ sent: [], failed: [] });
    expect((await store.getVariant(v.id))!.status).toBe("published");
  });

  it("adapters that publish directly are never asked", async () => {
    const store = new MemoryStore();
    const direct = new FakeAdapter("linkedin");
    const engine = new ContentEngine({ store, adapters: { linkedin: direct }, generator: new FakeGenerator(), now: () => T0 });
    await handedOver(store);
    await expect(engine.reconcileHandoffs()).resolves.toEqual({ sent: [], failed: [] });
  });

  it("refreshMetrics uses one batch request instead of one per post", async () => {
    const { store, adapter, engine } = setup();
    const [a, b] = [await handedOver(store), await handedOver(store)];
    adapter.batch = new Map([[a.externalId!, { likes: 5, collectedAt: T0.toISOString() }], [b.externalId!, { likes: 9, collectedAt: T0.toISOString() }]]);
    expect(await engine.refreshMetrics("linkedin")).toBe(2);
    expect(adapter.batchCalls).toBe(1);
    expect((await store.listPosts({ channel: "linkedin" })).map((p) => p.metrics?.likes).sort()).toEqual([5, 9]);
  });
});

describe("Buffer configuration", () => {
  it("parses channel=id pairs and the LinkedIn shorthand, and rejects mistakes", () => {
    expect(parseBufferChannels({ BUFFER_CHANNELS: "linkedin=abc, instagram = def" })).toEqual([["linkedin", "abc"], ["instagram", "def"]]);
    expect(parseBufferChannels({ BUFFER_LINKEDIN_CHANNEL_ID: " xyz " })).toEqual([["linkedin", "xyz"]]);
    expect(parseBufferChannels({ BUFFER_CHANNELS: "linkedin=a", BUFFER_LINKEDIN_CHANNEL_ID: "b" })).toEqual([["linkedin", "a"]]);
    expect(parseBufferChannels({})).toEqual([]);
    expect(() => parseBufferChannels({ BUFFER_CHANNELS: "linkedin" })).toThrow(/channel=id/);
    expect(() => parseBufferChannels({ BUFFER_CHANNELS: "linkedin=a=b" })).toThrow(/channel=id/);
    expect(() => parseBufferChannels({ BUFFER_CHANNELS: "myspace=a" })).toThrow(/unknown channel/);
  });

  it("Buffer takes over a channel it is configured for, even when direct credentials exist", () => {
    const env = { BUFFER_API_KEY: KEY, BUFFER_CHANNELS: "linkedin=ch1", LINKEDIN_AUTHOR_URN: "urn:li:person:me", LINKEDIN_ACCESS_TOKEN: "tok-123456", INSTAGRAM_USER_ID: "1", INSTAGRAM_ACCESS_TOKEN: "t" };
    const { configuredChannels, engine } = buildEngine(env, new MemoryStore());
    expect(configuredChannels.sort()).toEqual(["instagram", "linkedin"]);
    expect(engine["adapters"].linkedin).toBeInstanceOf(BufferAdapter);
    expect(engine["adapters"].instagram).not.toBeInstanceOf(BufferAdapter);
  });

  it("without BUFFER_CHANNELS the key alone changes nothing", () => {
    expect(buildEngine({ BUFFER_API_KEY: KEY }, new MemoryStore()).configuredChannels).toEqual([]);
  });
});

describe("buffer-channels and doctor", () => {
  const account = (channels: unknown[]) => [
    { match: has("account {"), reply: () => data({ account: { organizations: [{ id: "org1", name: "Min byrå" }] } }) },
    { match: has("channels(input"), reply: () => data({ channels }) },
  ];
  const chans = [
    { id: "li1", displayName: "David Axegren", service: "linkedin", isDisconnected: false, isLocked: false },
    { id: "tw1", displayName: "@david", service: "twitter", isDisconnected: false, isLocked: false },
    { id: "ig1", displayName: "david.ig", service: "instagram", isDisconnected: true, isLocked: false },
    { id: "bs1", displayName: "david.bsky", service: "bluesky", isDisconnected: false, isLocked: false },
  ];

  it("lists channels with their ids and suggests the BUFFER_CHANNELS line, skipping broken and unsupported ones", async () => {
    const text = await listBufferChannels({ apiKey: KEY, fetch: mockFetch(account(chans)).fn });
    expect(text).toContain("Min byrå (org1)");
    expect(text).toMatch(/linkedin\s+David Axegren\s+li1/);
    expect(text).toMatch(/ig1\s+DISCONNECTED/);
    expect(text).toMatch(/bs1\s+\(not supported by this engine\)/);
    expect(text).toContain("linkedin=li1,x=tw1"); // twitter is our x; the disconnected and unsupported are left out
  });

  it("the CLI command needs the key and says so", async () => {
    const { sql } = await freshDb();
    await expect(runCli(["buffer-channels"], { env: {}, sql })).rejects.toThrow(/BUFFER_API_KEY/);
    const out = await runCli(["buffer-channels"], { env: { BUFFER_API_KEY: KEY }, sql, fetch: mockFetch(account(chans)).fn });
    expect(out).toContain("linkedin=li1");
  });

  it("doctor checks every configured channel against the account", async () => {
    const { sql } = await freshDb();
    const run = (env: Record<string, string>) => runDoctor({ env: { BUFFER_API_KEY: KEY, ...env }, sql, fetch: mockFetch(account(chans)).fn }).then((cs) => cs.filter((c) => c.name.startsWith("buffer")));
    const good = await run({ BUFFER_CHANNELS: "linkedin=li1", LINKEDIN_AUTHOR_URN: "urn:li:person:me", LINKEDIN_ACCESS_TOKEN: "tok-123456" });
    expect(good.map((c) => c.status)).toEqual(["ok", "ok"]);
    expect(good[1]!.detail).toContain("replaces the direct credentials");

    const bad = await run({ BUFFER_CHANNELS: "linkedin=nope,instagram=ig1,facebook=li1" });
    expect(bad.slice(1).map((c) => c.status)).toEqual(["fail", "fail", "fail"]);
    expect(bad[1]!.detail).toContain("not in your Buffer account");
    expect(bad[2]!.detail).toContain("disconnected");
    expect(bad[3]!.detail).toContain("is a linkedin channel, not facebook");

    expect((await run({}))[1]).toMatchObject({ status: "warn", detail: expect.stringContaining("BUFFER_CHANNELS is not set") });
  });

  it("doctor reports a rejected key without echoing it", async () => {
    const { sql } = await freshDb();
    const checks = await runDoctor({ env: { BUFFER_API_KEY: KEY }, sql, fetch: mockFetch([{ match: () => true, reply: () => json({ data: null, errors: [{ message: `Not authorized ${KEY}`, extensions: { code: "UNAUTHORIZED" } }] }) }]).fn });
    const c = checks.find((x) => x.name === "buffer")!;
    expect(c.status).toBe("fail");
    expect(c.detail).not.toContain(KEY);
    expect(c.detail).toContain("UNAUTHORIZED");
  });
});
