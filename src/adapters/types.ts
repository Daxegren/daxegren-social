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
