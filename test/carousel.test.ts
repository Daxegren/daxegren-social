import { describe, expect, it } from "vitest";
import jpeg from "jpeg-js";
import { buildCarousel, brandFromEnv, coverPhoto } from "../src/carousel/build.js";
import { cleanText, fit, renderSlide, richWords, SLIDE_HEIGHT, SLIDE_WIDTH, type Slide } from "../src/carousel/render.js";
import { ClaudeCarouselWriter, parseCarousel, type CarouselInput, type CarouselWriter, type WrittenCarousel } from "../src/carousel/write.js";
import type { Asset, ContentBrief } from "../src/domain.js";
import { ContentEngine } from "../src/engine.js";
import { MemoryStore } from "../src/store.js";
import { runCli } from "../src/worker/cli.js";
import { claudeMessage, FakeAdapter, FakeGenerator, isClaude, json, MemoryStorage, mockFetch } from "./helpers.js";
import { freshDb } from "./pg.js";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const brief: ContentBrief = { id: "b1", idea: "Tre saker om marginal", sourcePostIds: [], assetIds: [], createdAt: "2026-11-12T00:00:00Z" };
const slide = (kind: Slide["kind"], over: Partial<Slide> = {}): Slide => ({ kind, title: "Rubrik", ...over });
const slides = (n = 6): Slide[] => [slide("cover", { title: "Hook" }), ...Array.from({ length: n - 2 }, (_, i) => slide(i % 2 ? "statement" : "point", { title: `Sida ${i + 2}`, body: "Text." })), slide("cta", { title: "Vill du ha mallen?", keyword: "MALL" })];

class FakeWriter implements CarouselWriter {
  inputs: CarouselInput[] = [];
  constructor(private readonly make: (i: CarouselInput) => WrittenCarousel = (i) => ({ slides: slides(i.slideCount), captions: i.channels.map((channel) => ({ channel, text: `bildtext ${channel}` })) })) {}
  async write(input: CarouselInput) {
    this.inputs.push(input);
    return this.make(input);
  }
}

describe("rendering", () => {
  it("draws every kind of page as a 1080x1350 JPEG", async () => {
    const kinds: Slide[] = [
      slide("cover", { title: "3 saker jag önskar att jag visste", body: "Och som sparade mig ett år." }),
      slide("point", { title: "Börja med marginalen", body: "Räkna ut den per **produkt**, inte i snitt.\n\nDet ger **8 %** mer.", takeaway: "räkna marginalen per produkt innan du köper trafik.", takeawayLabel: "Ta med dig:" }),
      slide("list", { title: "Varje måndag", items: ["Marginal", "Returer", "Lagervärde"] }),
      slide("statement", { title: "Det du mäter förbättras." }),
      slide("cta", { title: "Vill du ha mallen?", keyword: "mall" }),
    ];
    for (const [i, s] of kinds.entries()) {
      const bytes = await renderSlide(s, i, kinds.length, { handle: "@david", accent: "#FF5500", theme: i % 2 ? "light" : "dark" });
      expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
      const img = jpeg.decode(bytes, { useTArray: true });
      expect([img.width, img.height]).toEqual([SLIDE_WIDTH, SLIDE_HEIGHT]);
    }
  }, 30_000);

  it("uses the accent colour and puts a photo behind the cover", async () => {
    const accent = jpeg.decode(await renderSlide(slide("cover", { title: "x" }), 0, 2, { accent: "#FF0000", theme: "dark" }), { useTArray: true });
    // The accent bar sits at the left edge of the cover: find a clearly red pixel.
    let red = 0;
    for (let i = 0; i < accent.data.length; i += 4) if (accent.data[i]! > 200 && accent.data[i + 1]! < 60 && accent.data[i + 2]! < 60) red++;
    expect(red).toBeGreaterThan(500);

    const photo = jpeg.encode({ data: Buffer.alloc(40 * 50 * 4, 255), width: 40, height: 50 }, 80).data;
    const uri = `data:image/jpeg;base64,${Buffer.from(photo).toString("base64")}`;
    const withPhoto = jpeg.decode(await renderSlide(slide("cover", { title: "x" }), 0, 2, { accent: "#FF0000", theme: "dark" }, uri), { useTArray: true });
    // A white photo under a dark gradient makes the page far lighter than the plain dark background.
    const mean = (d: Uint8Array) => d.reduce((a, v, i) => (i % 4 === 3 ? a : a + v), 0) / ((d.length / 4) * 3);
    expect(mean(withPhoto.data)).toBeGreaterThan(mean(accent.data) + 5);
  }, 30_000);

  it("marks emphasised words, keeps punctuation glued to them, and ignores unbalanced markers", () => {
    expect(richWords("Det blir **30 portioner**, så **bra**.")).toEqual([
      { word: "Det", strong: false, glued: false }, { word: "blir", strong: false, glued: false },
      { word: "30", strong: true, glued: false }, { word: "portioner", strong: true, glued: false },
      { word: ",", strong: false, glued: true }, { word: "så", strong: false, glued: false },
      { word: "bra", strong: true, glued: false }, { word: ".", strong: false, glued: true },
    ]);
    expect(richWords("öppen **utan slut").map((w) => w.strong)).toEqual([false, true, true]);
    expect(richWords("")).toEqual([]);
  });

  it("removes characters the font cannot draw and keeps Swedish letters", () => {
    expect(cleanText("Åre ä ö 🚀 – “citat” 日本")).toBe("Åre ä ö – “citat”");
    expect(fit("kort", [[10, 100], [20, 60]])).toBe(100);
    expect(fit("a".repeat(500), [[10, 100], [20, 60]])).toBe(60);
  });
});

