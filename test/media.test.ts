import { describe, expect, it } from "vitest";
import { HiggsfieldVideoGenerator, buildHiggsfieldBody } from "../src/adapters/higgsfield.js";
import { SupabaseStorage } from "../src/adapters/supabase-storage.js";
import { ContentEngine } from "../src/engine.js";
import { MediaCapReachedError, checkMonthlyCap, monthStartIso } from "../src/media.js";
import { MemoryStore } from "../src/store.js";
import { FakeGenerator, FakeVideoGenerator, MemoryStorage, json, mockFetch } from "./helpers.js";

const T0 = new Date("2026-11-02T08:00:00Z");
const SRC = "https://cdn.test/product.jpg";

function setup(over: { cap?: number; video?: FakeVideoGenerator; fetch?: typeof fetch } = {}) {
  const store = new MemoryStore();
  const video = over.video ?? new FakeVideoGenerator();
  const storage = new MemoryStorage();
  let now = T0;
  const fetchFn =
    over.fetch ?? mockFetch([{ match: (u) => u === "https://provider.test/v.mp4", reply: () => new Response(new Uint8Array([1, 2, 3])) }]).fn;
  const engine = new ContentEngine({
    store,
    adapters: {},
    generator: new FakeGenerator(),
    videoGenerator: video,
    mediaStorage: storage,
    mediaMonthlyCapUsd: over.cap,
    fetch: fetchFn,
    now: () => now,
  });
  return { store, video, storage, engine, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe("engine: video generation", () => {
  it("submits, then stores the file durably and registers a generated asset", async () => {
    const { engine, store, storage } = setup();
    const job = await engine.startVideo({ prompt: "slow pan over the product", sourceImageUri: SRC });
    expect(job).toMatchObject({ status: "in_progress", providerJobId: expect.any(String) });

    const done = await engine.advanceJob(job.id);
    expect(done).toMatchObject({ status: "completed", assetId: job.id });
    expect(storage.files.get(`generated/${job.id}.mp4`)).toMatchObject({ mimeType: "video/mp4" });

    const [asset] = await store.getAssets([job.id]);
    expect(asset).toMatchObject({ kind: "video", origin: "generated", uri: `https://storage.test/public/generated/${job.id}.mp4` });
    expect(asset!.meta).toMatchObject({ jobId: job.id, provider: "fake" });
  });

  it("adds the safety suffix to the prompt and defaults to the cheapest image-to-video model", async () => {
    const { engine, video } = setup();
    await engine.startVideo({ prompt: "a lighthouse", sourceImageUri: SRC });
    expect(video.submitted[0]!.prompt).toMatch(/a lighthouse.*no text overlays, no logos/);
    expect(video.submitted[0]!.model).toBe("kling-video/v2.5-turbo/standard/image-to-video");
  });

  it("validates input before spending anything", async () => {
    const { engine, video } = setup();
    await expect(engine.startVideo({ prompt: "x" })).rejects.toThrow(/source image/);
    await expect(engine.startVideo({ prompt: "x", sourceImageUri: "http://insecure.test/a.jpg" })).rejects.toThrow(/https/);
    await expect(engine.startVideo({ prompt: "x", sourceImageUri: SRC, model: "nope/v1" })).rejects.toThrow(/unknown video model/);
    expect(video.submitted).toHaveLength(0);
  });

  it("text-to-video models need no source image", async () => {
    const { engine } = setup();
    const job = await engine.startVideo({ prompt: "x", model: "bytedance/seedance-2.0/text-to-video" });
    expect(job.status).toBe("in_progress");
  });

  it("refuses to start when the monthly cap would be exceeded, without calling the provider", async () => {
    const { engine, video, store } = setup({ cap: 0.15 });
    await engine.startVideo({ prompt: "one", sourceImageUri: SRC }); // 0.10 committed
    await expect(engine.startVideo({ prompt: "two", sourceImageUri: SRC })).rejects.toBeInstanceOf(MediaCapReachedError);
    expect(video.submitted).toHaveLength(1);
    expect(await store.listMediaJobs()).toHaveLength(1);
  });

  it("cap counts in-flight jobs, uses actual cost once known, and resets each month", async () => {
    const { engine, store, video, advance } = setup({ cap: 0.15 });
    video.states = [{ status: "completed", videoUrl: "https://provider.test/v.mp4", actualCostUsd: 0.02 }];
    const job = await engine.startVideo({ prompt: "one", sourceImageUri: SRC });
    expect(await store.mediaSpendUsd(monthStartIso(T0))).toBeCloseTo(0.1);
    await engine.advanceJob(job.id);
    expect(await store.mediaSpendUsd(monthStartIso(T0))).toBeCloseTo(0.02); // actual replaces the estimate

    advance(40 * 86_400_000); // next month: nothing spent yet
    await expect(engine.startVideo({ prompt: "two", sourceImageUri: SRC })).resolves.toBeDefined();
  });

  it("a failed submit is recorded as free and rethrown", async () => {
    const video = new FakeVideoGenerator();
    video.submitError = new Error("provider down");
    const { engine, store } = setup({ video });
    await expect(engine.startVideo({ prompt: "x", sourceImageUri: SRC })).rejects.toThrow("provider down");
    const [job] = await store.listMediaJobs();
    expect(job).toMatchObject({ status: "failed", actualCostUsd: 0, error: "provider down" });
    expect(await store.mediaSpendUsd(monthStartIso(T0))).toBe(0);
  });

  it("a provider-side failure (e.g. content filter) frees the budget and creates no asset", async () => {
    const video = new FakeVideoGenerator();
    video.states = [{ status: "failed", error: "Stopped by the content filter (not charged)." }];
    const { engine, store } = setup({ video });
    const job = await engine.startVideo({ prompt: "x", sourceImageUri: SRC });
    expect(await engine.advanceJob(job.id)).toMatchObject({ status: "failed", actualCostUsd: 0 });
    expect(await store.getAssets([job.id])).toEqual([]);
  });

  it("keeps polling while the provider is working, and gives up after an hour keeping the estimate", async () => {
    const video = new FakeVideoGenerator();
    video.states = [{ status: "in_progress" }];
    const { engine, store, advance } = setup({ video });
    const job = await engine.startVideo({ prompt: "x", sourceImageUri: SRC });

    expect((await engine.advanceJob(job.id)).status).toBe("in_progress");
    advance(61 * 60_000);
    const timedOut = await engine.advanceJob(job.id);
    expect(timedOut).toMatchObject({ status: "failed", error: /timed out/ });
    expect(await store.mediaSpendUsd(monthStartIso(T0))).toBeCloseTo(0.1);
  });

  it("finishing the same job twice (after a crash) does not duplicate the asset", async () => {
    const { engine, store } = setup();
    const job = await engine.startVideo({ prompt: "x", sourceImageUri: SRC });
    await engine.advanceJob(job.id);
    // simulate "asset saved, job update lost": put the job back to in_progress
    await store.putMediaJob({ ...(await store.getMediaJob(job.id))!, status: "in_progress", assetId: undefined, finishedAt: undefined });
    await engine.advanceJob(job.id);
    expect((await store.getAssets([job.id])).length).toBe(1);
  });

  it("a failed download is retried on the next poll instead of losing the paid result", async () => {
    let calls = 0;
    const { fn } = mockFetch([
      { match: () => true, reply: () => (++calls === 1 ? new Response("busy", { status: 503 }) : new Response(new Uint8Array([9]))) },
    ]);
    const { engine } = setup({ fetch: fn });
    const job = await engine.startVideo({ prompt: "x", sourceImageUri: SRC });
    await expect(engine.advanceJob(job.id)).rejects.toThrow(/will retry/);
    expect((await engine.advanceJob(job.id)).status).toBe("completed");
  });

  it("advanceMedia isolates failures, and tick collects finished jobs alongside publishing", async () => {
    const { engine, video } = setup();
    const a = await engine.startVideo({ prompt: "a", sourceImageUri: SRC });
    video.statusError = new Error("network blip");
    const res = await engine.advanceMedia();
    expect(res).toMatchObject({ completed: [], pending: 1 });
    expect(res.errors[0]).toMatch(/network blip/);

    video.statusError = undefined;
    const tick = await engine.tick();
    expect(tick.media!.completed).toEqual([a.id]);
  });

  it("waitForJob returns while the job is still running once the timeout passes", async () => {
    const video = new FakeVideoGenerator();
    video.states = [{ status: "in_progress" }];
    const { engine } = setup({ video });
    const job = await engine.startVideo({ prompt: "x", sourceImageUri: SRC });
    const out = await engine.waitForJob(job.id, { timeoutMs: 0, sleep: async () => {} });
    expect(out.status).toBe("in_progress");
  });

  it("without a generator or storage configured, it says what to set", async () => {
    const engine = new ContentEngine({ store: new MemoryStore(), adapters: {}, generator: new FakeGenerator() });
    await expect(engine.startVideo({ prompt: "x", sourceImageUri: SRC })).rejects.toThrow(/HIGGSFIELD_API_KEY/);
    const half = new ContentEngine({ store: new MemoryStore(), adapters: {}, generator: new FakeGenerator(), videoGenerator: new FakeVideoGenerator() });
    await expect(half.startVideo({ prompt: "x", sourceImageUri: SRC })).rejects.toThrow(/SUPABASE_URL/);
  });
});

describe("checkMonthlyCap", () => {
  it("allows exactly up to the cap", () => {
    expect(checkMonthlyCap({ spentUsd: 49.9, capUsd: 50, estimateUsd: 0.1 }).allowed).toBe(true);
    expect(checkMonthlyCap({ spentUsd: 49.95, capUsd: 50, estimateUsd: 0.1 }).allowed).toBe(false);
  });
});

describe("HiggsfieldVideoGenerator", () => {
  const KEY = "keyid1234:secretsecret99";
  const model = "kling-video/v2.5-turbo/standard/image-to-video";

  it("sends the credential, and per-model bodies only contain documented fields", async () => {
    const { fn, calls } = mockFetch([{ match: (u) => u.endsWith(`/${model}`), reply: () => json({ request_id: "req-12345678" }) }]);
    const g = new HiggsfieldVideoGenerator({ apiKey: KEY, fetch: fn });
    expect(await g.submit({ model, prompt: "p", sourceImageUri: SRC })).toEqual({ providerJobId: "req-12345678" });
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe(`Key ${KEY}`);
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ prompt: "p", image_url: SRC, duration: 5 });

    expect(buildHiggsfieldBody("minimax/hailuo-2.3/standard/image-to-video", "p", SRC)).toMatchObject({ duration: 6 });
    expect(buildHiggsfieldBody("kling-video/v3.0-turbo/image-to-video", "p", SRC)).toMatchObject({ resolution: "720p" });
    expect(buildHiggsfieldBody("bytedance/seedance-2.0/text-to-video", "p", undefined)).toMatchObject({ aspect_ratio: "9:16", generate_audio: false });
    expect(() => buildHiggsfieldBody(model, "p", undefined)).toThrow(/source image/);
  });

  it("prefers the discounted quote when estimating, and falls back to the price formula", async () => {
    const quoted = mockFetch([{ match: () => true, reply: () => json({ type: "estimate", usd: "0.12", discount: { usd: "0.10" } }) }]);
    expect(await new HiggsfieldVideoGenerator({ apiKey: KEY, fetch: quoted.fn }).estimate({ model, prompt: "p", sourceImageUri: SRC })).toMatchObject({ usd: 0.1, isEstimate: true });

    const described = mockFetch([{ match: () => true, reply: () => json({ type: "description" }) }]);
    const est = await new HiggsfieldVideoGenerator({ apiKey: KEY, fetch: described.fn }).estimate({ model: "bytedance/seedance-2.0/text-to-video", prompt: "p" });
    expect(est.usd).toBeGreaterThan(0);
  });

  it("maps provider statuses", async () => {
    const status = async (body: unknown) =>
      new HiggsfieldVideoGenerator({ apiKey: KEY, fetch: mockFetch([{ match: () => true, reply: () => json(body) }]).fn }).status("req-12345678");
    expect(await status({ status: "completed", video: { url: "https://v/x.mp4" }, cost: { usd: "0.09" } })).toEqual({ status: "completed", videoUrl: "https://v/x.mp4", actualCostUsd: 0.09 });
    expect(await status({ status: "nsfw" })).toMatchObject({ status: "failed", error: expect.stringMatching(/content filter/) });
    expect(await status({ status: "canceled" })).toMatchObject({ status: "failed" });
    expect(await status({ status: "in_progress" })).toEqual({ status: "in_progress" });
    expect(await status({ status: "waiting" })).toEqual({ status: "queued" });
  });

  it("never lets the credential into an error message, and classifies errors", async () => {
    const failing = (status: number, text: string) =>
      new HiggsfieldVideoGenerator({ apiKey: KEY, fetch: mockFetch([{ match: () => true, reply: () => new Response(text, { status }) }]).fn }).submit({ model, prompt: "p", sourceImageUri: SRC });
    const leaked = await failing(401, `bad key ${KEY} / ${KEY.split(":")[1]}`).catch((e) => e);
    expect(leaked.message).not.toContain("secretsecret99");
    expect(leaked.message).not.toContain("keyid1234");
    expect(leaked).toMatchObject({ permanent: true, status: 401 });
    expect(await failing(503, "x").catch((e) => e)).toMatchObject({ permanent: false });
  });

  it("rejects job ids that could alter the request path, and unknown models", async () => {
    const g = new HiggsfieldVideoGenerator({ apiKey: KEY, fetch: mockFetch([]).fn });
    await expect(g.status("../../admin")).rejects.toThrow(/invalid job id/);
    await expect(g.submit({ model: "evil/model", prompt: "p" })).rejects.toThrow(/unknown video model/);
  });
});

