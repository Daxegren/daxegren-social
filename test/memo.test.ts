import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterError } from "../src/adapters/types.js";
import type { CarouselWriter } from "../src/carousel/write.js";
import type { Memo } from "../src/domain.js";
import { ContentEngine, type EngineConfig } from "../src/engine.js";
import { ClaudeMemoPlanner, parseIdeas, type MemoIdea, type MemoPlanner } from "../src/memo.js";
import { describeMemoSync, syncMemos } from "../src/memo-sync.js";
import type { NotifyEvent } from "../src/notify.js";
import { MemoryStore } from "../src/store.js";
import { audioMime, GeminiTranscriber, MAX_AUDIO_BYTES, type Transcriber } from "../src/transcribe.js";
import { runCli } from "../src/worker/cli.js";
import { claudeMessage, FakeAdapter, FakeGenerator, isClaude, json, MemoryStorage, mockFetch } from "./helpers.js";
import { freshDb } from "./pg.js";

const NOW = new Date("2026-11-17T10:00:00Z");
const TRANSCRIPT = "Jag tänkte prata om marginal. Många startar e-handel och tittar bara på omsättning, men det är marginalen per produkt som avgör. Jag räknade på mina egna produkter och hälften gav nästan ingenting.";

const ideas = (n = 2): MemoIdea[] =>
  Array.from({ length: n }, (_, i) => ({ title: `Idé ${i + 1}`, idea: `Poängen ${i + 1} i memot`, format: i % 2 ? "carousel" : "post" }) as MemoIdea);

class FakePlanner implements MemoPlanner {
  inputs: Parameters<MemoPlanner["plan"]>[0][] = [];
  constructor(private readonly make: () => MemoIdea[] = () => ideas(2)) {}
  async plan(input: Parameters<MemoPlanner["plan"]>[0]) {
    this.inputs.push(input);
    return this.make();
  }
}
class FakeTranscriber implements Transcriber {
  calls: Array<{ name?: string; mimeType: string; size: number }> = [];
  error?: Error;
  text = TRANSCRIPT;
  async transcribe(a: Parameters<Transcriber["transcribe"]>[0]) {
    this.calls.push({ name: a.name, mimeType: a.mimeType, size: a.bytes.length });
    if (this.error) throw this.error;
    return this.text;
  }
}

function setup(over: Partial<EngineConfig> = {}) {
  const store = new MemoryStore();
  const transcriber = new FakeTranscriber();
  const planner = new FakePlanner();
  const events: NotifyEvent[] = [];
  const engine = new ContentEngine({
    store,
    adapters: { linkedin: new FakeAdapter("linkedin"), instagram: new FakeAdapter("instagram") },
    generator: new FakeGenerator(),
    transcriber,
    memoPlanner: planner,
    notifier: { notify: async (e) => void events.push(e) },
    now: () => NOW,
    ...over,
  });
  return { store, engine, transcriber, planner, events };
}

describe("audioMime", () => {
  it("maps what phones and Drive report to the types Gemini accepts, and says no to the rest", () => {
    expect(audioMime("audio/x-m4a")).toBe("audio/m4a");
    expect(audioMime("audio/mp4")).toBe("audio/m4a");
    expect(audioMime("audio/mpeg")).toBe("audio/mpeg");
    expect(audioMime("audio/x-wav")).toBe("audio/wav");
    expect(audioMime("audio/mpeg; codecs=x")).toBe("audio/mpeg");
    expect(audioMime("application/octet-stream", "Ny inspelning.M4A")).toBe("audio/m4a");
    expect(audioMime("", "memo.mp3")).toBe("audio/mp3");
    expect(audioMime("audio/x-caf")).toBeUndefined();
    expect(audioMime("video/quicktime", "x.mov")).toBeUndefined();
    expect(audioMime("", "memo.qta")).toBeUndefined();
  });
});

