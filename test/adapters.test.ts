import { describe, expect, it } from "vitest";
import { InstagramAdapter } from "../src/adapters/instagram.js";
import { LinkedInAdapter } from "../src/adapters/linkedin.js";
import { AdapterError } from "../src/adapters/types.js";
import type { Asset, PostVariant } from "../src/domain.js";
import { json, mockFetch } from "./helpers.js";

const variant = (channel: PostVariant["channel"], text = "caption"): PostVariant => ({
  id: "v1",
  briefId: "b1",
  channel,
  text,
  assetIds: [],
  status: "publishing",
  attempts: 1,
  createdAt: "2026-11-02T00:00:00Z",
});
const asset = (kind: Asset["kind"], uri: string): Asset => ({
  id: "a1",
  kind,
  origin: "captured",
  uri,
  createdAt: "2026-11-02T00:00:00Z",
});

describe("InstagramAdapter", () => {
  it("publishes an image: container, then media_publish, then reads permalink", async () => {
    const { fn, calls } = mockFetch([
      { match: (u) => u.includes("/123/media?") === false && u.endsWith("/123/media"), reply: () => json({ id: "c1" }) },
      { match: (u) => u.endsWith("/123/media_publish"), reply: () => json({ id: "m1" }) },
      { match: (u) => u.includes("/m1?"), reply: () => json({ permalink: "https://instagram.com/p/abc" }) },
    ]);
    const ig = new InstagramAdapter({ igUserId: "123", accessToken: "tok", fetch: fn });

    const res = await ig.publish(variant("instagram", "hej"), [asset("image", "https://cdn.test/a.jpg")]);

    expect(res).toEqual({ externalId: "m1", url: "https://instagram.com/p/abc" });
    const create = new URLSearchParams(String(calls[0]!.init!.body));
    expect(create.get("image_url")).toBe("https://cdn.test/a.jpg");
    expect(create.get("caption")).toBe("hej");
    expect(new URLSearchParams(String(calls[1]!.init!.body)).get("creation_id")).toBe("c1");
  });

  it("publishes video as a reel and waits for processing to finish", async () => {
    let polls = 0;
    const { fn, calls } = mockFetch([
      { match: (u) => u.endsWith("/123/media"), reply: () => json({ id: "c2" }) },
      {
        match: (u) => u.includes("/c2?"),
        reply: () => json({ status_code: ++polls < 3 ? "IN_PROGRESS" : "FINISHED" }),
      },
      { match: (u) => u.endsWith("/123/media_publish"), reply: () => json({ id: "m2" }) },
      { match: (u) => u.includes("/m2?"), reply: () => json({}) },
    ]);
    const ig = new InstagramAdapter({ igUserId: "123", accessToken: "tok", fetch: fn, sleep: async () => {} });

    const res = await ig.publish(variant("instagram"), [asset("video", "https://cdn.test/a.mp4")]);

    expect(res.externalId).toBe("m2");
    expect(polls).toBe(3);
    expect(new URLSearchParams(String(calls[0]!.init!.body)).get("media_type")).toBe("REELS");
  });

  it("does not fail a live post when only the permalink lookup fails", async () => {
    const { fn } = mockFetch([
      { match: (u) => u.endsWith("/123/media"), reply: () => json({ id: "c" }) },
      { match: (u) => u.endsWith("/123/media_publish"), reply: () => json({ id: "m" }) },
      { match: (u) => u.includes("/m?"), reply: () => new Response("err", { status: 500 }) },
    ]);
    const ig = new InstagramAdapter({ igUserId: "123", accessToken: "tok", fetch: fn });
    const res = await ig.publish(variant("instagram"), [asset("image", "https://cdn.test/a.jpg")]);
    expect(res).toEqual({ externalId: "m", url: undefined });
  });

  it("classifies 5xx/429 as retryable and 4xx as permanent", async () => {
    const attempt = async (status: number) => {
      const { fn } = mockFetch([{ match: () => true, reply: () => new Response("x", { status }) }]);
      const ig = new InstagramAdapter({ igUserId: "123", accessToken: "tok", fetch: fn });
      return ig.publish(variant("instagram"), [asset("image", "https://cdn.test/a.jpg")]).catch((e: AdapterError) => e);
    };
    expect(await attempt(503)).toMatchObject({ permanent: false, status: 503 });
    expect(await attempt(429)).toMatchObject({ permanent: false });
    expect(await attempt(400)).toMatchObject({ permanent: true });
  });

  it("ingests media with metrics, honouring `since`", async () => {
    const { fn } = mockFetch([
      {
        match: (u) => u.includes("/123/media?"),
        reply: () =>
          json({
            data: [
              { id: "1", caption: "new", media_type: "VIDEO", timestamp: "2026-10-20T10:00:00Z", like_count: 5, comments_count: 1 },
              { id: "2", caption: "old", media_type: "IMAGE", timestamp: "2026-01-01T10:00:00Z", like_count: 9 },
            ],
          }),
      },
    ]);
    const ig = new InstagramAdapter({ igUserId: "123", accessToken: "tok", fetch: fn });
    const posts = await ig.fetchPublished(new Date("2026-10-01T00:00:00Z"));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ externalId: "1", mediaKinds: ["video"], metrics: { likes: 5, comments: 1 } });
  });
});

