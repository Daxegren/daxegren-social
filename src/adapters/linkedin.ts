import type { Asset, Metrics, PostVariant } from "../domain.js";
import { requestJson } from "./http.js";
import {
  AdapterError,
  NotSupportedError,
  type AdapterCapabilities,
  type ChannelAdapter,
  type FetchLike,
  type PublishResult,
  type RemotePost,
} from "./types.js";

/**
 * LinkedIn supports each monthly API version for about a year, then rejects it (202511 sunsets 2026-11-16). This default is
 * the version current when the adapter was last checked against the docs (2026-11-06); `doctor` warns when it gets old.
 */
export const DEFAULT_LINKEDIN_VERSION = "202610";

export interface LinkedInConfig {
  /** e.g. `urn:li:person:abc123` or `urn:li:organization:456`. */
  authorUrn: string;
  accessToken: string;
  /** `YYYYMM` value of the `Linkedin-Version` header. */
  apiVersion?: string;
  fetch?: FetchLike;
}

/**
 * LinkedIn publishing via the Posts API (`w_member_social` / `w_organization_social`).
 * Text posts and a single image are supported.
 *
 * Reading back published posts and analytics needs restricted permissions that
 * are not available to every app, so ingestion goes through `engine.importPosts`
 * (e.g. from LinkedIn's data export) unless you extend this adapter.
 */
export class LinkedInAdapter implements ChannelAdapter {
  readonly channel = "linkedin" as const;
  readonly capabilities: AdapterCapabilities = { canIngest: false, canMeasure: false };

  private readonly fetchFn: FetchLike;
  private readonly version: string;

  constructor(private readonly cfg: LinkedInConfig) {
    this.fetchFn = cfg.fetch ?? fetch;
    this.version = cfg.apiVersion ?? DEFAULT_LINKEDIN_VERSION;
  }

  async publish(variant: PostVariant, assets: Asset[]): Promise<PublishResult> {
    if (assets.length > 1) throw new AdapterError("linkedin adapter currently supports at most one image", true);
    const asset = assets[0];
    if (asset && asset.kind !== "image") throw new AdapterError("linkedin adapter currently supports image media only", true);

    const body: Record<string, unknown> = {
      author: this.cfg.authorUrn,
      commentary: variant.text,
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };
    if (asset) body.content = { media: { id: await this.uploadImage(asset) } };

    const res = await requestJson(this.fetchFn, "https://api.linkedin.com/rest/posts", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const urn = res.headers.get("x-restli-id");
    if (!urn) throw new AdapterError("linkedin did not return a post id", false);
    return { externalId: urn, url: `https://www.linkedin.com/feed/update/${urn}` };
  }

  async fetchPublished(): Promise<RemotePost[]> {
    throw new NotSupportedError("linkedin ingestion");
  }

  async fetchMetrics(): Promise<Metrics | null> {
    return null;
  }

  private async uploadImage(asset: Asset): Promise<string> {
    const init = await requestJson<{ value: { uploadUrl: string; image: string } }>(
      this.fetchFn,
      "https://api.linkedin.com/rest/images?action=initializeUpload",
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ initializeUploadRequest: { owner: this.cfg.authorUrn } }),
      },
    );

    const source = await this.fetchFn(asset.uri);
    if (!source.ok) throw new AdapterError(`could not download asset ${asset.id} (HTTP ${source.status})`, source.status < 500 && source.status !== 429);
    const bytes = await source.arrayBuffer();

    await requestJson(this.fetchFn, init.body.value.uploadUrl, {
      method: "PUT",
      headers: { Authorization: `Bearer ${this.cfg.accessToken}` },
      body: bytes,
    });
    return init.body.value.image;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.accessToken}`,
      "Content-Type": "application/json",
      "Linkedin-Version": this.version,
      "X-Restli-Protocol-Version": "2.0.0",
    };
  }
}
