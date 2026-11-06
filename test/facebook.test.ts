import { describe, expect, it } from "vitest";
import { FacebookAdapter } from "../src/adapters/facebook.js";
import type { Asset, PostVariant } from "../src/domain.js";
import { buildEngine } from "../src/worker/env.js";
import { runDoctor } from "../src/worker/doctor.js";
import { MemoryStore } from "../src/store.js";
import { json, mockFetch } from "./helpers.js";
import { freshDb } from "./pg.js";

const variant = (text = "Hej från sidan"): PostVariant => ({ id: "v", briefId: "b", channel: "facebook", text, assetIds: [], status: "publishing", attempts: 1, createdAt: "2026-11-04T00:00:00Z" });
const asset = (kind: Asset["kind"], uri: string): Asset => ({ id: uri, kind, origin: "captured", uri, createdAt: "2026-11-04T00:00:00Z" });
const form = (init?: RequestInit) => Object.fromEntries(new URLSearchParams(String(init!.body)));
const adapter = (routes: Parameters<typeof mockFetch>[0]) => {
  const m = mockFetch(routes);
  return { fb: new FacebookAdapter({ pageId: "777", accessToken: "page-token-123", fetch: m.fn }), calls: m.calls };
};
const permalink = { match: (u: string) => /\/\w+_\w+\?|\/\d+\?/.test(u) && u.includes("permalink_url"), reply: () => json({ permalink_url: "https://facebook.com/777/posts/1" }) };

describe("FacebookAdapter.publish", () => {
  it("text only: a feed post with the message", async () => {
    const { fb, calls } = adapter([{ match: (u) => u.endsWith("/777/feed"), reply: () => json({ id: "777_1" }) }, permalink]);
    expect(await fb.publish(variant(), [])).toEqual({ externalId: "777_1", url: "https://facebook.com/777/posts/1" });
    expect(form(calls[0]!.init)).toMatchObject({ message: "Hej från sidan", access_token: "page-token-123" });
  });

  it("one photo: published directly with the text as caption, using the post id", async () => {
    const { fb, calls } = adapter([{ match: (u) => u.endsWith("/777/photos"), reply: () => json({ id: "photo1", post_id: "777_2" }) }, permalink]);
    const res = await fb.publish(variant("Bildtext"), [asset("image", "https://cdn.test/a.jpg")]);
    expect(res.externalId).toBe("777_2");
    expect(form(calls[0]!.init)).toMatchObject({ url: "https://cdn.test/a.jpg", caption: "Bildtext", published: "true" });
  });

  it("several photos: each uploaded unpublished, then attached to one feed post", async () => {
    let n = 0;
    const { fb, calls } = adapter([
      { match: (u) => u.endsWith("/777/photos"), reply: () => json({ id: `p${++n}` }) },
      { match: (u) => u.endsWith("/777/feed"), reply: () => json({ id: "777_3" }) },
      permalink,
    ]);
    const res = await fb.publish(variant("Album"), [asset("image", "https://cdn.test/1.jpg"), asset("image", "https://cdn.test/2.jpg")]);
    expect(res.externalId).toBe("777_3");
    expect(form(calls[0]!.init)).toMatchObject({ url: "https://cdn.test/1.jpg", published: "false" });
    const feed = form(calls.find((c) => c.url.endsWith("/777/feed"))!.init);
    expect(feed).toMatchObject({ message: "Album", "attached_media[0]": '{"media_fbid":"p1"}', "attached_media[1]": '{"media_fbid":"p2"}' });
  });

  it("one video: posted from its URL with the text as description", async () => {
    const { fb, calls } = adapter([{ match: (u) => u.endsWith("/777/videos"), reply: () => json({ id: "vid1" }) }, permalink]);
    expect((await fb.publish(variant("Klipp"), [asset("video", "https://cdn.test/a.mp4")])).externalId).toBe("vid1");
    expect(form(calls[0]!.init)).toMatchObject({ file_url: "https://cdn.test/a.mp4", description: "Klipp" });
  });

  it("refuses mixed media and several videos before calling Facebook", async () => {
    const { fb, calls } = adapter([]);
    await expect(fb.publish(variant(), [asset("image", "https://x/1.jpg"), asset("video", "https://x/2.mp4")])).rejects.toMatchObject({ permanent: true, message: expect.stringContaining("mix") });
    await expect(fb.publish(variant(), [asset("video", "https://x/1.mp4"), asset("video", "https://x/2.mp4")])).rejects.toMatchObject({ permanent: true });
    expect(calls).toHaveLength(0);
  });

  it("a missing permalink does not turn a live post into a failure", async () => {
    const { fb } = adapter([{ match: (u) => u.endsWith("/777/feed"), reply: () => json({ id: "777_9" }) }, { match: () => true, reply: () => new Response("err", { status: 500 }) }]);
    expect(await fb.publish(variant(), [])).toEqual({ externalId: "777_9", url: undefined });
  });

  it("classifies errors: 5xx/429 retry, other 4xx are permanent", async () => {
    const run = (status: number) => adapter([{ match: () => true, reply: () => new Response("x", { status }) }]).fb.publish(variant(), []).catch((e) => e);
    expect(await run(503)).toMatchObject({ permanent: false });
    expect(await run(429)).toMatchObject({ permanent: false });
    expect(await run(400)).toMatchObject({ permanent: true });
  });
});