describe("parseCarousel", () => {
  const raw = (o: unknown) => JSON.stringify(o);
  const input = { channels: ["linkedin" as const], slideCount: 6 };

  it("keeps a point page's takeaway and its label, and ignores a takeaway on other kinds", () => {
    const written = parseCarousel(raw({ slides: [slide("cover"), { kind: "point", title: "A", takeaway: "  gör så här  ", takeawayLabel: "**Steal this:**" }, { kind: "statement", title: "B", takeaway: "ignoreras" }, slide("point", { title: "C" }), slide("cta")], captions: [] }), { channels: ["linkedin"], slideCount: 6 });
    expect(written.slides[1]).toMatchObject({ takeaway: "gör så här", takeawayLabel: "Steal this:" });
    expect(written.slides[2]!.takeaway).toBeUndefined();
    expect(written.slides[3]!.takeaway).toBeUndefined();
  });

  it("keeps cover first and the closing page last, and never more pages than asked for", () => {
    const written = parseCarousel(raw({ slides: [...slides(10), slide("cta", { title: "Dubbel", keyword: "X" })], captions: [{ channel: "linkedin", text: "hej" }] }), input);
    expect(written.slides).toHaveLength(6);
    expect(written.slides[0]!.kind).toBe("cover");
    expect(written.slides.at(-1)!.kind).toBe("cta");
    expect(written.slides.filter((s) => s.kind === "cta")).toHaveLength(1);
    expect(written.slides.at(-1)!.title).toBe("Dubbel");
  });

  it("drops unusable pages and refuses an answer with too few left", () => {
    const messy = [slide("cover"), { kind: "poem", title: "x" }, slide("point", { title: "  " }), slide("list", { items: [] }), slide("point"), slide("point", { title: "B" }), slide("cta")];
    expect(parseCarousel(raw({ slides: messy, captions: [] }), input).slides.map((s) => s.kind)).toEqual(["cover", "point", "point", "cta"]);
    expect(() => parseCarousel(raw({ slides: [slide("cover"), slide("cta")], captions: [] }), input)).toThrow(/at least 4/);
    expect(() => parseCarousel("nej", input)).toThrow(/no JSON/);
  });

  it("the requested keyword wins and is normalised; captions are limited to known channels and the channel's length", () => {
    const written = parseCarousel(
      raw({ slides: slides(5), captions: [{ channel: "linkedin", text: "a".repeat(5000) }, { channel: "linkedin", text: "dubblett" }, { channel: "tiktok", text: "x" }] }),
      { channels: ["linkedin"], slideCount: 5, keyword: "så, mall!" },
    );
    expect(written.slides.at(-1)!.keyword).toBe("SÅMALL");
    expect(written.captions).toHaveLength(1);
    expect(written.captions[0]!.text).toHaveLength(3000);
  });
});