describe("LinkedInAdapter", () => {
  it("publishes a text post and reads the id from x-restli-id", async () => {
    const { fn, calls } = mockFetch([
      {
        match: (u) => u.endsWith("/rest/posts"),
        reply: () => new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:99" } }),
      },
    ]);
    const li = new LinkedInAdapter({ authorUrn: "urn:li:person:me", accessToken: "tok", fetch: fn });

    const res = await li.publish(variant("linkedin", "hello"), []);

    expect(res.externalId).toBe("urn:li:share:99");
    const sent = JSON.parse(String(calls[0]!.init!.body));
    expect(sent).toMatchObject({ author: "urn:li:person:me", commentary: "hello", lifecycleState: "PUBLISHED" });
    expect((calls[0]!.init!.headers as Record<string, string>)["Linkedin-Version"]).toMatch(/^\d{6}$/);
  });

  it("sends a current API version by default (old ones are sunset), and lets you override it", async () => {
    const send = async (apiVersion?: string) => {
      const { fn, calls } = mockFetch([{ match: () => true, reply: () => new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:1" } }) }]);
      await new LinkedInAdapter({ authorUrn: "urn:li:person:me", accessToken: "tok", fetch: fn, apiVersion }).publish(variant("linkedin"), []);
      return (calls[0]!.init!.headers as Record<string, string>)["Linkedin-Version"];
    };
    expect(await send()).toBe("202610");
    expect(await send("202701")).toBe("202701");
  });

  it("uploads an image before posting and references it", async () => {
    const { fn, calls } = mockFetch([
      {
        match: (u) => u.includes("/rest/images?action=initializeUpload"),
        reply: () => json({ value: { uploadUrl: "https://upload.linkedin.test/u1", image: "urn:li:image:7" } }),
      },
      { match: (u) => u === "https://cdn.test/a.jpg", reply: () => new Response(new Uint8Array([1, 2, 3])) },
      { match: (u) => u === "https://upload.linkedin.test/u1", reply: () => new Response(null, { status: 201 }) },
      {
        match: (u) => u.endsWith("/rest/posts"),
        reply: () => new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:5" } }),
      },
    ]);
    const li = new LinkedInAdapter({ authorUrn: "urn:li:person:me", accessToken: "tok", fetch: fn });

    await li.publish(variant("linkedin"), [asset("image", "https://cdn.test/a.jpg")]);

    const post = calls.find((c) => c.url.endsWith("/rest/posts"))!;
    expect(JSON.parse(String(post.init!.body)).content).toEqual({ media: { id: "urn:li:image:7" } });
  });

  it("ingestion is declared unsupported", async () => {
    const li = new LinkedInAdapter({ authorUrn: "x", accessToken: "t", fetch: mockFetch([]).fn });
    expect(li.capabilities.canIngest).toBe(false);
    await expect(li.fetchPublished()).rejects.toMatchObject({ permanent: true });
  });
});

describe("InstagramAdapter: carousels", () => {
  const form = (init?: RequestInit) => new URLSearchParams(String(init!.body));

  it("builds one container per item, then a parent that carries the caption, then publishes the parent", async () => {
    let n = 0;
    const { fn, calls } = mockFetch([
      { match: (u) => u.endsWith("/123/media"), reply: () => json({ id: `c${++n}` }) },
      { match: (u) => /\/c\d\?/.test(u), reply: () => json({ status_code: "FINISHED" }) },
      { match: (u) => u.endsWith("/123/media_publish"), reply: () => json({ id: "m9" }) },
      { match: (u) => u.includes("/m9?"), reply: () => json({ permalink: "https://instagram.com/p/car" }) },
    ]);
    const ig = new InstagramAdapter({ igUserId: "123", accessToken: "tok", fetch: fn, sleep: async () => {} });
    const items: Asset[] = [asset("image", "https://cdn.test/1.jpg"), asset("video", "https://cdn.test/2.mp4"), asset("image", "https://cdn.test/3.jpg")];

    const res = await ig.publish(variant("instagram", "Svep →"), items);

    expect(res).toEqual({ externalId: "m9", url: "https://instagram.com/p/car" });
    const creates = calls.filter((c) => c.url.endsWith("/123/media"));
    expect(creates).toHaveLength(4); // 3 items + the parent
    expect(Object.fromEntries(form(creates[0]!.init))).toMatchObject({ is_carousel_item: "true", image_url: "https://cdn.test/1.jpg" });
    expect(Object.fromEntries(form(creates[0]!.init))).not.toHaveProperty("caption"); // caption belongs to the parent only
    expect(Object.fromEntries(form(creates[1]!.init))).toMatchObject({ is_carousel_item: "true", media_type: "VIDEO", video_url: "https://cdn.test/2.mp4" });
    expect(Object.fromEntries(form(creates[3]!.init))).toMatchObject({ media_type: "CAROUSEL", children: "c1,c2,c3", caption: "Svep →" });
    expect(form(calls.find((c) => c.url.endsWith("/media_publish"))!.init).get("creation_id")).toBe("c4");
    // the video child and the parent are polled until FINISHED; image children are not
    const polled = calls.filter((c) => /\/c\d\?/.test(c.url)).map((c) => c.url.match(/\/(c\d)\?/)![1]);
    expect(polled).toEqual(["c2", "c4"]);
  });

  it("stops before publishing when a video child fails to process", async () => {
    const { fn, calls } = mockFetch([
      { match: (u) => u.endsWith("/123/media"), reply: () => json({ id: "c1" }) },
      { match: (u) => u.includes("/c1?"), reply: () => json({ status_code: "ERROR" }) },
    ]);
    const ig = new InstagramAdapter({ igUserId: "123", accessToken: "tok", fetch: fn, sleep: async () => {} });
    await expect(ig.publish(variant("instagram"), [asset("video", "https://cdn.test/a.mp4"), asset("image", "https://cdn.test/b.jpg")])).rejects.toMatchObject({ permanent: true });
    expect(calls.some((c) => c.url.endsWith("/media_publish"))).toBe(false);
  });

  it("accepts up to ten items, and refuses none or eleven without calling Instagram", async () => {
    const { fn, calls } = mockFetch([]);
    const ig = new InstagramAdapter({ igUserId: "123", accessToken: "tok", fetch: fn });
    const many = Array.from({ length: 11 }, (_, i) => asset("image", `https://cdn.test/${i}.jpg`));
    await expect(ig.publish(variant("instagram"), many)).rejects.toThrow(/at most 10/);
    await expect(ig.publish(variant("instagram"), [])).rejects.toThrow(/at least one/);
    expect(calls).toHaveLength(0);
  });
});