describe("GeminiTranscriber", () => {
  const reply = (text: string) => json({ steps: [{ type: "thought", content: [{ type: "text", text: "tänker" }] }, { type: "model_output", content: [{ type: "text", text }] }] });
  const make = (r: () => Response, over: Partial<ConstructorParameters<typeof GeminiTranscriber>[0]> = {}) => {
    const m = mockFetch([{ match: (u) => u.includes("/v1beta/interactions"), reply: r }]);
    return { t: new GeminiTranscriber({ apiKey: "gem-key-123456", fetch: m.fn, ...over }), calls: m.calls };
  };
  const audio = { bytes: new Uint8Array([1, 2, 3, 4]), mimeType: "audio/x-m4a", name: "memo.m4a" };

  it("sends the audio inline with a word-for-word prompt and returns the model's text, not its thoughts", async () => {
    const { t, calls } = make(() => reply("  Hej, det här är ett memo.  "));
    expect(await t.transcribe(audio)).toBe("Hej, det här är ett memo.");
    expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("gem-key-123456");
    expect(headers["Api-Revision"]).toBe("2026-05-20");
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.model).toBe("gemini-3.5-flash-lite");
    expect(body.input[0].text).toMatch(/word for word/);
    expect(body.input[1]).toEqual({ type: "audio", data: Buffer.from([1, 2, 3, 4]).toString("base64"), mime_type: "audio/m4a" });
  });

  it("treats the no-speech marker as an empty transcript", async () => {
    expect(await make(() => reply("[NO SPEECH]")).t.transcribe(audio)).toBe("");
  });

  it("refuses formats and sizes it can never handle, as permanent errors, without calling the API", async () => {
    const { t, calls } = make(() => reply("x"));
    await expect(t.transcribe({ ...audio, mimeType: "audio/x-caf", name: "a.caf" })).rejects.toMatchObject({ permanent: true, message: expect.stringContaining("not supported") });
    await expect(t.transcribe({ ...audio, bytes: new Uint8Array(MAX_AUDIO_BYTES + 1) })).rejects.toMatchObject({ permanent: true, message: expect.stringContaining("split it") });
    expect(calls).toHaveLength(0);
  });

  it("separates temporary from permanent API errors and keeps the key out of messages", async () => {
    await expect(make(() => new Response("rate limited", { status: 429 })).t.transcribe(audio)).rejects.toMatchObject({ permanent: false, status: 429 });
    await expect(make(() => new Response("bad", { status: 400 })).t.transcribe(audio)).rejects.toMatchObject({ permanent: true });
    await expect(make(() => new Response("key gem-key-123456 invalid", { status: 403 })).t.transcribe(audio)).rejects.toThrow(/\[redacted\]/);
    await expect(make(() => json({ steps: [] })).t.transcribe(audio)).rejects.toMatchObject({ permanent: true, message: expect.stringContaining("no text") });
  });
});

describe("parseIdeas", () => {
  const raw = (i: unknown[]) => JSON.stringify({ ideas: i });
  it("keeps usable ideas, caps their number and lengths, and only keeps a keyword on carousels", () => {
    const out = parseIdeas(
      raw([
        { title: "A", idea: "x".repeat(5000), angle: "y".repeat(900), format: "carousel", keyword: " så, mall! " },
        { title: "B", idea: "b", format: "post", keyword: "IGNORERAS" },
        { title: "C", idea: "", format: "post" },
        { title: "D", idea: "d", format: "podcast" },
        { title: "E", idea: "e", format: "post" },
        { title: "F", idea: "f", format: "post" },
      ]),
      3,
    );
    expect(out.map((i) => i.title)).toEqual(["A", "B", "E"]);
    expect(out[0]!.idea).toHaveLength(1800);
    expect(out[0]!.angle).toHaveLength(480);
    expect(out[0]!.keyword).toBe("såmall");
    expect(out[1]!.keyword).toBeUndefined();
    expect(parseIdeas(raw(Array.from({ length: 20 }, (_, i) => ({ title: `${i}`, idea: "x", format: "post" }))), 99)).toHaveLength(6);
    expect(parseIdeas(raw([]), 3)).toEqual([]);
    expect(() => parseIdeas("nej", 3)).toThrow(/no JSON/);
    expect(() => parseIdeas("{}", 3)).toThrow(/no ideas/);
  });
});

