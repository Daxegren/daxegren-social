import type { MediaJob } from "./domain.js";

export interface MediaCost {
  usd: number;
  /** true when the number is our own estimate rather than the provider's quote. */
  isEstimate: boolean;
  source: string;
}

export interface VideoRequest {
  model: string;
  prompt: string;
  /** Public https URL of the source image (image-to-video models). */
  sourceImageUri?: string;
}

export interface VideoJobState {
  status: MediaJob["status"];
  videoUrl?: string;
  error?: string;
  /** Provider-reported actual cost, when the API returns one. */
  actualCostUsd?: number;
}

/** Async video provider: submit a job, then poll it. */
export interface VideoGenerator {
  readonly provider: string;
  estimate(req: VideoRequest): Promise<MediaCost>;
  submit(req: VideoRequest): Promise<{ providerJobId: string }>;
  status(providerJobId: string): Promise<VideoJobState>;
}

/** Durable storage for generated files. Platforms fetch media from a public https URL, and provider links expire. */
export interface MediaStorage {
  /** Stores the bytes and returns a public https URL. */
  put(path: string, bytes: Uint8Array, mimeType: string): Promise<string>;
}

export type ImageAspect = "1:1" | "4:5" | "9:16";
export const IMAGE_ASPECTS: readonly ImageAspect[] = ["1:1", "4:5", "9:16"];

export interface ImageRequest {
  prompt: string;
  aspect: ImageAspect;
  /** Reference image the result should be based on (e.g. a product photo): public https URL, bytes already fetched. */
  reference?: { bytes: Uint8Array; mimeType: string };
}

export interface GeneratedImage {
  bytes: Uint8Array;
  mimeType: string;
  /** Provider-reported cost when available; otherwise the caller uses the estimate. */
  actualCostUsd?: number;
}

/** Synchronous image provider. */
export interface ImageGenerator {
  readonly provider: string;
  readonly model: string;
  estimate(req: Pick<ImageRequest, "aspect">): Promise<MediaCost>;
  generate(req: ImageRequest): Promise<GeneratedImage>;
}

export interface VideoModel {
  id: string;
  label: string;
  mode: "image-to-video" | "text-to-video";
  durationSeconds: number;
  note: string;
}

/** Curated subset of the Higgsfield catalogue (not the full list). Verify ids against their docs. */
export const VIDEO_MODELS: readonly VideoModel[] = [
  {
    id: "kling-video/v2.5-turbo/standard/image-to-video",
    label: "Kling 2.5 Turbo Standard",
    mode: "image-to-video",
    durationSeconds: 5,
    note: "Cheapest model with exactly 5 s. Good motion for product clips.",
  },
  {
    id: "minimax/hailuo-2.3/standard/image-to-video",
    label: "Hailuo 2.3 Standard",
    mode: "image-to-video",
    durationSeconds: 6,
    note: "Often cheapest, but clips are 6 s.",
  },
  {
    id: "kling-video/v3.0-turbo/image-to-video",
    label: "Kling 3.0 Turbo",
    mode: "image-to-video",
    durationSeconds: 5,
    note: "Higher quality, roughly three times the price.",
  },
  {
    id: "bytedance/seedance-2.0/text-to-video",
    label: "Seedance 2.0 (text to video, 9:16)",
    mode: "text-to-video",
    durationSeconds: 5,
    note: "No source image needed. 480p, no audio.",
  },
];

export const DEFAULT_VIDEO_MODEL = VIDEO_MODELS[0]!.id;
export const DEFAULT_MONTHLY_CAP_USD = 50;

export const findVideoModel = (id: string) => VIDEO_MODELS.find((m) => m.id === id);

const VIDEO_PROMPT_SUFFIX =
  "Smooth, subtle camera motion, keep the subject sharp and recognisable, no text overlays, no logos.";

export function buildVideoPrompt(prompt: string): string {
  return `Short vertical clip. ${prompt.trim()} ${VIDEO_PROMPT_SUFFIX}`;
}

export function buildImagePrompt(prompt: string, aspect: ImageAspect, hasReference: boolean): string {
  return [
    hasReference
      ? "Photorealistic photograph featuring the product from the reference image."
      : "Photorealistic photograph.",
    prompt.trim(),
    hasReference ? "Keep the product's shape, colours and details exactly as in the reference." : "",
    `Composition for ${aspect}. Natural light. No text, no logos, no watermarks.`,
  ]
    .filter(Boolean)
    .join(" ");
}

export class MediaCapReachedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaCapReachedError";
  }
}

export interface CapCheck {
  allowed: boolean;
  message?: string;
}

/** Pure monthly cost guard. */
export function checkMonthlyCap(input: { spentUsd: number; capUsd: number; estimateUsd: number }): CapCheck {
  if (input.spentUsd + input.estimateUsd <= input.capUsd) return { allowed: true };
  return {
    allowed: false,
    message:
      `Monthly media cap reached: ${input.spentUsd.toFixed(2)} of ${input.capUsd.toFixed(2)} USD used this month and ` +
      `this generation is estimated at ${input.estimateUsd.toFixed(2)} USD. Raise MEDIA_MONTHLY_CAP_USD or wait until next month.`,
  };
}

export const monthStartIso = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
