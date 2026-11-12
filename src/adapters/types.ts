import type { Asset, Channel, Metrics, PostVariant, PublishedPost } from "../domain.js";

export type FetchLike = typeof fetch;

export interface PublishResult {
  externalId: string;
  url?: string;
}

export interface AdapterCapabilities {
  /** Can list previously published posts through the API. */
  canIngest: boolean;
  /** Can read per-post metrics through the API. */
  canMeasure: boolean;
}

/** Ingested post before the engine assigns it an internal id. */
export type RemotePost = Omit<PublishedPost, "id">;

/** What became of a post that was handed to an intermediary (e.g. Buffer) which publishes asynchronously. */
export interface HandoffState {
  state: "pending" | "sent" | "error";
  /** The live post, once sent. */
  url?: string;
  error?: string;
}

/**
 * One adapter per channel. Everything platform specific (auth, endpoints,
 * upload flows) lives behind this interface so the engine stays channel-agnostic.
 */
export interface ChannelAdapter {
  readonly channel: Channel;
  readonly capabilities: AdapterCapabilities;
  fetchPublished(since?: Date): Promise<RemotePost[]>;
  publish(variant: PostVariant, assets: Asset[]): Promise<PublishResult>;
  fetchMetrics(externalId: string): Promise<Metrics | null>;
  /** Metrics for many posts in as few requests as possible. Used instead of `fetchMetrics` when present. */
  fetchMetricsBatch?(externalIds: string[]): Promise<Map<string, Metrics>>;
  /**
   * For adapters that hand posts to a service which publishes later: what became of them. Without it, a successful
   * `publish` means the post is live.
   */
  reconcile?(externalIds: string[]): Promise<Map<string, HandoffState>>;
}

/**
 * `permanent` errors (bad request, auth revoked, policy rejection) are never retried.
 * Everything else (429, 5xx, network) is retried with backoff.
 */
export class AdapterError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

export class NotSupportedError extends AdapterError {
  constructor(what: string) {
    super(`${what} is not supported by this adapter`, true);
    this.name = "NotSupportedError";
  }
}
