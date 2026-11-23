import type { TranscriptSegment } from "../domain.js";

export interface Silence {
  start: number;
  end: number;
}

/** Reads the `silence_start` / `silence_end` lines ffmpeg's silencedetect filter prints. */
export function parseSilences(log: string, duration: number): Silence[] {
  const out: Silence[] = [];
  let open: number | undefined;
  for (const line of log.split("\n")) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) open = Math.max(0, Number(s[1]));
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (e && open !== undefined) {
      out.push({ start: open, end: Number(e[1]) });
      open = undefined;
    }
  }
  if (open !== undefined && open < duration) out.push({ start: open, end: duration });
  return out;
}

/**
 * The model's timestamps are approximate (whole seconds, from a language model, not an alignment tool), but people
 * pause between sentences. Where a segment begins, look for a pause close by and use it: the previous segment ends when
 * the pause starts and this one begins when it ends. Without a pause nearby the model's time is kept.
 */
export function snapSegments(segments: TranscriptSegment[], silences: Silence[], duration: number, maxShift = 1.5): TranscriptSegment[] {
  const out = segments.map((s) => ({ ...s, start: Math.min(s.start, duration), end: Math.min(s.end, duration) }));
  for (let i = 1; i < out.length; i++) {
    const boundary = out[i]!.start;
    let best: Silence | undefined;
    let bestDistance = Infinity;
    for (const s of silences) {
      const distance = boundary < s.start ? s.start - boundary : boundary > s.end ? boundary - s.end : 0;
      // The pause must leave the previous segment some speech and must not swallow this one.
      if (distance <= maxShift && distance < bestDistance && s.start > out[i - 1]!.start + 0.3 && s.end < (segments[i + 1]?.start ?? duration) - 0.2) {
        best = s;
        bestDistance = distance;
      }
    }
    if (best) {
      out[i - 1]!.end = best.start;
      out[i]!.start = best.end;
    } else {
      out[i - 1]!.end = boundary;
    }
  }
  const first = silences.find((s) => s.start <= 0.05 && s.end < (out[1]?.start ?? duration));
  if (first && out[0]) out[0].start = first.end;
  const last = out.at(-1);
  if (last) {
    const tail = silences.find((s) => s.end >= duration - 0.05 && s.start > last.start + 0.3);
    last.end = Math.min(tail ? tail.start : last.end, duration);
  }
  return out.filter((s) => s.end > s.start);
}

export interface CaptionChunk {
  start: number;
  end: number;
  text: string;
}

const PAUSE = /[.!?,;:–—]$/;

/**
 * Splits speech into short captions (a few words each) and spreads the words over each segment's time in proportion to
 * their length, with a little extra after punctuation. Approximate: it is meant to look right, not to be frame exact.
 */
export function captionChunks(segments: TranscriptSegment[], maxWords = 3, maxChars = 26): CaptionChunk[] {
  const out: CaptionChunk[] = [];
  for (const seg of segments) {
    const words = seg.text.split(/\s+/).filter(Boolean);
    if (words.length === 0 || seg.end <= seg.start) continue;
    const weights = words.map((w) => w.length + 2 + (PAUSE.test(w) ? 3 : 0));
    const total = weights.reduce((a, b) => a + b, 0);
    const chunks: Array<{ from: number; to: number }> = [];
    let from = 0;
    for (let i = 0; i < words.length; i++) {
      const length = words.slice(from, i + 1).join(" ").length;
      const full = i + 1 - from >= maxWords || length >= maxChars;
      const natural = PAUSE.test(words[i]!) && i + 1 - from >= 2;
      if (full || natural || i === words.length - 1) {
        chunks.push({ from, to: i + 1 });
        from = i + 1;
      }
    }
    let done = 0;
    for (const c of chunks) {
      const w = weights.slice(c.from, c.to).reduce((a, b) => a + b, 0);
      out.push({ start: seg.start + (done / total) * (seg.end - seg.start), end: seg.start + ((done + w) / total) * (seg.end - seg.start), text: words.slice(c.from, c.to).join(" ") });
      done += w;
    }
  }
  return out;
}

export interface ReelCut {
  /** First and last segment used (0-based, inclusive). */
  from: number;
  to: number;
  /** Where to cut the recording, in seconds. */
  start: number;
  end: number;
  segments: TranscriptSegment[];
}

export const MIN_REEL_SECONDS = 8;

/**
 * The stretch of the recording a Reel uses. `from` and `to` are the planner's 1-based segment numbers. A stretch longer
 * than the limit loses whole segments from its end; one that is too short, or out of range, is refused (undefined).
 */
export function reelCut(segments: TranscriptSegment[], from: number, to: number, maxSeconds: number, duration: number): ReelCut | undefined {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > segments.length) return undefined;
  let last = to - 1;
  const pad = { before: 0.15, after: 0.3 };
  const bounds = (a: number, b: number) => ({ start: Math.max(0, segments[a]!.start - pad.before), end: Math.min(duration, segments[b]!.end + pad.after) });
  while (last > from - 1 && bounds(from - 1, last).end - bounds(from - 1, last).start > maxSeconds) last--;
  const { start, end } = bounds(from - 1, last);
  if (end - start > maxSeconds || end - start < MIN_REEL_SECONDS) return undefined;
  return { from: from - 1, to: last, start, end, segments: segments.slice(from - 1, last + 1) };
}