describe("ClaudeCarouselWriter", () => {
  const answer = JSON.stringify({ slides: slides(6), captions: [{ channel: "linkedin", text: "text" }] });
  it("asks for a JSON schema with the channels, shows the photos and passes the page count and keyword", async () => {
    const m = mockFetch([{ match: isClaude, reply: () => claudeMessage(answer) }]);
    const writer = new ClaudeCarouselWriter({ apiKey: "k-test-123", fetch: m.fn, maxRetries: 0 });
    const photo: Asset = { id: "p1", kind: "image", origin: "captured", uri: "https://cdn.test/me.jpg", createdAt: "" };
    const out = await writer.write({ brief, channels: ["linkedin"], insights: {}, examples: [], assets: [photo], slideCount: 6, keyword: "mall" });

    expect(out.slides).toHaveLength(6);
    const body = JSON.parse(String(m.calls[0]!.init!.body));
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.output_config.format.schema.properties.captions.items.properties.channel.enum).toEqual(["linkedin"]);
    expect(body.messages[0].content[0].text).toContain("Exactly 6 pages");
    expect(body.messages[0].content[0].text).toContain("keyword: MALL");
    expect(body.messages[0].content.some((b: { type: string }) => b.type === "image")).toBe(true);
  });
});

describe("buildCarousel", () => {
  const photo = (): Response => new Response(new Uint8Array(jpeg.encode({ data: Buffer.alloc(8 * 8 * 4, 128), width: 8, height: 8 }, 80).data), { headers: { "content-type": "image/jpeg" } });
  const img = (over: Partial<Asset>): Asset => ({ id: "p", kind: "image", origin: "captured", uri: "https://cdn.test/a.jpg", createdAt: "", ...over });

  it("picks the first usable photo for the cover (JPEG or PNG over https)", () => {
    expect(coverPhoto([img({ id: "w", uri: "https://x/a.webp" }), img({ id: "v", kind: "video", uri: "https://x/v.mp4" }), img({ id: "h", uri: "http://x/a.jpg" }), img({ id: "ok", uri: "https://x/a.PNG?x=1" })])?.id).toBe("ok");
  });

  it("draws a page per slide and falls back to a plain cover when the photo cannot be used", async () => {
    const good = mockFetch([{ match: (u) => u.includes("cdn.test"), reply: photo }]);
    const ok = await buildCarousel({ writer: new FakeWriter(), input: { brief, channels: ["linkedin"], insights: {}, examples: [], assets: [img({})], slideCount: 5 }, fetch: good.fn });
    expect(ok.images).toHaveLength(5);
    expect(ok.notes).toEqual([]);

    const bad = mockFetch([{ match: (u) => u.includes("cdn.test"), reply: () => new Response("<html>", { headers: { "content-type": "text/html" } }) }]);
    const fallback = await buildCarousel({ writer: new FakeWriter(), input: { brief, channels: ["linkedin"], insights: {}, examples: [], assets: [img({})], slideCount: 5 }, fetch: bad.fn });
    expect(fallback.images).toHaveLength(5);
    expect(fallback.notes[0]).toMatch(/cover photo could not be used.*not a JPEG or PNG/);
  }, 30_000);

  it("validates the brand settings", () => {
    expect(brandFromEnv({ CAROUSEL_HANDLE: " @david ", CAROUSEL_ACCENT: "#112233", CAROUSEL_THEME: "light" })).toEqual({ handle: "@david", accent: "#112233", theme: "light" });
    expect(brandFromEnv({})).toMatchObject({ theme: "dark" });
    expect(() => brandFromEnv({ CAROUSEL_ACCENT: "red" })).toThrow(/CAROUSEL_ACCENT/);
    expect(() => brandFromEnv({ CAROUSEL_THEME: "blue" })).toThrow(/CAROUSEL_THEME/);
  });
});

