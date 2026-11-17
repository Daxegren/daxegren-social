import { AdapterError, type FetchLike } from "./adapters/types.js";

export interface AudioInput {
  bytes: Uint8Array;
  /** MIME type as reported by the source; normalised with `audioMime`. */
  mimeType: string;
  name?: string;
}

/** Speech to text. Swap implementations without touching the engine. */
export interface Transcriber {
  /** The words that were spoken, in the spoken language. Empty when there was no speech. */
  transcribe(audio: AudioInput): Promise<string>;
}

/** Audio larger than this is not sent: the request limit is 20 MB in total and base64 adds a third. About 25 minutes. */
export const MAX_AUDIO_BYTES = 14 * 1024 * 1024;

/** The audio types Gemini accepts (Google's audio documentation, checked 2026-11-17). */
const SUPPORTED = new Set(["audio/wav", "audio/mp3", "audio/aiff", "audio/aac", "audio/ogg", "audio/flac", "audio/mpeg", "audio/m4a", "audio/l16", "audio/opus", "audio/alaw", "audio/mulaw", "audio/webm"]);
const ALIASES: Record<string, string> = {
  "audio/x-m4a": "audio/m4a",
  "audio/mp4": "audio/m4a",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/x-aac": "audio/aac",
  "audio/x-flac": "audio/flac",
  "audio/x-aiff": "audio/aiff",
  "audio/mp3": "audio/mp3",
};
const BY_EXTENSION: Record<string, string> = { m4a: "audio/m4a", mp3: "audio/mp3", wav: "audio/wav", aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg", flac: "audio/flac", opus: "audio/opus", webm: "audio/webm", aif: "audio/aiff", aiff: "audio/aiff" };

/** The MIME type to send, or undefined when the format is not one Gemini accepts (so it can be explained, not guessed). */
export function audioMime(mimeType: string, name?: string): string | undefined {
  const base = mimeType.split(";")[0]!.trim().toLowerCase();
  const mapped = ALIASES[base] ?? base;
  if (SUPPORTED.has(mapped)) return mapped;
  if (base === "" || base === "application/octet-stream") {
    const ext = /\.([A-Za-z0-9]+)$/.exec(name ?? "")?.[1]?.toLowerCase();
    return ext ? BY_EXTENSION[ext] : undefined;
  }
  return undefined;
}

export interface GeminiTranscriberConfig {
  /** Google AI Studio key. Use a billed project: on the free tier Google may use what you send to improve its products. */
  apiKey: string;
  /** Default `gemini-3.5-flash-lite`: audio costs the same as text there (0.30 USD per million input tokens). */
  model?: string;
  apiRevision?: string;
  fetch?: FetchLike;
  baseUrl?: string;
}

export const DEFAULT_TRANSCRIBE_MODEL = "gemini-3.5-flash-lite";
const NO_SPEECH = "[NO SPEECH]";

const PROMPT = `Transcribe this voice memo word for word.
- Write in the language that is spoken (usually Swedish). Do not translate.
- Remove only filler sounds (eh, öh, ehm, mm) and words repeated by accident. Keep everything else, numbers as spoken.
- Do not summarise, explain, correct or add anything. Do not label speakers or add timestamps.
- Use normal punctuation and paragraphs.
- If there is no speech, answer exactly: ${NO_SPEECH}`;

interface Block {
  type?: string;
  text?: string;
}
interface Step {
  type?: string;
  content?: Block[];
}

/**
 * Speech to text through the Gemini Interactions API, audio passed inline (documented at
 * ai.google.dev/gemini-api/docs/audio). Checked against that documentation, not yet against a live key.
 */
export class GeminiTranscriber implements Transcriber {
  private readonly fetchFn: FetchLike;
  readonly model: string;

  constructor(private readonly cfg: GeminiTranscriberConfig) {
    this.fetchFn = cfg.fetch ?? fetch;
    this.model = cfg.model ?? DEFAULT_TRANSCRIBE_MODEL;
  }

  async transcribe(audio: AudioInput): Promise<string> {
    const mime = audioMime(audio.mimeType, audio.name);
    if (!mime) throw new AdapterError(`${audio.mimeType || "this"} audio format is not supported; share the memo as m4a or mp3`, true);
    if (audio.bytes.length > MAX_AUDIO_BYTES) throw new AdapterError(`the recording is larger than ${MAX_AUDIO_BYTES / 1024 / 1024} MB (about 25 minutes); split it`, true);

    let res: Response;
    try {
      res = await this.fetchFn(`${this.cfg.baseUrl ?? "https://generativelanguage.googleapis.com"}/v1beta/interactions`, {
        method: "POST",
        headers: { "x-goog-api-key": this.cfg.apiKey, "Content-Type": "application/json", "Api-Revision": this.cfg.apiRevision ?? "2026-05-20" },
        body: JSON.stringify({
          model: this.model,
          input: [
            { type: "text", text: PROMPT },
            { type: "audio", data: Buffer.from(audio.bytes).toString("base64"), mime_type: mime },
          ],
        }),
      });
    } catch (err) {
      throw new AdapterError(`network error: ${this.scrub((err as Error).message)}`, false);
    }
    const text = await res.text();
    if (!res.ok) {
      const transient = res.status === 429 || res.status >= 500;
      throw new AdapterError(`Gemini ${res.status}: ${this.scrub(text.slice(0, 400))}`, !transient, res.status);
    }

    const body = JSON.parse(text) as { steps?: Step[] };
    const said = (body.steps ?? [])
      .filter((s) => s.type === "model_output")
      .flatMap((s) => s.content ?? [])
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text!)
      .join("\n")
      .trim();
    if (!said) throw new AdapterError("Gemini returned no text for the recording", true);
    return said === NO_SPEECH ? "" : said;
  }

  private scrub(text: string): string {
    return this.cfg.apiKey.length > 6 ? text.split(this.cfg.apiKey).join("[redacted]") : text;
  }
}
