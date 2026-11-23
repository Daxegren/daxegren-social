import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AdapterError } from "../src/adapters/types.js";
import type { Memo, TranscriptSegment } from "../src/domain.js";
import { ContentEngine, type EngineConfig } from "../src/engine.js";
import { parseIdeas, type MemoIdea, type MemoPlanner } from "../src/memo.js";
import { captionChunks, parseSilences, reelCut, snapSegments } from "../src/reel/align.js";
import { highlightIndex } from "../src/reel/captions.js";
import { FfmpegReelRenderer, type ReelInput, type ReelRenderer } from "../src/reel/ffmpeg.js";
import { MemoryStore } from "../src/store.js";
import { GeminiTranscriber, parseTimedTranscript, parseTimestamp, type Transcriber } from "../src/transcribe.js";
import { runDoctor } from "../src/worker/doctor.js";
import { FakeAdapter, FakeGenerator, json, MemoryStorage, mockFetch } from "./helpers.js";
import { freshDb } from "./pg.js";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const seg = (start: number, end: number, text = "ord ord ord"): TranscriptSegment => ({ start, end, text });

describe("timestamps and timed transcripts", () => {
  it("reads the time formats a model produces", () => {
    expect(parseTimestamp("1:05.5")).toBe(65.5);
    expect(parseTimestamp("00:07")).toBe(7);
    expect(parseTimestamp("1:02:03")).toBe(3723);
    expect(parseTimestamp(12.5)).toBe(12.5);
    expect(parseTimestamp("snart")).toBeUndefined();
    expect(parseTimestamp("-3")).toBeUndefined();
    expect(parseTimestamp(undefined)).toBeUndefined();
  });

  it("builds segments that end where the next begins, drops ones that go backwards or are empty, and joins the text", () => {
    const t = parseTimedTranscript(JSON.stringify({ segments: [{ start: "0:00.0", text: "Hej" }, { start: "0:06.5", text: "  det här  " }, { start: "0:03", text: "bakåt" }, { start: "0:09", text: "" }, { start: "0:12", text: "slut" }] }))!;
    expect(t.segments).toEqual([seg(0, 6.5, "Hej"), seg(6.5, 12, "det här"), { start: 12, end: 14, text: "slut" }]);
    expect(t.text).toBe("Hej det här slut");
    expect(parseTimedTranscript("nej")).toBeUndefined();
    expect(parseTimedTranscript('{"segments":[]}')).toBeUndefined();
  });

  it("GeminiTranscriber asks for timings with a JSON schema, and falls back to the plain transcript when the answer is not usable", async () => {
    const out = (text: string) => json({ steps: [{ type: "model_output", content: [{ type: "text", text }] }] });
    let calls = 0;
    const m = mockFetch([{ match: (u) => u.includes("interactions"), reply: () => out(calls++ === 0 ? '{"segments":[{"start":"0:00.0","text":"Hej"},{"start":"0:04.0","text":"där"}]}' : calls === 2 ? "inte json" : "Hej där") }]);
    const t = new GeminiTranscriber({ apiKey: "gem-key-123456", fetch: m.fn });
    const audio = { bytes: new Uint8Array([1, 2]), mimeType: "audio/mp4", name: "a.m4a" };

    expect((await t.transcribeDetailed(audio)).segments).toHaveLength(2);
    const body = JSON.parse(String(m.calls[0]!.init!.body));
    expect(body.response_format).toMatchObject({ type: "text", mime_type: "application/json", schema: { required: ["segments"] } });
    expect(body.input[0].text).toMatch(/MM:SS\.s/);

    expect(await t.transcribeDetailed(audio)).toEqual({ text: "Hej där", segments: [] });
    expect(m.calls).toHaveLength(3);
  });
});

