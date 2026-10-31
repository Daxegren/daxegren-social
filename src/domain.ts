export const CHANNELS = [
  "instagram",
  "tiktok",
  "facebook",
  "linkedin",
  "pinterest",
  "youtube",
  "snapchat",
  "x",
] as const;

export type Channel = (typeof CHANNELS)[number];

export type AssetKind = "image" | "video";

/** `captured` = filmed/photographed by the owner; `generated` = produced by a media generator. */
export type AssetOrigin = "captured" | "generated";

export interface Asset {
  id: string;
  kind: AssetKind;
  origin: AssetOrigin;
  /** Publicly reachable https URL (required by most platform APIs). */
  uri: string;
  createdAt: string;
  meta?: Record<string, unknown>;
}

export interface Metrics {
  impressions?: number;
  reach?: number;
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  clicks?: number;
  collectedAt: string;
}

/** Content that already exists on a channel. Input to the learning loop. */
export interface PublishedPost {
  id: string;
  channel: Channel;
  externalId: string;
  url?: string;
  text: string;
  mediaKinds: AssetKind[];
  publishedAt: string;
  metrics?: Metrics;
  /** Set when the post was published by this engine. */
  variantId?: string;
}

export interface ContentBrief {
  id: string;
  idea: string;
  angle?: string;
  goal?: string;
  /** Existing posts the new content builds on. */
  sourcePostIds: string[];
  /** Owner-captured or generated assets available to attach. */
  assetIds: string[];
  createdAt: string;
}

export type VariantStatus =
  | "draft"
  | "scheduled"
  | "publishing"
  | "published"
  | "failed"
  | "rejected";

export interface PostVariant {
  id: string;
  briefId: string;
  channel: Channel;
  text: string;
  assetIds: string[];
  status: VariantStatus;
  /** Why the generator chose this variant. Shown in the review queue. */
  rationale?: string;
  scheduledAt?: string;
  attempts: number;
  lastError?: string;
  externalId?: string;
  url?: string;
  publishedAt?: string;
  createdAt: string;
}

export type MediaJobStatus = "queued" | "in_progress" | "completed" | "failed";

/** A paid media generation (video: asynchronous; image: synchronous). Persisted before spending so a result can never be lost. */
export interface MediaJob {
  id: string;
  kind: "video" | "image";
  provider: string;
  model: string;
  prompt: string;
  sourceImageUri?: string;
  providerJobId?: string;
  status: MediaJobStatus;
  estimatedCostUsd: number;
  /** Provider-reported cost, or 0 for a failed job. The cost counted against the cap is `actual ?? estimated`. */
  actualCostUsd?: number;
  /** The generated Asset (same id as the job). Set when completed. */
  assetId?: string;
  error?: string;
  createdAt: string;
  finishedAt?: string;
}
