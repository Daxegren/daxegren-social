import { describe, expect, it } from "vitest";
import { validateVariant } from "../src/channels.js";
import { ClaudeContentGenerator, parseVariants, viewableImages } from "../src/generate.js";
import type { Asset, ContentBrief } from "../src/domain.js";
import { claudeMessage, isClaude, mockFetch } from "./helpers.js";

const brief: ContentBrief = { id: "b", idea: "i", sourcePostIds: [], assetIds: [], createdAt: "2026-11-02T00:00:00Z" };
const img: Asset = { id: "a1", kind: "image", origin: "captured", uri: "https://cdn.test/a.jpg", createdAt: "" };
const input = { brief, channels: ["linkedin" as const, "x" as const], insights: {}, examples: [], assets: [img] };

describe("parseVariants", () => {
  it("extracts JSON surrounded by prose or code fences", () => {
    const raw = 'Here you go:\n```json\n{"variants":[{"channel":"linkedin","text":"hi","assetIds":["a1"],"rationale":"r"}]}\n```';
    expect(parseVariants(raw, input)).toEqual([{ channel: "linkedin", text: "hi", assetIds: ["a1"], rationale: "r" }]);
  });

  it("drops unknown channels and hallucinated asset ids", () => {
    const raw = JSON.stringify({
      variants: [
        { channel: "linkedin", text: "ok", assetIds: ["a1", "ghost"] },
        { channel: "tiktok", text: "not requested", assetIds: [] },
      ],
    });
    const out = parseVariants(raw, input);
    expect(out).toHaveLength(1);
    expect(out[0]!.assetIds).toEqual(["a1"]);
  });

  it("throws when there is no JSON", () => {
    expect(() => parseVariants("sorry", input)).toThrow(/no JSON/);
  });
});