describe("alignment", () => {
  it("reads silences from ffmpeg's log", () => {
    const log = "[silencedetect @ 0x1] silence_start: 0\n[silencedetect @ 0x1] silence_end: 0.52 | silence_duration: 0.52\n[silencedetect @ 0x1] silence_start: 8.1\n[silencedetect @ 0x1] silence_end: 8.7 | silence_duration: 0.6\n[silencedetect @ 0x1] silence_start: 19.5";
    expect(parseSilences(log, 20)).toEqual([{ start: 0, end: 0.52 }, { start: 8.1, end: 8.7 }, { start: 19.5, end: 20 }]);
  });

  it("moves a segment boundary onto a pause close by, and leaves it alone when there is none", () => {
    const segments = [seg(0, 9), seg(9, 18), seg(18, 25)];
    const out = snapSegments(segments, [{ start: 0, end: 0.4 }, { start: 8.1, end: 8.7 }, { start: 24.5, end: 25 }], 25);
    expect(out.map((s) => [s.start, s.end])).toEqual([[0.4, 8.1], [8.7, 18], [18, 24.5]]);
    expect(snapSegments(segments, [{ start: 12, end: 12.4 }], 25).map((s) => s.start)).toEqual([0, 9, 18]);
  });

  it("does not let a pause swallow a whole segment or move a boundary backwards", () => {
    const out = snapSegments([seg(0, 1), seg(1, 2), seg(2, 10)], [{ start: 0.1, end: 1.9 }], 10);
    expect(out.every((s) => s.end > s.start)).toBe(true);
    expect(out.map((s) => s.start)).toEqual([...out.map((s) => s.start)].sort((a, b) => a - b));
  });

  it("splits speech into short captions and spreads their times over the segment, longer words taking longer", () => {
    const caps = captionChunks([{ start: 10, end: 16, text: "Det här är en mening, och sedan kommer en till." }]);
    expect(caps.map((c) => c.text)).toEqual(["Det här är", "en mening,", "och sedan kommer", "en till."]);
    expect(caps[0]!.start).toBe(10);
    expect(caps.at(-1)!.end).toBeCloseTo(16, 5);
    for (let i = 1; i < caps.length; i++) expect(caps[i]!.start).toBeCloseTo(caps[i - 1]!.end, 5);
    expect(captionChunks([seg(3, 3, "x"), seg(0, 5, "   ")])).toEqual([]);
  });

  it("cuts the stretch a Reel uses, with a little air around it, shortening one that is too long and refusing one that is not usable", () => {
    const segments = [seg(0, 10), seg(10, 25), seg(25, 45), seg(45, 90)];
    expect(reelCut(segments, 2, 3, 60, 100)).toMatchObject({ from: 1, to: 2, start: 9.85, end: 45.3 });
    const shortened = reelCut(segments, 2, 4, 60, 100)!;
    expect(shortened.to).toBe(2); // the last segment would have made it 80 s
    expect(shortened.segments).toHaveLength(2);
    expect(reelCut(segments, 1, 1, 60, 100)).toMatchObject({ from: 0, to: 0, end: 10.3 }); // 10 s is long enough
  });

  it("refuses a stretch under the minimum, a single segment over the maximum, and numbers that do not exist", () => {
    const segments = [seg(0, 3), seg(3, 100)];
    expect(reelCut(segments, 1, 1, 60, 100)).toBeUndefined();
    expect(reelCut(segments, 2, 2, 60, 100)).toBeUndefined();
    expect(reelCut(segments, 0, 1, 60, 100)).toBeUndefined();
    expect(reelCut(segments, 2, 5, 60, 100)).toBeUndefined();
    expect(reelCut(segments, 1.5, 2, 60, 100)).toBeUndefined();
  });

  it("highlights the longest word of a caption, if it is long enough to matter", () => {
    expect(highlightIndex(["Det", "här", "marginalen"])).toBe(2);
    expect(highlightIndex(["Det", "är", "en"])).toBe(-1);
  });
});

describe("parseIdeas: reels", () => {
  const reel = { title: "R", idea: "Det han sa", format: "reel", hook: "  Marginal slår omsättning  ", from: 2, to: 4, cards: [{ at: 4, title: "Fyra", body: "b" }, { at: 2, title: "Två" }, { at: 9, title: "Utanför" }, { at: 2, title: "Dubblett" }, { at: 3, title: "" }] };
  const raw = (i: unknown) => JSON.stringify({ ideas: [i] });

  it("keeps a reel with its headline, its stretch and its cards inside that stretch, in order", () => {
    const [idea] = parseIdeas(raw(reel), 3, { segmentCount: 6 });
    expect(idea).toMatchObject({ format: "reel", hook: "Marginal slår omsättning", from: 2, to: 4 });
    expect(idea!.cards).toEqual([{ at: 2, title: "Två", body: undefined }, { at: 4, title: "Fyra", body: "b" }]);
  });

  it("turns a reel into an ordinary post when it cannot be made: reels not available, no headline, or a stretch that does not exist", () => {
    for (const [i, reels] of [[reel, undefined], [{ ...reel, hook: " " }, { segmentCount: 6 }], [{ ...reel, to: 9 }, { segmentCount: 6 }], [{ ...reel, from: 5, to: 2 }, { segmentCount: 6 }], [{ ...reel, from: 1.5 }, { segmentCount: 6 }]] as const) {
      const [idea] = parseIdeas(raw(i), 3, reels);
      expect(idea).toMatchObject({ format: "post", idea: "Det han sa" });
      expect(idea!.hook).toBeUndefined();
    }
  });
});