describe("ContentEngine.createCarousel", () => {
  const setup = (over: { writer?: CarouselWriter; storage?: boolean; autoApprove?: Array<"linkedin" | "instagram"> } = {}) => {
    const store = new MemoryStore();
    const storage = new MemoryStorage();
    const writer = over.writer ?? new FakeWriter();
    const engine = new ContentEngine({
      store,
      adapters: { linkedin: new FakeAdapter("linkedin"), instagram: new FakeAdapter("instagram") },
      generator: new FakeGenerator(),
      carouselWriter: writer,
      mediaStorage: over.storage === false ? undefined : storage,
      autoApprove: over.autoApprove,
      now: () => new Date("2026-11-12T08:00:00Z"),
    });
    return { store, storage, engine, writer: writer as FakeWriter };
  };

  it("stores the drawn pages as public JPEGs and drafts one variant per channel with the pages in order", async () => {
    const { engine, store, storage } = setup();
    const b = await engine.createBrief({ idea: "x", format: "carousel", ctaKeyword: "mall" });
    const drafts = await engine.createCarousel(b.id, ["linkedin", "instagram"]);

    expect(drafts.map((d) => [d.channel, d.status, d.text, d.assetIds.length])).toEqual([["linkedin", "draft", "bildtext linkedin", 8], ["instagram", "draft", "bildtext instagram", 8]]);
    expect(drafts[0]!.assetIds).toEqual(drafts[1]!.assetIds);
    expect(drafts[0]!.rationale).toContain("Karusell, 8 sidor");
    const pages = await store.getAssets(drafts[0]!.assetIds);
    expect(pages.map((p) => p.meta?.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(pages.every((p) => p.origin === "generated" && p.uri.endsWith(".jpg"))).toBe(true);
    expect([...storage.files.values()].every((f) => f.mimeType === "image/jpeg")).toBe(true);
    expect(storage.files.size).toBe(8);
  }, 60_000);

  it("uses the brief's keyword, caps the pages at what the channels accept and skips channels that cannot show a carousel", async () => {
    const { engine, writer } = setup();
    const b = await engine.createBrief({ idea: "x", ctaKeyword: "mall" });
    const drafts = await engine.createCarousel(b.id, ["linkedin", "tiktok", "pinterest"], { slideCount: 12 });
    expect(writer.inputs[0]).toMatchObject({ channels: ["linkedin"], slideCount: 9, keyword: "mall" });
    expect(drafts.map((d) => d.channel)).toEqual(["linkedin"]);
    await expect(engine.createCarousel(b.id, ["tiktok"])).rejects.toThrow(/at least 4 images/);
  }, 60_000);

  it("falls back to the cover title when the writer forgot a caption, and clears the review gate rules like other drafts", async () => {
    const writer = new FakeWriter((i) => ({ slides: slides(i.slideCount), captions: [] }));
    const { engine } = setup({ writer, autoApprove: ["linkedin"] });
    const b = await engine.createBrief({ idea: "x" });
    const [d] = await engine.createCarousel(b.id, ["linkedin"], { slideCount: 5 });
    expect(d!.text).toBe("Hook");
    expect(d!.status).toBe("scheduled");
  }, 60_000);

  it("says what is missing instead of failing obscurely", async () => {
    const noStorage = setup({ storage: false });
    const b = await noStorage.engine.createBrief({ idea: "x" });
    await expect(noStorage.engine.createCarousel(b.id, ["linkedin"])).rejects.toThrow(/public storage/);
    const bare = new ContentEngine({ store: new MemoryStore(), adapters: {}, generator: new FakeGenerator() });
    await expect(bare.createCarousel("x", ["linkedin"])).rejects.toThrow(/carousel writer/);
    await expect(setup().engine.createCarousel("nope", ["linkedin"])).rejects.toThrow(/unknown brief/);
  });

  it("a request made in the app with format 'carousel' becomes a carousel on the next tick", async () => {
    const { engine, store } = setup();
    await store.putBrief({ ...brief, id: crypto.randomUUID(), channels: ["linkedin"], status: "requested", format: "carousel", ctaKeyword: "MALL" });
    const res = await engine.processBriefRequests();
    expect(res.failed).toEqual([]);
    const [draft] = await store.listVariants();
    expect(draft!.assetIds).toHaveLength(8);
  }, 60_000);

  it("a failed carousel request is written back to the request", async () => {
    const writer = new FakeWriter(() => {
      throw new Error("the model refused");
    });
    const { engine, store } = setup({ writer });
    const id = crypto.randomUUID();
    await store.putBrief({ ...brief, id, channels: ["linkedin"], status: "requested", format: "carousel" });
    expect((await engine.processBriefRequests()).failed).toEqual([id]);
    expect(await store.getBrief(id)).toMatchObject({ status: "failed", error: "the model refused" });
  });
});

describe("social carousel", () => {
  const claude = mockFetch([
    { match: isClaude, reply: () => claudeMessage(JSON.stringify({ slides: slides(6), captions: [{ channel: "linkedin", text: "text" }] })) },
  ]);
  const env = { ANTHROPIC_API_KEY: "k-test-123456", CAROUSEL_HANDLE: "@david" };

  it("--preview draws the pages and captions into a folder without touching the database or storage", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "carousel-")), "out");
    const out = await runCli(["carousel", "Tre saker om marginal", "--channels", "linkedin", "--slides", "6", "--preview", dir], { env, sql: undefined as never, fetch: claude.fn });
    expect(out).toContain("6 pages");
    expect(readdirSync(dir).sort()).toEqual(["captions.txt", ...Array.from({ length: 6 }, (_, i) => `page-0${i + 1}.jpg`)]);
    expect(readFileSync(join(dir, "captions.txt"), "utf8")).toContain("[linkedin]\ntext");
  }, 60_000);

  it("checks --slides", async () => {
    await expect(runCli(["carousel", "x", "--preview", "/tmp/x", "--slides", "40"], { env, sql: undefined as never, fetch: claude.fn })).rejects.toThrow(/--slides/);
  });

  it("without --preview it drafts into the database", async () => {
    const { sql } = await freshDb();
    const storage = mockFetch([
      { match: isClaude, reply: () => claudeMessage(JSON.stringify({ slides: slides(5), captions: [{ channel: "linkedin", text: "text" }] })) },
      { match: (u) => u.includes("/storage/v1/object/"), reply: () => json({ Key: "ok" }) },
    ]);
    const full = { ...env, SUPABASE_URL: "https://abc.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key-123", LINKEDIN_AUTHOR_URN: "urn:li:person:1", LINKEDIN_ACCESS_TOKEN: "li-token-123456" };
    const out = await runCli(["carousel", "Tre saker", "--channels", "linkedin", "--slides", "5", "--keyword", "mall"], { env: full, sql, fetch: storage.fn });
    expect(out).toMatch(/^linkedin\tdraft\t[0-9a-f-]{36}\t5 pages$/);
    expect(storage.calls.filter((c) => c.url.includes("/storage/v1/object/"))).toHaveLength(5);
    expect((await sql.query<{ format: string; cta_keyword: string }>(`select format, cta_keyword from social_briefs`))[0]).toEqual({ format: "carousel", cta_keyword: "mall" });
  }, 60_000);
});
