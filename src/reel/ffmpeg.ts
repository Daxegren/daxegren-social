import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Brand } from "../carousel/render.js";
import { parseSilences, type CaptionChunk, type Silence } from "./align.js";
import { CAPTION_HEIGHT, CAPTION_Y, CARD_X, CARD_Y, HOOK_Y, REEL_HEIGHT, REEL_WIDTH, renderBlank, renderBlankCard, renderCaption, renderCard, renderHook } from "./captions.js";

const execFileAsync = promisify(execFile);

export interface ReelAudio {
  bytes: Uint8Array;
  mimeType: string;
  name?: string;
}

export interface ReelPhoto {
  bytes: Uint8Array;
}

/** A key point shown on screen while it is being said. Times are in the recording's own time. */
export interface ReelCard {
  start: number;
  end: number;
  title: string;
  body?: string;
}

export interface ReelInput {
  audio: ReelAudio;
  /** The stretch of the recording to use, in seconds. */
  start: number;
  end: number;
  hook: string;
  /** Caption times are in the recording's own time, not the Reel's. */
  captions: CaptionChunk[];
  /** Key-point cards shown above the captions while each point is spoken. */
  cards?: ReelCard[];
  /** Own photos shown in turn behind the captions. Without any, the Reel shows the sound wave. */
  photos: ReelPhoto[];
  brand: Brand;
}

/** Turns a recording into a vertical video. Swap implementations without touching the engine. */
export interface ReelRenderer {
  /** How long the recording is and where it is silent. */
  analyse(audio: ReelAudio): Promise<{ duration: number; silences: Silence[] }>;
  /** An MP4 (H.264 + AAC), 1080x1920. */
  render(input: ReelInput): Promise<Uint8Array>;
}

const EXTENSIONS: Record<string, string> = { "audio/m4a": "m4a", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/mp3": "mp3", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/aac": "aac", "audio/ogg": "ogg", "audio/flac": "flac", "audio/webm": "webm", "audio/opus": "opus" };
const FPS = 30;
const MIN_PHOTO_SECONDS = 3;

export class FfmpegReelRenderer implements ReelRenderer {
  constructor(private readonly opts: { ffmpeg?: string; ffprobe?: string; timeoutMs?: number } = {}) {}

  private async run(bin: "ffmpeg" | "ffprobe", args: string[]): Promise<{ stdout: string; stderr: string }> {
    const exe = bin === "ffmpeg" ? (this.opts.ffmpeg ?? "ffmpeg") : (this.opts.ffprobe ?? "ffprobe");
    try {
      return await execFileAsync(exe, args, { maxBuffer: 64 * 1024 * 1024, timeout: this.opts.timeoutMs ?? 10 * 60_000 });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      if (e.code === "ENOENT") throw new Error(`${exe} is not installed (the Reel renderer needs ffmpeg; in GitHub Actions: sudo apt-get install -y ffmpeg)`);
      throw new Error(`${exe} failed: ${(e.stderr ?? e.message).toString().trim().split("\n").slice(-6).join(" | ").slice(0, 600)}`);
    }
  }