describe("ClaudeContentGenerator", () => {
  const answer = '{"variants":[{"channel":"x","text":"short","assetIds":[],"rationale":"r"}]}';
  const generator = (reply: () => Response, over: Partial<ConstructorParameters<typeof ClaudeContentGenerator>[0]> = {}) => {
    const m = mockFetch([{ match: isClaude, reply }]);
    return { gen: new ClaudeContentGenerator({ apiKey: "k-test-123", fetch: m.fn, maxRetries: 0, ...over }), calls: m.calls };
  };
  const bodyOf = (calls: Array<{ init?: RequestInit }>) => JSON.parse(String(calls[0]!.init!.body));

  it("sends what the model needs: Opus 5.5, adaptive thinking, a JSON schema per channel, the server-side fallback", async () => {
    const { gen, calls } = generator(() => claudeMessage(answer));
    const out = await gen.generate(input);

    expect(out).toEqual([{ channel: "x", text: "short", assetIds: [], rationale: "r", imagePrompt: undefined }]);
    expect(calls[0]!.url).toContain("https://api.anthropic.com/v1/messages");
    expect(calls[0]!.init!.headers).toBeDefined();
    const headers = new Headers(calls[0]!.init!.headers as HeadersInit);
    expect(headers.get("authorization")).toBe("Bearer k-test-123");
    expect(headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");

    const body = bodyOf(calls);
    expect(body).toMatchObject({
      model: "claude-opus-5-5",
      thinking: { type: "adaptive" },
      fallbacks: [{ model: "claude-opus-4-8" }],
      output_config: { effort: "medium", format: { type: "json_schema" } },
    });
    expect(body.system).toMatch(/in their voice/);
    const schema = body.output_config.format.schema;
    expect(schema.properties.variants.items.properties.channel.enum).toEqual(["linkedin", "x"]);
    expect(schema.properties.variants.items.required).not.toContain("imagePrompt");
    expect(body.messages[0].content[0].text).toContain("Channels and hard limits");
  });

  it("shows the model the creator's photos, each after a label with its asset id, and never a video", async () => {
    const photo: Asset = { id: "p1", kind: "image", origin: "captured", uri: "https://cdn.test/me.jpg", createdAt: "" };
    const made: Asset = { id: "g1", kind: "image", origin: "generated", uri: "https://cdn.test/gen.png", createdAt: "" };
    const clip: Asset = { id: "v1", kind: "video", origin: "captured", uri: "https://cdn.test/clip.mp4", createdAt: "" };
    const { gen, calls } = generator(() => claudeMessage(answer));
    await gen.generate({ ...input, assets: [photo, clip, made] });

    const content = bodyOf(calls).messages[0].content as Array<{ type: string; text?: string; source?: { type: string; url: string } }>;
    expect(content.filter((b) => b.type === "image").map((b) => b.source)).toEqual([
      { type: "url", url: "https://cdn.test/me.jpg" },
      { type: "url", url: "https://cdn.test/gen.png" },
    ]);
    const texts = content.filter((b) => b.type === "text").map((b) => b.text);
    expect(texts).toContain("Asset p1 (the creator's own photo):");
    expect(texts[0]).toContain("v1: video, own (video, cannot be viewed)");
    expect(texts[0]).toContain("p1: image, own (shown below)");
  });

  it("only shows images it can look at: https, a known format, at most eight", () => {
    const img = (id: string, uri: string): Asset => ({ id, kind: "image", origin: "captured", uri, createdAt: "" });
    expect(viewableImages([img("a", "https://x/a.heic"), img("b", "http://x/b.jpg"), img("c", "https://x/c.avif"), img("d", "https://x/d.PNG?x=1"), img("e", "https://x/e")]).map((a) => a.id)).toEqual(["d", "e"]);
    expect(viewableImages(Array.from({ length: 12 }, (_, i) => img(`i${i}`, `https://x/${i}.jpg`)))).toHaveLength(8);
  });

  it("passes on the playbook and trend notes, and asks for an image description only when wanted", async () => {
    const withImage = generator(() => claudeMessage('{"variants":[{"channel":"x","text":"t","assetIds":[],"rationale":"r","imagePrompt":"  A red mug on a table  "}]}'));
    const out = await withImage.gen.generate({ ...input, playbook: "Open with a number.", trends: "Carousels are up.", wantImagePrompt: true });
    expect(out[0]!.imagePrompt).toBe("A red mug on a table");
    const body = bodyOf(withImage.calls);
    const text = body.messages[0].content[0].text as string;
    expect(text).toContain("## Playbook");
    expect(text).toContain("Open with a number.");
    expect(text).toContain("## Trends right now");
    expect(text).toContain("`imagePrompt`");
    expect(body.output_config.format.schema.properties.variants.items.required).toContain("imagePrompt");
  });

  it("omits the playbook and trend sections when there are none", async () => {
    const { gen, calls } = generator(() => claudeMessage(answer));
    await gen.generate(input);
    const text = bodyOf(calls).messages[0].content[0].text as string;
    expect(text).not.toContain("## Playbook");
    expect(text).not.toContain("## Trends");
    expect(text).not.toContain("imagePrompt");
  });

  it("another model gets its own fallback, or none; the fallback can be switched off", async () => {
    const sent = async (over: Parameters<typeof generator>[1]) => {
      const { gen, calls } = generator(() => claudeMessage(answer), over);
      await gen.generate(input);
      return { body: bodyOf(calls), beta: new Headers(calls[0]!.init!.headers as HeadersInit).get("anthropic-beta") };
    };
    expect((await sent({ model: "claude-sonnet-5-5" })).body.fallbacks).toEqual([{ model: "claude-sonnet-5" }]);
    const unknown = await sent({ model: "claude-haiku-5-5" });
    expect(unknown.body.fallbacks).toBeUndefined();
    expect(unknown.beta ?? "").not.toContain("server-side-fallback");
    expect((await sent({ fallbackModel: false })).body.fallbacks).toBeUndefined();
    expect((await sent({ fallbackModel: "claude-opus-4-7" })).body.fallbacks).toEqual([{ model: "claude-opus-4-7" }]);
  });

  it("a refusal is a clear, non-retryable error that names the category", async () => {
    const { gen } = generator(() => claudeMessage("", { stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber" }, content: [] }));
    await expect(gen.generate(input)).rejects.toMatchObject({ name: "ClaudeRefusalError", category: "cyber", message: expect.stringContaining("cyber") });
  });

  it("an answer cut off by max_tokens is reported, not half-parsed", async () => {
    const { gen } = generator(() => claudeMessage('{"variants":[{"channel"', { stop_reason: "max_tokens" }));
    await expect(gen.generate(input)).rejects.toThrow(/cut off/);
  });

  it("API errors surface with their status", async () => {
    const { gen } = generator(() => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad" } }), { status: 400, headers: { "content-type": "application/json" } }));
    await expect(gen.generate(input)).rejects.toMatchObject({ status: 400 });
  });

  it("needs a key or a client", () => {
    expect(() => new ClaudeContentGenerator({})).toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe("validateVariant", () => {
  it("flags over-long text, missing media, wrong media kind and non-https uris", () => {
    expect(validateVariant({ channel: "x", text: "a".repeat(281), assetIds: [] }, [])[0]).toMatch(/280/);
    expect(validateVariant({ channel: "tiktok", text: "t", assetIds: [] }, [])).toContain("tiktok requires media");
    expect(validateVariant({ channel: "tiktok", text: "t", assetIds: ["a1"] }, [img])).toContain("tiktok does not accept image");
    const http = { ...img, uri: "http://insecure.test/a.jpg" };
    expect(validateVariant({ channel: "linkedin", text: "t", assetIds: ["a1"] }, [http]).join()).toMatch(/https/);
  });

  it("accepts a valid variant", () => {
    expect(validateVariant({ channel: "linkedin", text: "fine", assetIds: [] }, [])).toEqual([]);
  });

  describe("Instagram takes JPEG only", () => {
    const withUri = (uri: string): Asset => ({ ...img, uri });
    const problems = (uri: string, channel: "instagram" | "linkedin" = "instagram") =>
      validateVariant({ channel, text: "t", assetIds: ["a1"] }, [withUri(uri)]).filter((p) => /JPEG/.test(p));

    it("flags PNG, WebP, HEIC and GIF images on Instagram, naming the file type", () => {
      for (const ext of ["png", "webp", "heic", "gif"]) expect(problems(`https://cdn.test/a.${ext}`)).toEqual([expect.stringContaining(`.${ext}`)]);
      expect(problems("https://cdn.test/A.PNG")).toHaveLength(1); // case does not matter
    });

    it("accepts JPEG in either spelling, ignores query strings, and lets unknown extensions through", () => {
      expect(problems("https://cdn.test/a.jpg")).toEqual([]);
      expect(problems("https://cdn.test/a.JPEG")).toEqual([]);
      expect(problems("https://cdn.test/a.jpg?token=x.png")).toEqual([]);
      expect(problems("https://cdn.test/image")).toEqual([]);
      expect(problems("https://cdn.test/photo.v2/image")).toEqual([]);
    });

    it("does not apply to videos, or to other channels", () => {
      const video: Asset = { ...img, kind: "video", uri: "https://cdn.test/a.png" };
      expect(validateVariant({ channel: "instagram", text: "t", assetIds: ["a1"] }, [video]).filter((p) => /JPEG/.test(p))).toEqual([]);
      expect(problems("https://cdn.test/a.png", "linkedin")).toEqual([]);
    });
  });
});
