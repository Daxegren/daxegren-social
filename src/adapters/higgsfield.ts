import { findVideoModel, type MediaCost, type VideoGenerator, type VideoJobState, type VideoRequest } from "../media.js";
import { AdapterError, type FetchLike } from "./types.js";

const BASE = "https://api.higgsfield.ai";

export interface HiggsfieldConfig {
  /** `KEY_ID:KEY_SECRET` */
  apiKey: string;
  fetch?: FetchLike;
}

/** Per-model request body. Only fields documented for that endpoint. */
export function buildHiggsfieldBody(model: string, prompt: string, imageUrl: string | undefined): Record<string, unknown> {
  if (model.startsWith("bytedance/seedance-2.0/text-to-video")) {
    return { prompt, duration: 5, resolution: "480p", aspect_ratio: "9:16", generate_audio: false };
  }
  if (!imageUrl) throw new AdapterError(`${model} needs a source image`, true);
  if (model.startsWith("minimax/hailuo-2.3")) return { prompt, image_url: imageUrl, duration: 6 };
  if (model.startsWith("kling-video/v3.0-turbo")) return { prompt, image_url: imageUrl, duration: 5, resolution: "720p" };
  return { prompt, image_url: imageUrl, duration: 5 };
}

/** Seedance is token-metered and the estimate endpoint only returns a description, so price it from the formula. */
function seedanceEstimateUsd(): number {
  const tokens = Math.ceil((5 * 480 * 854 * 24) / 1024);
  return Math.round(tokens * 0.014) / 1000;
}

const parseUsd = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
};

export class HiggsfieldVideoGenerator implements VideoGenerator {
  readonly provider = "higgsfield";
  private readonly fetchFn: FetchLike;

  constructor(private readonly cfg: HiggsfieldConfig) {
    this.fetchFn = cfg.fetch ?? fetch;
  }

  async estimate(req: VideoRequest): Promise<MediaCost> {
    this.assertKnown(req.model);
    const body = buildHiggsfieldBody(req.model, req.prompt, req.sourceImageUri ?? "https://example.com/placeholder.jpg");
    const r = (await this.call(`/estimate/${req.model}`, "POST", body)) as {
      type?: string;
      usd?: string;
      discount?: { usd?: string };
    };
    const quoted = parseUsd(r.discount?.usd) ?? parseUsd(r.usd);
    if (r.type === "estimate" && quoted !== undefined) return { usd: quoted, isEstimate: true, source: "Higgsfield estimate API" };
    return { usd: seedanceEstimateUsd(), isEstimate: true, source: "computed from Higgsfield's price formula" };
  }

  async submit(req: VideoRequest): Promise<{ providerJobId: string }> {
    this.assertKnown(req.model);
    const r = (await this.call(`/${req.model}`, "POST", buildHiggsfieldBody(req.model, req.prompt, req.sourceImageUri))) as {
      request_id?: string;
    };
    if (!r.request_id) throw new AdapterError("Higgsfield returned no request_id", false);
    return { providerJobId: r.request_id };
  }

  async status(providerJobId: string): Promise<VideoJobState> {
    if (!/^[A-Za-z0-9-]{8,80}$/.test(providerJobId)) throw new AdapterError("invalid job id", true);
    const r = (await this.call(`/requests/${providerJobId}/status`, "GET")) as {
      status?: string;
      video?: { url?: string };
      cost?: { usd?: unknown };
      usd?: unknown;
    };
    switch (r.status) {
      case "completed":
        return { status: "completed", videoUrl: r.video?.url, actualCostUsd: parseUsd(r.cost?.usd) ?? parseUsd(r.usd) };
      case "failed":
      case "nsfw":
      case "canceled":
        return {
          status: "failed",
          error: r.status === "nsfw" ? "Stopped by the content filter (not charged)." : `Job ${r.status} (not charged).`,
        };
      case "in_progress":
        return { status: "in_progress" };
      default:
        return { status: "queued" };
    }
  }

  private assertKnown(model: string) {
    if (!findVideoModel(model)) throw new AdapterError(`unknown video model "${model}"`, true);
  }

  private async call(path: string, method: "GET" | "POST", body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchFn(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Key ${this.cfg.apiKey}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new AdapterError(`network error: ${this.scrub((err as Error).message)}`, false);
    }
    const text = await res.text();
    if (!res.ok) {
      const transient = res.status === 429 || res.status >= 500;
      throw new AdapterError(`Higgsfield ${res.status}: ${this.scrub(text.slice(0, 300))}`, !transient, res.status);
    }
    return text ? JSON.parse(text) : {};
  }

  /** Never let the credential reach logs or error messages. */
  private scrub(text: string): string {
    let out = text;
    for (const part of [this.cfg.apiKey, ...this.cfg.apiKey.split(":")]) if (part.length > 6) out = out.split(part).join("[redacted]");
    return out;
  }
}