describe("FacebookAdapter: learning from the page", () => {
  it("ingests posts with media kinds and metrics, honouring `since`", async () => {
    const { fb } = adapter([{
      match: (u) => u.includes("/777/posts?"),
      reply: () => json({ data: [
        { id: "777_1", message: "Nytt", created_time: "2026-10-20T10:00:00+0000", permalink_url: "https://fb/1", attachments: { data: [{ media_type: "album", subattachments: { data: [{ media_type: "photo" }] } }] }, reactions: { summary: { total_count: 12 } }, comments: { summary: { total_count: 3 } }, shares: { count: 2 } },
        { id: "777_2", message: "Gammalt", created_time: "2026-01-01T10:00:00+0000" },
        { id: "777_3", message: "Film", created_time: "2026-10-21T10:00:00+0000", attachments: { data: [{ media_type: "video" }] } },
      ] }),
    }]);
    const posts = await fb.fetchPublished(new Date("2026-10-01T00:00:00Z"));
    expect(posts.map((p) => p.externalId)).toEqual(["777_1", "777_3"]);
    expect(posts[0]).toMatchObject({ channel: "facebook", text: "Nytt", mediaKinds: ["image"], publishedAt: "2026-10-20T10:00:00.000Z", url: "https://fb/1", metrics: { likes: 12, comments: 3, shares: 2 } });
    expect(posts[1]!.mediaKinds).toEqual(["video"]);
  });

  it("reads metrics for one post", async () => {
    const { fb } = adapter([{ match: (u) => u.includes("/777_1?"), reply: () => json({ reactions: { summary: { total_count: 5 } }, comments: { summary: { total_count: 1 } } }) }]);
    expect(await fb.fetchMetrics("777_1")).toMatchObject({ likes: 5, comments: 1, shares: undefined });
  });
});

describe("Facebook wiring", () => {
  it("is enabled when both the page id and the page token are set", () => {
    expect(buildEngine({ FACEBOOK_PAGE_ID: "1" }, new MemoryStore()).configuredChannels).toEqual([]);
    expect(buildEngine({ FACEBOOK_PAGE_ID: "1", FACEBOOK_PAGE_ACCESS_TOKEN: "t" }, new MemoryStore()).configuredChannels).toEqual(["facebook"]);
  });

  it("doctor checks the page and never echoes the token", async () => {
    const { sql } = await freshDb();
    const env = { FACEBOOK_PAGE_ID: "777", FACEBOOK_PAGE_ACCESS_TOKEN: "EAAB-page-token-123" };
    const ok = await runDoctor({ env, sql, fetch: mockFetch([{ match: (u) => u.includes("/777?"), reply: () => json({ id: "777", name: "Min sida" }) }]).fn });
    expect(ok.find((c) => c.name === "facebook")).toMatchObject({ status: "ok", detail: expect.stringContaining("Min sida") });
    const bad = await runDoctor({ env, sql, fetch: mockFetch([{ match: () => true, reply: () => json({ error: { message: "Invalid token EAAB-page-token-123" } }, { status: 400 }) }]).fn });
    const c = bad.find((x) => x.name === "facebook")!;
    expect(c.status).toBe("fail");
    expect(c.detail).not.toContain("EAAB-page-token-123");
  });
});
