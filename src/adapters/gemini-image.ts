import { type GeneratedImage, type ImageGenerator, type ImageRequest, type MediaCost } from "../media.js";
import { AdapterError, type FetchLike } from "./types.js";

export interface GeminiImageConfig {
  /** API key from Google AI Studio on a billed project (the free tier does not include image generation). */
  apiKey: string;
  /** Default `gemini-nano-banana-2.1`, Google's recommended image model. See the model list in Google's docs. */
  model?: string;
  /** Flat per-image estimate in USD. Default 0.04; Google's price for a 1K image is 0.0336 plus input tokens. */
  costPerImageUsd?: number;
  /** Value of the `Api-Revision` header the Interactions API expects. */
  apiRevision?: string;
  fetch?: FetchLike;
  baseUrl?: string;
}

interface Block {
  type?: string;
  text?: string;
  data?: string;
  mime_type?: string;
}
interface Step {
  type?: string;
  content?: Block[];
}

export const DEFAULT_GEMINI_IMAGE_MODEL = "gemini-nano-banana-2.1";
export const DEFAULT_GEMINI_API_REVISION = "2026-05-20";

/**
 * Image generation and editing through the Gemini Interactions API
 * (`POST /v1beta/interactions`, as documented at aistudio.google.com/docs/image-generation).
 * Checked against that documentation, not yet against a live key: run the "Generate image" workflow once.
 *
 * Images are requested as JPEG at 1K: Instagram only accepts JPEG, and 1K keeps the price predictable.
 */
export class GeminiImageGenerator implements ImageGenerator {
  readonly provider = "gemini";
  readonly model: string;
  private readonly fetchFn: FetchLike;

  constructor(private readonly cfg: GeminiImageConfig) {
    this.model = cfg.model ?? DEFAULT_GEMINI_IMAGE_MODEL;
    this.fetchFn = cfg.fetch ?? fetch;
  }

  async estimate(): Promise<MediaCost> {
    return { usd: this.cfg.costPerImageUsd ?? 0.04, isEstimate: true, source: "flat estimate per 1K image" };
  }

  async generate(req: ImageRequest): Promise<GeneratedImage> {
    const input: unknown[] = [{ type: "text", text: req.prompt }];
    if (req.reference) input.push({ type: "image", mime_type: req.reference.mimeType, data: toBase64(req.reference.bytes) });

    let res: Response;
    try {
      res = await this.fetchFn(`${this.cfg.baseUrl ?? "https://generativelanguage.googleapis.com"}/v1beta/interactions`, {
        method: "POST",
        headers: {
          "x-goog-api-key": this.cfg.apiKey,
          "Content-Type": "application/json",
          "Api-Revision": this.cfg.apiRevision ?? DEFAULT_GEMINI_API_REVISION,
        },
        body: JSON.stringify({
          model: this.model,
          input,
          response_format: { type: "image", mime_type: "image/jpeg", aspect_ratio: req.aspect, image_size: "1K" },
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
    // Like the SDK's `output_image`: the last image block of the model's output. Other steps (thoughts, tool use) are skipped.
    const blocks = (body.steps ?? []).filter((s) => s.type === "model_output").flatMap((s) => s.content ?? []);
    const image = [...blocks].reverse().find((b) => b.type === "image" && b.data);
    if (image?.data) return { bytes: fromBase64(image.data), mimeType: image.mime_type ?? "image/jpeg" };

    const said = blocks.find((b) => b.type === "text" && b.text)?.text;
    // An answer without an image will not improve by retrying the same request.
    throw new AdapterError(`Gemini returned no image${said ? `: ${this.scrub(said.slice(0, 200))}` : ""}`, true);
  }

  /** The key travels in a header, but keep it out of any message regardless. */
  private scrub(text: string): string {
    return this.cfg.apiKey.length > 6 ? text.split(this.cfg.apiKey).join("[redacted]") : text;
  }
}

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const fromBase64 = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));