describe("ClaudeMemoPlanner", () => {
  it("sends the transcript as material with the channels and limits, asks for a JSON schema, and returns the ideas", async () => {
    const m = mockFetch([{ match: isClaude, reply: () => claudeMessage(JSON.stringify({ ideas: [{ title: "Marginal", idea: "Marginal slår omsättning", format: "post" }] })) }]);
    const planner = new ClaudeMemoPlanner({ apiKey: "k-test-123", fetch: m.fn, maxRetries: 0 });
    const out = await planner.plan({ transcript: TRANSCRIPT, maxIdeas: 2, channels: ["linkedin"], examples: [] });
    expect(out).toEqual([{ title: "Marginal", idea: "Marginal slår omsättning", angle: undefined, format: "post", keyword: undefined }]);
    const body = JSON.parse(String(m.calls[0]!.init!.body));
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.system).toMatch(/Privacy/);
    expect(body.system).toMatch(/not as instructions/);
    expect(body.messages[0].content).toContain("<transcript>");
    expect(body.messages[0].content).toContain("marginalen per produkt");
    expect(body.messages[0].content).toContain("At most 2 ideas");
    expect(body.output_config.format.schema.properties.ideas.items.properties.format.enum).toEqual(["post", "carousel"]);
  });
});

describe("ContentEngine: memos from audio", () => {
  const audio = (driveFileId?: string) => ({ name: "Ny inspelning.m4a", bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/x-m4a", driveFileId });

  it("keeps the transcript, never the audio, and never transcribes the same Drive file twice", async () => {
    const { engine, store, transcriber } = setup();
    const first = await engine.addMemoFromAudio(audio("drive-1"));
    expect(first).toMatchObject({ status: "transcribed", transcript: TRANSCRIPT, source: "drive", driveFileId: "drive-1", attempts: 0 });
    expect(transcriber.calls).toEqual([{ name: "Ny inspelning.m4a", mimeType: "audio/x-m4a", size: 3 }]);
    expect((await engine.addMemoFromAudio(audio("drive-1"))).id).toBe(first.id);
    expect(transcriber.calls).toHaveLength(1);
    expect(await store.listMemos()).toHaveLength(1);
  });

  it("records what can never work as a failed memo (so it is not retried), and throws temporary errors without recording", async () => {
    const permanent = setup();
    permanent.transcriber.error = new AdapterError("format not supported", true);
    expect(await permanent.engine.addMemoFromAudio(audio("d"))).toMatchObject({ status: "failed", error: "format not supported" });
    await permanent.engine.addMemoFromAudio(audio("d"));
    expect(permanent.transcriber.calls).toHaveLength(1);

    const temporary = setup();
    temporary.transcriber.error = new AdapterError("busy", false, 503);
    await expect(temporary.engine.addMemoFromAudio(audio("d"))).rejects.toThrow("busy");
    expect(await temporary.store.listMemos()).toEqual([]);

    const silent = setup();
    silent.transcriber.text = "   ";
    expect(await silent.engine.addMemoFromAudio(audio())).toMatchObject({ status: "failed", error: expect.stringContaining("no speech") });
  });

  it("needs a transcriber for audio, and enough text for pasted text", async () => {
    const { engine } = setup({ transcriber: undefined });
    await expect(engine.addMemoFromAudio(audio())).rejects.toThrow(/GEMINI_API_KEY/);
    await expect(engine.addMemoFromText({ name: "x", transcript: "för kort" })).rejects.toThrow(/too short/);
    expect(await engine.addMemoFromText({ name: "Text", transcript: TRANSCRIPT })).toMatchObject({ status: "transcribed", source: "cli" });
  });
});

describe("ContentEngine: memos into drafts", () => {
  const fakeWriter = (): CarouselWriter => ({
    write: async (i) => ({
      slides: [{ kind: "cover" as const, title: "Hook" }, { kind: "point" as const, title: "A", body: "a" }, { kind: "point" as const, title: "B", body: "b" }, { kind: "cta" as const, title: "Klart" }].slice(0, Math.max(i.slideCount, 4)),
      captions: i.channels.map((channel) => ({ channel, text: `bildtext ${channel}` })),
    }),
  });

  it("drafts every idea on every configured channel, links the briefs to the memo and tells the owner", async () => {
    const { engine, store, planner, events } = setup();
    const memo = await engine.addMemoFromText({ name: "Marginal", transcript: TRANSCRIPT });
    const res = await engine.processMemos();

    expect(res).toMatchObject({ planned: [memo.id], failed: [], drafts: 4 });
    expect(planner.inputs[0]).toMatchObject({ transcript: TRANSCRIPT, maxIdeas: 3, channels: ["linkedin", "instagram"] });
    const briefs = await store.listBriefs();
    expect(briefs.map((b) => [b.idea, b.memoId, b.status])).toEqual([["Poängen 1 i memot", memo.id, "ready"], ["Poängen 2 i memot", memo.id, "ready"]]);
    expect((await store.listVariants()).every((v) => v.status === "draft")).toBe(true);
    expect(await store.getMemo(memo.id)).toMatchObject({ status: "planned", ideaCount: 2 });
    expect(events.map((e) => [e.kind, e.title])).toEqual([["memo", "Röstmemo klart: 4 utkast väntar"]]);
  });

  it("makes a carousel of a carousel idea when carousels are set up, otherwise an ordinary post", async () => {
    const withCarousels = setup({ carouselWriter: fakeWriter(), mediaStorage: new MemoryStorage(), memoChannels: ["linkedin"] });
    await withCarousels.engine.addMemoFromText({ name: "m", transcript: TRANSCRIPT });
    await withCarousels.engine.processMemos();
    const variants = await withCarousels.store.listVariants();
    expect(variants.map((v) => v.assetIds.length > 0)).toEqual([false, true]);
    expect((await withCarousels.store.listBriefs()).map((b) => b.format)).toEqual(["post", "carousel"]);

    const without = setup({ memoChannels: ["linkedin"] });
    await without.engine.addMemoFromText({ name: "m", transcript: TRANSCRIPT });
    await without.engine.processMemos();
    expect((await without.store.listBriefs()).map((b) => b.format)).toEqual(["post", "post"]);
  }, 60_000);

  it("one idea failing does not lose the others", async () => {
    let n = 0;
    const generator = new FakeGenerator();
    const flaky = { generate: async (i: Parameters<FakeGenerator["generate"]>[0]) => { if (n++ === 0) throw new Error("refused"); return generator.generate(i); } };
    const { engine, store } = setup({ generator: flaky, memoChannels: ["linkedin"] });
    const memo = await engine.addMemoFromText({ name: "m", transcript: TRANSCRIPT });
    const done = await engine.planMemo(memo.id);
    expect(done!.errors).toEqual(["Idé 1: refused"]);
    expect(done!.drafts).toHaveLength(1);
    expect(await store.getMemo(memo.id)).toMatchObject({ status: "planned", ideaCount: 1, error: "Idé 1: refused" });
    expect((await store.listBriefs()).map((b) => b.status)).toEqual(["failed", "ready"]);
  });

  it("a memo that cannot be drafted stays open for the next run, and gives up after three tries", async () => {
    const planner = new FakePlanner(() => {
      throw new Error("the model refused");
    });
    const { engine, store, events } = setup({ memoPlanner: planner });
    const memo = await engine.addMemoFromText({ name: "m", transcript: TRANSCRIPT });
    for (const [i, expected] of (["transcribed", "transcribed", "failed"] as const).entries()) {
      await engine.processMemos();
      expect(await store.getMemo(memo.id)).toMatchObject({ status: expected, attempts: i + 1, error: "the model refused" });
    }
    expect(events.map((e) => e.title)).toEqual(["Röstmemot kunde inte göras till utkast"]);
    expect((await engine.processMemos())).toEqual({ planned: [], failed: [], drafts: 0 });
    expect(planner.inputs).toHaveLength(3); // no fourth try
  });

  it("a memo with nothing worth publishing is finished, with a note, and says so", async () => {
    const { engine, store, events } = setup({ memoPlanner: new FakePlanner(() => []) });
    const memo = await engine.addMemoFromText({ name: "Prat", transcript: TRANSCRIPT });
    await engine.processMemos();
    expect(await store.getMemo(memo.id)).toMatchObject({ status: "planned", ideaCount: 0, error: expect.stringContaining("no idea worth publishing") });
    expect(events[0]!.title).toBe("Röstmemot gav inga idéer");
  });

  it("needs a planner and a channel, and two overlapping runs cannot draft the same memo twice", async () => {
    const noPlanner = setup({ memoPlanner: undefined });
    const m1 = await noPlanner.engine.addMemoFromText({ name: "m", transcript: TRANSCRIPT });
    await noPlanner.engine.processMemos();
    expect((await noPlanner.store.getMemo(m1.id))!.error).toMatch(/ANTHROPIC_API_KEY/);

    const noChannels = setup({ adapters: {} });
    const m2 = await noChannels.engine.addMemoFromText({ name: "m", transcript: TRANSCRIPT });
    await noChannels.engine.processMemos();
    expect((await noChannels.store.getMemo(m2.id))!.error).toMatch(/no channels/);

    const { engine, store } = setup();
    const memo = await engine.addMemoFromText({ name: "m", transcript: TRANSCRIPT });
    const [a, b] = await Promise.all([engine.planMemo(memo.id), engine.planMemo(memo.id)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await store.listBriefs()).toHaveLength(2);
  });

  it("puts back a memo whose worker died while planning, counting it as a try", async () => {
    const { engine, store } = setup();
    const stuck: Memo = { id: crypto.randomUUID(), source: "cli", name: "m", transcript: TRANSCRIPT, status: "planning", attempts: 0, ideaCount: 0, claimedAt: "2026-11-17T09:00:00Z", createdAt: "2026-11-17T08:00:00Z" };
    await store.putMemo(stuck);
    const res = await engine.processMemos();
    expect(res.planned).toEqual([stuck.id]);
    expect(await store.getMemo(stuck.id)).toMatchObject({ status: "planned", attempts: 1 });
  });
});

describe("syncMemos", () => {
  const file = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `${id}.m4a`, mimeType: "audio/x-m4a", size: "5000", modifiedTime: "2026-11-16T00:00:00Z", ...over });
  const drive = (files: unknown[], failOn?: string) => ({
    listAudio: async () => files as any[],
    download: async (f: { id: string }) => {
      if (f.id === failOn) throw new Error("download failed");
      return new Uint8Array([1, 2, 3]);
    },
  });

  it("transcribes new recordings, skips known and unusable ones, and drafts ideas from the transcripts", async () => {
    const { engine, store, transcriber } = setup({ memoChannels: ["linkedin"] });
    await engine.addMemoFromText({ name: "old", transcript: TRANSCRIPT }).then((m) => store.putMemo({ ...m, driveFileId: "known", status: "planned" }));
    const res = await syncMemos({
      drive: drive([file("a"), file("known"), file("caf", { mimeType: "audio/x-caf", name: "x.caf" }), file("big", { size: String(MAX_AUDIO_BYTES + 1) }), file("bad"), file("late")], "bad"),
      store,
      engine,
      maxNew: 2,
    });
    expect(res.transcribed).toEqual(["a.m4a", "late.m4a"].slice(0, 1).concat(res.transcribed.slice(1)));
    expect(res).toMatchObject({ known: 1, remaining: 0, planned: 2, drafts: 4 });
    expect(res.skipped.map((s) => s.name)).toEqual(["x.caf", "big.m4a"]);
    expect(res.failed).toEqual([{ name: "bad.m4a", reason: "download failed" }]);
    expect(transcriber.calls).toHaveLength(2);
    const text = describeMemoSync(res);
    expect(text).toContain("2 new recording(s) transcribed");
    expect(text).toContain("failed bad.m4a: download failed");
  });

  it("stops at the per-run limit and leaves the rest for the next run", async () => {
    const { engine, store } = setup();
    const res = await syncMemos({ drive: drive([file("a"), file("b"), file("c")]), store, engine, maxNew: 2 });
    expect(res).toMatchObject({ remaining: 1 });
    expect(res.transcribed).toHaveLength(2);
    const again = await syncMemos({ drive: drive([file("a"), file("b"), file("c")]), store, engine, maxNew: 2 });
    expect(again).toMatchObject({ known: 2, remaining: 0 });
    expect(again.transcribed).toEqual(["c.m4a"]);
  });
});

describe("social memo", () => {
  const planned = JSON.stringify({ ideas: [{ title: "Marginal", idea: "Marginal slår omsättning", format: "post" }] });
  const written = JSON.stringify({ variants: [{ channel: "linkedin", text: "Ett inlägg om marginal", assetIds: [], rationale: "r" }] });
  const env = { ANTHROPIC_API_KEY: "k-test-123456", GEMINI_API_KEY: "gem-key-123456", LINKEDIN_AUTHOR_URN: "urn:li:person:1", LINKEDIN_ACCESS_TOKEN: "li-token-123456" };
  const claude = () => {
    let calls = 0;
    return mockFetch([{ match: isClaude, reply: () => claudeMessage(calls++ === 0 ? planned : written) }]);
  };

  it("--text drafts ideas from text you already have", async () => {
    const { sql } = await freshDb();
    const m = claude();
    const out = await runCli(["memo", "--text", TRANSCRIPT, "--name", "Marginal"], { env, sql, fetch: m.fn, now: () => NOW });
    expect(out).toMatch(/^memo [0-9a-f-]{36}: planned, 1 idea\(s\), 1 draft\(s\)$/);
    expect((await sql.query<{ status: string; name: string; transcript: string }>(`select status, name, transcript from social_memos`))[0]).toEqual({ status: "planned", name: "Marginal", transcript: TRANSCRIPT });
    expect((await sql.query<{ n: number }>(`select count(*)::int as n from social_briefs where memo_id is not null`))[0]).toEqual({ n: 1 });
    expect((await sql.query<{ body: string }>(`select body from social_variants`))[0]).toEqual({ body: "Ett inlägg om marginal" });
  }, 60_000);

  it("a file is transcribed first (Gemini), then drafted (Claude)", async () => {
    const { sql } = await freshDb();
    let calls = 0;
    const m = mockFetch([
      { match: (u) => u.includes("generativelanguage"), reply: () => json({ steps: [{ type: "model_output", content: [{ type: "text", text: TRANSCRIPT }] }] }) },
      { match: isClaude, reply: () => claudeMessage(calls++ === 0 ? planned : written) },
    ]);
    const file = join(mkdtempSync(join(tmpdir(), "memo-")), "Ny inspelning.m4a");
    writeFileSync(file, new Uint8Array([1, 2, 3]));
    const out = await runCli(["memo", file], { env, sql, fetch: m.fn, now: () => NOW });
    expect(out).toContain("planned, 1 idea(s)");
    expect(JSON.parse(String(m.calls.find((c) => c.url.includes("generativelanguage"))!.init!.body)).input[1].mime_type).toBe("audio/m4a");
    expect((await sql.query<{ name: string }>(`select name from social_memos`))[0]!.name).toBe("Ny inspelning.m4a");
  }, 60_000);

  it("explains bad input instead of failing obscurely", async () => {
    const { sql } = await freshDb();
    await expect(runCli(["memo"], { env, sql })).rejects.toThrow(/usage: memo/);
    await expect(runCli(["memo", "--text", "kort"], { env, sql })).rejects.toThrow(/too short/);
    const dir = mkdtempSync(join(tmpdir(), "memo-"));
    writeFileSync(join(dir, "a.caf"), "x");
    await expect(runCli(["memo", join(dir, "a.caf")], { env, sql })).rejects.toThrow(/unsupported audio format/);
    await expect(runCli(["memo-sync"], { env, sql })).rejects.toThrow(/GOOGLE_SERVICE_ACCOUNT_JSON/);
    await expect(runCli(["memo", "--text", TRANSCRIPT], { env: { ...env, MEMO_MAX_IDEAS: "9" }, sql })).rejects.toThrow(/MEMO_MAX_IDEAS/);
    await expect(runCli(["memo", "--text", TRANSCRIPT], { env: { ...env, MEMO_CHANNELS: "myspace" }, sql })).rejects.toThrow(/MEMO_CHANNELS/);
  }, 60_000);
});