describe("SupabaseStorage", () => {
  it("uploads with the service key and returns the public URL", async () => {
    const { fn, calls } = mockFetch([{ match: (u) => u.includes("/storage/v1/object/social-media/"), reply: () => json({ Key: "ok" }) }]);
    const storage = new SupabaseStorage({ url: "https://abc.supabase.co/", serviceRoleKey: "srv", fetch: fn });
    const url = await storage.put("generated/a b.mp4", new Uint8Array([1]), "video/mp4");
    expect(url).toBe("https://abc.supabase.co/storage/v1/object/public/social-media/generated/a%20b.mp4");
    expect(calls[0]!.url).toBe("https://abc.supabase.co/storage/v1/object/social-media/generated/a%20b.mp4");
    expect(calls[0]!.init!.headers).toMatchObject({ Authorization: "Bearer srv", "Content-Type": "video/mp4", "x-upsert": "true" });
  });

  it("surfaces upload failures", async () => {
    const { fn } = mockFetch([{ match: () => true, reply: () => new Response("no bucket", { status: 404 }) }]);
    await expect(new SupabaseStorage({ url: "https://abc.supabase.co", serviceRoleKey: "srv", fetch: fn }).put("x", new Uint8Array(), "video/mp4")).rejects.toThrow(/404/);
  });
});

