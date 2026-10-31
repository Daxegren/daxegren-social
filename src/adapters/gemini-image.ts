import { type GeneratedImage, type ImageGenerator, type ImageRequest, type MediaCost } from "../media.js";
import { AdapterError, type FetchLike } from "./types.js";

export interface GeminiImageConfig {
  /** API key from Google AI Studio (not a consumer Gemini subscription). */
  apiKey: string;
  /** Default `gemini-2.5-flash-image`. Check Google's current model list. */
  model?: string;
  /** Flat per-image estimate in USD. Default 0.04 — verify against Google's current price list. */
  costPerImageUsd?: number;
  fetch?: FetchLike;
  baseUrl?: string;
}

interface Part {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  inline_data?: { mime_type?: string; data?: string };
}

/**
 * Image generation and editing through the Gemini API (`generateContent`).
 * NOTE: written from memory of the REST API and not yet confirmed against a live key — run the
 * "Generate image" workflow once and read the result before relying on it.
 */
export class GeminiImageGenerator implements ImageGenerator {
  readonly provider = "gemini";
  readonly model: string;
  private readonly fetchFn: FetchLike;

  constructor(private readonly cfg: GeminiImageConfig) {
    this.model = cfg.model ?? "gemini-2.5-flash-image";
    this.fetchFn = cfg.fetch ?? fetch;
  }

  async estimate(): Promise<MediaCost> {
    return { usd: this.cfg.costPerImageUsd ?? 0.04, isEstimate: true, source: "flat estimate per image" };
  }

  async generate(req: ImageRequest): Promise<GeneratedImage> {
    const parts: unknown[] = [{ text: req.prompt }];
    if (req.reference) parts.push({ inline_data: { mime_type: req.reference.mimeType, data: toBase64(req.reference.bytes) } });

    let res: Response;
    try {
      res = await this.fetchFn(`${this.cfg.baseUrl ?? "https://generativelanguage.googleapis.com"}/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": this.cfg.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: req.aspect } },
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

    const body = JSON.parse(text) as {
      candidates?: Array<{ content?: { parts?: Part[] }; finishReason?: string }>;
      promptFeedback?: { blockReason?: string };
    };
    const candidate = body.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      const data = part.inlineData?.data ?? part.inline_data?.data;
      if (data) return { bytes: fromBase64(data), mimeType: part.inlineData?.mimeType ?? part.inline_data?.mime_type ?? "image/png" };
    }
    const why = body.promptFeedback?.blockReason ?? candidate?.finishReason ?? "no image in the response";
    // A blocked or empty answer will not improve by retrying the same request.
    throw new AdapterError(`Gemini returned no image (${why})`, true);
  }

  /** The key travels in a header, but keep it out of any message regardless. */
  private scrub(text: string): string {
    return this.cfg.apiKey.length > 6 ? text.split(this.cfg.apiKey).join("[redacted]") : text;
  }
}

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const fromBase64 = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));