  private async withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "reel-"));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async analyse(audio: ReelAudio): Promise<{ duration: number; silences: Silence[] }> {
    return this.withDir(async (dir) => {
      const file = join(dir, `in.${EXTENSIONS[audio.mimeType.split(";")[0]!.trim().toLowerCase()] ?? "m4a"}`);
      await writeFile(file, audio.bytes);
      const probe = await this.run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
      const duration = Number(probe.stdout.trim());
      if (!Number.isFinite(duration) || duration <= 0) throw new Error("could not read the length of the recording");
      const detect = await this.run("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", "silencedetect=noise=-32dB:d=0.18", "-f", "null", "-"]);
      return { duration, silences: parseSilences(detect.stderr, duration) };
    });
  }

  async render(input: ReelInput): Promise<Uint8Array> {
    const length = input.end - input.start;
    if (!(length > 0)) throw new Error("the Reel would be empty");
    return this.withDir(async (dir) => {
      const inFile = join(dir, `in.${EXTENSIONS[input.audio.mimeType.split(";")[0]!.trim().toLowerCase()] ?? "m4a"}`);
      await writeFile(inFile, input.audio.bytes);

      // 1. The sound: the chosen stretch, evened out (voice memos are often quiet), with a short fade at each end.
      const wav = join(dir, "voice.wav");
      await this.run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", input.start.toFixed(3), "-t", length.toFixed(3), "-i", inFile, "-vn", "-ac", "2", "-ar", "44100",
        "-af", `loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:d=0.08,afade=t=out:st=${Math.max(length - 0.25, 0).toFixed(3)}:d=0.25`, wav]);

      // 2. The captions and cards: one transparent picture each, shown for as long as they are spoken (concat lists with durations).
      const timeline = async (name: string, items: Array<{ start: number; end: number; draw: () => Promise<Uint8Array> }>, blankPng: Uint8Array): Promise<string> => {
        const blank = join(dir, `${name}-blank.png`);
        await writeFile(blank, blankPng);
        const lines: string[] = [];
        let cursor = 0;
        const push = (file: string, seconds: number) => {
          if (seconds > 0.001) lines.push(`file '${file}'`, `duration ${seconds.toFixed(3)}`);
        };
        const rel = items.map((c) => ({ ...c, start: Math.max(0, c.start - input.start), end: Math.min(length, c.end - input.start) })).filter((c) => c.end > c.start && c.start < length);
        for (const [i, c] of rel.entries()) {
          push(blank, c.start - cursor);
          const file = join(dir, `${name}-${i}.png`);
          await writeFile(file, await c.draw());
          const next = rel[i + 1]?.start;
          const until = Math.min(next !== undefined && next - c.start < 0.12 ? next : c.end + 0.08, next ?? length);
          push(file, until - c.start);
          cursor = until;
        }
        push(blank, length - cursor + 0.2);
        lines.push(`file '${blank}'`);
        const list = join(dir, `${name}.txt`);
        await writeFile(list, lines.join("\n"));
        return list;
      };
      const list = await timeline("cap", input.captions.map((c) => ({ start: c.start, end: c.end, draw: () => renderCaption(c.text, input.brand) })), await renderBlank());
      const cards = input.cards ?? [];
      const cardList = cards.length > 0 ? await timeline("card", cards.map((c) => ({ start: c.start, end: c.end, draw: () => renderCard(c.title, c.body, input.brand) })), await renderBlankCard()) : undefined;

      const hook = join(dir, "hook.png");
      await writeFile(hook, await renderHook(input.hook, input.brand));

      // 3. The picture behind: own photos in turn, slowly moving, or else the sound wave on the brand background.
      const inputs: string[] = [];
      const graph: string[] = [];
      let n = 0;
      let audioIndex: number;
      const photos = input.photos.slice(0, Math.max(1, Math.floor(length / MIN_PHOTO_SECONDS)));
      if (photos.length > 0) {
        const each = length / photos.length;
        for (const [i, p] of photos.entries()) {
          const file = join(dir, `photo-${i}.img`);
          await writeFile(file, p.bytes);
          inputs.push("-loop", "1", "-framerate", String(FPS), "-t", each.toFixed(3), "-i", file);
          graph.push(
            `[${n}:v]scale=${REEL_WIDTH * 1.25}:${REEL_HEIGHT * 1.25}:force_original_aspect_ratio=increase,crop=${REEL_WIDTH * 1.25}:${REEL_HEIGHT * 1.25},` +
              `zoompan=z='min(1+on*0.0005,1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${REEL_WIDTH}x${REEL_HEIGHT}:fps=${FPS},eq=brightness=-0.16,setsar=1[p${i}]`,
          );
          n++;
        }
        graph.push(`${photos.map((_, i) => `[p${i}]`).join("")}concat=n=${photos.length}:v=1:a=0[bg]`);
        audioIndex = n++;
        inputs.push("-i", wav);
      } else {
        inputs.push("-f", "lavfi", "-t", length.toFixed(3), "-i", `color=c=0x0B0F14:s=${REEL_WIDTH}x${REEL_HEIGHT}:r=${FPS}`);
        inputs.push("-i", wav);
        audioIndex = 1;
        n = 2;
        // The wave is drawn in white and tinted afterwards: asking showwaves for a colour mixes it with the background.
        const [r, g, b] = [1, 3, 5].map((i) => (parseInt(input.brand.accent.slice(i, i + 2), 16) / 255).toFixed(3));
        const waveHeight = cards.length > 0 ? 260 : 460;
        graph.push(
          `[${audioIndex}:a]volume=2.5,showwaves=s=${REEL_WIDTH}x${waveHeight}:mode=cline:rate=${FPS}:colors=white:scale=sqrt,format=rgba,colorchannelmixer=rr=${r}:gg=${g}:bb=${b}[wave]`,
          `[0:v][wave]overlay=0:${cards.length > 0 ? 1560 : 620}:format=auto[bg]`,
        );
      }
      const capIndex = n;
      inputs.push("-f", "concat", "-safe", "0", "-i", list);
      let next = n + 1;
      let cardIndex: number | undefined;
      if (cardList) {
        cardIndex = next++;
        inputs.push("-f", "concat", "-safe", "0", "-i", cardList);
      }
      const hookIndex = next;
      inputs.push("-loop", "1", "-framerate", String(FPS), "-i", hook);
      graph.push(`[${capIndex}:v]format=rgba,fps=${FPS}[cap]`, `[bg][cap]overlay=0:${CAPTION_Y}:format=auto[v0]`);
      if (cardIndex !== undefined) graph.push(`[${cardIndex}:v]format=rgba,fps=${FPS}[cd]`, `[v0][cd]overlay=${CARD_X}:${CARD_Y}:format=auto[v1]`);
      else graph.push(`[v0]null[v1]`);
      graph.push(`[${hookIndex}:v]format=rgba[hk]`, `[v1][hk]overlay=0:${HOOK_Y}:format=auto,format=yuv420p[v]`);

      const out = join(dir, "reel.mp4");
      await this.run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", graph.join(";"), "-map", "[v]", "-map", `${audioIndex}:a`,
        "-t", length.toFixed(3), "-r", String(FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-profile:v", "high", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out]);
      return new Uint8Array(await readFile(out));
    });
  }
}

export { CAPTION_HEIGHT };