import { GeminiImageGenerator } from "../src/adapters/gemini-image.js";
import { FakeImageGenerator } from "./helpers.js";

describe("engine: image generation", () => {
  function imageSetup(over: { cap?: number; image?: FakeImageGenerator; fetch?: typeof fetch } = {}) {
    const store = new MemoryStore();
    const image = over.image ?? new FakeImageGenerator();
    const storage = new MemoryStorage();
    const engine = new ContentEngine({
      store, adapters: {}, generator: new FakeGenerator(), imageGenerator: image, mediaStorage: storage,
      mediaMonthlyCapUsd: over.cap, fetch: over.fetch, now: () => T0,
    });
    return { store, image, storage, engine };
  }

  it("generates, stores durably and registers a generated image asset, counted in spend", async () => {
    const { engine, store, storage, image } = imageSetup();
    const asset = await engine.generateImage({ prompt: "a lighthouse at dawn", aspect: "9:16" });
    expect(asset).toMatchObject({ kind: "image", origin: "generated", uri: `https://storage.test/public/generated/${asset.id}.png` });
    expect(storage.files.get(`generated/${asset.id}.png`)).toMatchObject({ mimeType: "image/png" });
    expect(image.requests[0]).toMatchObject({ aspect: "9:16" });
    expect(image.requests[0]!.prompt).toMatch(/lighthouse.*No text, no logos/);
    expect(await store.getMediaJob(asset.id)).toMatchObject({ kind: "image", status: "completed", assetId: asset.id });
    expect(await store.mediaSpendUsd(monthStartIso(T0))).toBeCloseTo(0.04);
  });

  it("downloads a reference image and passes its bytes and type to the generator", async () => {
    const { fn } = mockFetch([{ match: (u) => u === "https://cdn.test/product.jpg", reply: () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/jpeg" } }) }]);
    const { engine, image } = imageSetup({ fetch: fn });
    await engine.generateImage({ prompt: "on a wooden table", referenceImageUri: "https://cdn.test/product.jpg" });
    expect(image.requests[0]!.reference).toEqual({ bytes: new Uint8Array([1, 2]), mimeType: "image/jpeg" });
    expect(image.requests[0]!.prompt).toMatch(/reference image/);
  });

  it("shares the monthly cap with video, and refuses before calling the provider", async () => {
    const { engine, image } = imageSetup({ cap: 0.05 });
    await engine.generateImage({ prompt: "one" });
    await expect(engine.generateImage({ prompt: "two" })).rejects.toBeInstanceOf(MediaCapReachedError);
    expect(image.requests).toHaveLength(1);
  });

  it("records a provider failure as free and rethrows", async () => {
    const image = new FakeImageGenerator();
    image.error = new Error("blocked");
    const { engine, store } = imageSetup({ image });
    await expect(engine.generateImage({ prompt: "x" })).rejects.toThrow("blocked");
    const [job] = await store.listMediaJobs();
    expect(job).toMatchObject({ kind: "image", status: "failed", actualCostUsd: 0 });
    expect(await store.mediaSpendUsd(monthStartIso(T0))).toBe(0);
  });

  it("tick closes an image job whose process died, without needing a video generator", async () => {
    const { engine, store } = imageSetup();
    await store.putMediaJob({
      id: crypto.randomUUID(), kind: "image", provider: "p", model: "m", prompt: "x", status: "in_progress",
      estimatedCostUsd: 0.04, createdAt: new Date(T0.getTime() - 20 * 60_000).toISOString(),
    });
    expect((await engine.tick()).media).toMatchObject({ failed: [expect.any(String)], pending: 0 });
  });

  it("validates before spending", async () => {
    const { engine, image } = imageSetup();
    await expect(engine.generateImage({ prompt: "x", referenceImageUri: "http://insecure.test/a.jpg" })).rejects.toThrow(/https/);
    const bare = new ContentEngine({ store: new MemoryStore(), adapters: {}, generator: new FakeGenerator() });
    await expect(bare.generateImage({ prompt: "x" })).rejects.toThrow(/GEMINI_API_KEY/);
    expect(image.requests).toHaveLength(0);
  });
});

describe("GeminiImageGenerator", () => {
  const PNG_B64 = Buffer.from([137, 80, 78, 71]).toString("base64");
  const ok = (parts: unknown[]) => json({ candidates: [{ content: { parts } }] });

  it("sends the key in a header and asks for an image in the requested aspect ratio", async () => {
    const { fn, calls } = mockFetch([{ match: (u) => u.includes(":generateContent"), reply: () => ok([{ text: "here" }, { inlineData: { mimeType: "image/png", data: PNG_B64 } }]) }]);
    const g = new GeminiImageGenerator({ apiKey: "AIza-secret-key", fetch: fn });
    const img = await g.generate({ prompt: "a fox", aspect: "9:16" });

    expect(img).toEqual({ bytes: new Uint8Array([137, 80, 78, 71]), mimeType: "image/png" });
    expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent");
    expect(calls[0]!.url).not.toContain("AIza"); // never in the URL
    expect((calls[0]!.init!.headers as Record<string, string>)["x-goog-api-key"]).toBe("AIza-secret-key");
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.generationConfig).toEqual({ responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "9:16" } });
    expect(body.contents[0].parts).toEqual([{ text: "a fox" }]);
  });

  it("attaches a reference image as inline data, and reads snake_case responses too", async () => {
    const { fn, calls } = mockFetch([{ match: () => true, reply: () => ok([{ inline_data: { mime_type: "image/jpeg", data: PNG_B64 } }]) }]);
    const img = await new GeminiImageGenerator({ apiKey: "k-1234567", fetch: fn }).generate({
      prompt: "edit", aspect: "1:1", reference: { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg" },
    });
    expect(img.mimeType).toBe("image/jpeg");
    expect(JSON.parse(String(calls[0]!.init!.body)).contents[0].parts[1]).toEqual({ inline_data: { mime_type: "image/jpeg", data: "AQID" } });
  });

  it("fails permanently when the answer has no image (blocked or text only)", async () => {
    const run = (body: unknown) => new GeminiImageGenerator({ apiKey: "k-1234567", fetch: mockFetch([{ match: () => true, reply: () => json(body) }]).fn }).generate({ prompt: "x", aspect: "1:1" }).catch((e) => e);
    expect(await run({ promptFeedback: { blockReason: "SAFETY" } })).toMatchObject({ permanent: true, message: expect.stringContaining("SAFETY") });
    expect(await run({ candidates: [{ content: { parts: [{ text: "sorry" }] }, finishReason: "STOP" }] })).toMatchObject({ permanent: true });
  });

  it("classifies HTTP errors and never echoes the key", async () => {
    const fail = (status: number, text: string) => new GeminiImageGenerator({ apiKey: "AIza-secret-key", fetch: mockFetch([{ match: () => true, reply: () => new Response(text, { status }) }]).fn }).generate({ prompt: "x", aspect: "1:1" }).catch((e) => e);
    const bad = await fail(400, "API key not valid: AIza-secret-key");
    expect(bad).toMatchObject({ permanent: true, status: 400 });
    expect(bad.message).not.toContain("AIza-secret-key");
    expect(await fail(429, "slow down")).toMatchObject({ permanent: false });
    expect(await fail(503, "x")).toMatchObject({ permanent: false });
  });

  it("estimates a flat, configurable price", async () => {
    expect((await new GeminiImageGenerator({ apiKey: "k" }).estimate()).usd).toBe(0.04);
    expect((await new GeminiImageGenerator({ apiKey: "k", costPerImageUsd: 0.07 }).estimate()).usd).toBe(0.07);
  });
});