class FakeRenderer implements ReelRenderer {
  analysed = 0;
  rendered: ReelInput[] = [];
  silences = [{ start: 9.8, end: 10.2 }, { start: 24.6, end: 25.2 }];
  error?: Error;
  async analyse() {
    this.analysed++;
    return { duration: 90, silences: this.silences };
  }
  async render(input: ReelInput) {
    if (this.error) throw this.error;
    this.rendered.push(input);
    return new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
  }
}
class FakePlanner implements MemoPlanner {
  inputs: Parameters<MemoPlanner["plan"]>[0][] = [];
  constructor(private readonly ideas: MemoIdea[]) {}
  async plan(input: Parameters<MemoPlanner["plan"]>[0]) {
    this.inputs.push(input);
    return this.ideas;
  }
}
const SEGMENTS = [seg(0, 10, "Jag börjar med en fråga."), seg(10, 25, "Det är marginalen per produkt som avgör."), seg(25, 45, "Jag räknade på mina egna produkter."), seg(45, 90, "Hälften gav nästan ingenting.")];
const REEL: MemoIdea = { title: "Marginal", idea: "Marginalen avgör", format: "reel", hook: "Marginal slår omsättning", from: 2, to: 3, cards: [{ at: 2, title: "Marginalen avgör" }, { at: 3, title: "Räkna per produkt", body: "Inte i snitt" }] };

function setup(over: Partial<EngineConfig> = {}, ideas: MemoIdea[] = [REEL]) {
  const store = new MemoryStore();
  const renderer = new FakeRenderer();
  const storage = new MemoryStorage();
  const planner = new FakePlanner(ideas);
  const audio = { bytes: new Uint8Array([9, 9, 9]), mimeType: "audio/m4a", name: "Ny inspelning.m4a" };
  const engine = new ContentEngine({
    store,
    adapters: { linkedin: new FakeAdapter("linkedin"), instagram: new FakeAdapter("instagram") },
    generator: new FakeGenerator(),
    memoPlanner: planner,
    reelRenderer: renderer,
    mediaStorage: storage,
    memoAudio: async () => audio,
    brand: { handle: "@david", accent: "#112233", theme: "dark" },
    now: () => new Date("2026-11-23T10:00:00Z"),
    ...over,
  });
  const memo = async (over: Partial<Memo> = {}) => {
    const m: Memo = { id: crypto.randomUUID(), source: "drive", driveFileId: "d1", name: "Ny inspelning.m4a", transcript: SEGMENTS.map((s) => s.text).join(" "), segments: SEGMENTS, status: "transcribed", attempts: 0, ideaCount: 0, createdAt: "2026-11-23T09:00:00Z", ...over };
    await store.putMemo(m);
    return m;
  };
  return { store, renderer, storage, planner, engine, memo };
}

describe("Reels in the engine", () => {
  it("cuts the chosen stretch at the pauses, times captions and cards, stores the video and drafts a caption per channel that takes video", async () => {
    const { engine, store, renderer, storage, planner, memo } = setup();
    const m = await memo();
    const res = await engine.processMemos();

    expect(res).toMatchObject({ planned: [m.id], drafts: 2 });
    expect(planner.inputs[0]).toMatchObject({ allowReels: true, maxReelSeconds: 60, segments: SEGMENTS });
    const input = renderer.rendered[0]!;
    expect(input.hook).toBe("Marginal slår omsättning");
    expect(input.start).toBeCloseTo(10.2 - 0.15, 5); // segment 2 begins when the pause ends
    expect(input.end).toBeCloseTo(45 + 0.3, 5);
    expect(input.captions[0]!.start).toBeCloseTo(10.2, 5);
    expect(input.cards).toEqual([{ start: 10.2, end: 25.2, title: "Marginalen avgör", body: undefined }, { start: 25.2, end: input.end, title: "Räkna per produkt", body: "Inte i snitt" }]);
    expect(input.brand.accent).toBe("#112233");

    const [video] = [...storage.files.entries()];
    expect(video![0]).toMatch(/^reels\/[0-9a-f-]{36}\/[0-9a-f]{8}\.mp4$/);
    expect(video![1].mimeType).toBe("video/mp4");
    const variants = await store.listVariants();
    expect(variants.map((v) => v.channel).sort()).toEqual(["instagram", "linkedin"]);
    const [asset] = await store.getAssets(variants[0]!.assetIds);
    expect(asset).toMatchObject({ kind: "video", origin: "generated", meta: { source: "reel", memoId: m.id, seconds: 35, from: 2, to: 3 } });
    expect(variants[0]!.assetIds).toEqual(variants[1]!.assetIds);
    expect((await store.listBriefs())[0]).toMatchObject({ format: "reel", memoId: m.id });
  });

  it("only offers Reels when it can make them: a renderer, storage, a timed transcript and the recording", async () => {
    for (const over of [{ reelRenderer: undefined }, { mediaStorage: undefined }, { memoAudio: undefined }] as Array<Partial<EngineConfig>>) {
      const { engine, planner, memo, store } = setup(over, [{ ...REEL, format: "post" }]);
      await memo();
      await engine.processMemos();
      expect(planner.inputs[0]).toMatchObject({ allowReels: false, segments: undefined });
      expect((await store.listBriefs())[0]!.format).toBe("post");
    }
    const noSegments = setup({}, [{ ...REEL, format: "post" }]);
    await noSegments.memo({ segments: undefined });
    await noSegments.engine.processMemos();
    expect(noSegments.planner.inputs[0]!.allowReels).toBe(false);
  });

  it("a Reel that cannot be made becomes an ordinary post of the same idea, with a note saying why", async () => {
    const { engine, store, renderer, memo } = setup();
    renderer.error = new Error("ffmpeg is not installed");
    const m = await memo();
    await engine.processMemos();
    const after = await store.getMemo(m.id);
    expect(after).toMatchObject({ status: "planned", ideaCount: 1 });
    expect(after!.error).toContain("Reel kunde inte skapas (ffmpeg is not installed)");
    expect((await store.listBriefs())[0]!.format).toBe("post");
    expect((await store.listVariants()).every((v) => v.assetIds.length === 0)).toBe(true);
  });

  it("falls back to a post when the recording is gone, when the stretch is unusable, and when no channel takes video", async () => {
    const gone = setup({ memoAudio: async () => undefined });
    await gone.memo();
    await gone.engine.processMemos();
    expect((await gone.store.listMemos())[0]!.error).toContain("no longer available");
    expect((await gone.store.listBriefs())[0]!.format).toBe("post");

    const short = setup({}, [{ ...REEL, from: 1, to: 1 }]);
    await short.memo({ segments: [seg(0, 3), seg(3, 25), ...SEGMENTS.slice(2)] });
    await short.engine.processMemos();
    expect((await short.store.listMemos())[0]!.error).toContain("too short or too long");
    expect((await short.store.listBriefs())[0]!.format).toBe("post");
  });

  it("keeps the recording in memory for the run that transcribed it, so a Reel needs no second fetch", async () => {
    let fetched = 0;
    const transcriber: Transcriber = {
      transcribe: async () => "text",
      transcribeDetailed: async () => ({ text: SEGMENTS.map((s) => s.text).join(" "), segments: SEGMENTS }),
    };
    const { engine, store, renderer } = setup({ transcriber, memoAudio: async () => void fetched++ as never });
    const m = await engine.addMemoFromAudio({ name: "Ny inspelning.m4a", bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/mp4", driveFileId: "d9" });
    expect(m.segments).toEqual(SEGMENTS);
    expect((await store.getMemo(m.id))!.segments).toEqual(SEGMENTS);
    await engine.processMemos();
    expect(fetched).toBe(0);
    expect(renderer.rendered).toHaveLength(1);
  });

  it("uses plain transcription when no Reels can be made, and refuses to pay for a bad format twice", async () => {
    let detailed = 0;
    const transcriber: Transcriber = { transcribe: async () => "enkel text", transcribeDetailed: async () => (detailed++, { text: "x", segments: [] }) };
    const { engine } = setup({ transcriber, reelRenderer: undefined });
    expect((await engine.addMemoFromAudio({ name: "a.m4a", bytes: new Uint8Array([1]), mimeType: "audio/m4a" })).transcript).toBe("enkel text");
    expect(detailed).toBe(0);
    const failing: Transcriber = { transcribe: async () => "x", transcribeDetailed: async () => { throw new AdapterError("not supported", true); } };
    const { engine: e2 } = setup({ transcriber: failing });
    expect((await e2.addMemoFromAudio({ name: "a.caf", bytes: new Uint8Array([1]), mimeType: "audio/x-caf" })).status).toBe("failed");
  });
});

describe("doctor: ffmpeg", () => {
  it("reports whether ffmpeg is there, and skips when Reels are switched off", async () => {
    const { sql } = await freshDb();
    const found = (await runDoctor({ env: {}, sql })).find((c) => c.name === "ffmpeg")!;
    expect(found.status).toBe(hasFfmpeg ? "ok" : "warn");
    expect((await runDoctor({ env: { MEMO_REELS: "false" }, sql })).find((c) => c.name === "ffmpeg")!.status).toBe("skip");
  }, 30_000);
});

describe.skipIf(!hasFfmpeg)("FfmpegReelRenderer (real ffmpeg)", () => {
  /** A test recording: tone bursts with pauses between them, so there is something to measure. */
  const makeAudio = () => {
    const dir = mkdtempSync(join(tmpdir(), "reel-test-"));
    const file = join(dir, "memo.wav");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=300:duration=4", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=1", "-f", "lavfi", "-i", "sine=frequency=500:duration=4", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=1", "-f", "lavfi", "-i", "sine=frequency=400:duration=4",
      "-filter_complex", "[0:a][1:a][2:a][3:a][4:a]concat=n=5:v=0:a=1,aformat=sample_rates=44100:channel_layouts=mono", file]);
    return new Uint8Array(readFileSync(file));
  };
  const probe = (bytes: Uint8Array) => {
    const file = join(mkdtempSync(join(tmpdir(), "reel-out-")), "out.mp4");
    writeFileSync(file, bytes);
    return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height,pix_fmt:format=duration", "-of", "json", file]).toString()) as { streams: Array<Record<string, string>>; format: { duration: string } };
  };
  const brand = { handle: "@david", accent: "#4F8CFF", theme: "dark" as const };
  const captions = [{ start: 0.5, end: 2, text: "Det här är" }, { start: 2, end: 3.8, text: "marginalen" }, { start: 5.2, end: 8, text: "och sedan mer" }];

  it("finds the pauses in a recording", async () => {
    const a = await new FfmpegReelRenderer().analyse({ bytes: makeAudio(), mimeType: "audio/wav" });
    expect(a.duration).toBeCloseTo(14, 0);
    expect(a.silences.map((s) => [Math.round(s.start), Math.round(s.end)])).toEqual([[4, 5], [9, 10]]);
  }, 60_000);

  it("draws a 1080x1920 H.264 + AAC video of the chosen stretch: sound wave and cards, then with photos", async () => {
    const renderer = new FfmpegReelRenderer();
    const audio = { bytes: makeAudio(), mimeType: "audio/wav" };
    const wave = await renderer.render({ audio, start: 0, end: 9, hook: "Marginal slår omsättning", captions, cards: [{ start: 0, end: 5, title: "Marginalen avgör", body: "Per produkt" }], photos: [], brand });
    const w = probe(wave);
    expect(w.streams.map((s) => s.codec_name).sort()).toEqual(["aac", "h264"]);
    expect(w.streams.find((s) => s.codec_name === "h264")).toMatchObject({ width: 1080, height: 1920, pix_fmt: "yuv420p" });
    expect(Number(w.format.duration)).toBeCloseTo(9, 0);

    const { default: jpeg } = await import("jpeg-js");
    const photo = new Uint8Array(jpeg.encode({ data: Buffer.alloc(64 * 80 * 4, 150), width: 64, height: 80 }, 80).data);
    const photos = await renderer.render({ audio, start: 1, end: 8, hook: "Hej", captions, photos: [{ bytes: photo }, { bytes: photo }], brand });
    expect(Number(probe(photos).format.duration)).toBeCloseTo(7, 0);
  }, 180_000);

  it("explains a missing ffmpeg and refuses an empty Reel", async () => {
    await expect(new FfmpegReelRenderer({ ffprobe: "ffprobe-finns-inte" }).analyse({ bytes: makeAudio(), mimeType: "audio/wav" })).rejects.toThrow(/ffprobe-finns-inte is not installed/);
    await expect(new FfmpegReelRenderer().render({ audio: { bytes: makeAudio(), mimeType: "audio/wav" }, start: 5, end: 5, hook: "x", captions: [], photos: [], brand })).rejects.toThrow(/empty/);
  }, 60_000);
});
