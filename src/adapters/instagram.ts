import type { Asset, Metrics, PostVariant } from "../domain.js";
import { requestJson } from "./http.js";
import {
  AdapterError,
  type AdapterCapabilities,
  type ChannelAdapter,
  type FetchLike,
  type PublishResult,
  type RemotePost,
} from "./types.js";

export interface InstagramConfig {
  igUserId: string;
  accessToken: string;
  graphVersion?: string;
  fetch?: FetchLike;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Max polls while a video container is processing. */
  maxStatusPolls?: number;
  pollIntervalMs?: number;
}

interface IgMedia {
  id: string;
  caption?: string;
  media_type?: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM";
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
}

/**
 * Instagram publishing through the Meta Graph API (Instagram Business/Creator
 * account, `instagram_content_publish` permission).
 * Images: create container -> publish. Videos are published as Reels and the
 * container is polled until processing finishes.
 */
export class InstagramAdapter implements ChannelAdapter {
  readonly channel = "instagram" as const;
  readonly capabilities: AdapterCapabilities = { canIngest: true, canMeasure: true };

  private readonly fetchFn: FetchLike;
  private readonly base: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly cfg: InstagramConfig) {
    this.fetchFn = cfg.fetch ?? fetch;
    this.base = `https://graph.facebook.com/${cfg.graphVersion ?? "v21.0"}`;
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async publish(variant: PostVariant, assets: Asset[]): Promise<PublishResult> {
    if (assets.length !== 1) {
      throw new AdapterError("instagram adapter currently publishes exactly one image or video (carousels: todo)", true);
    }
    const asset = assets[0]!;
    const params: Record<string, string> = { caption: variant.text };
    if (asset.kind === "image") {
      params.image_url = asset.uri;
    } else {
      params.media_type = "REELS";
      params.video_url = asset.uri;
    }

    const container = await this.post<{ id: string }>(`/${this.cfg.igUserId}/media`, params);
    if (asset.kind === "video") await this.waitUntilReady(container.id);

    const published = await this.post<{ id: string }>(`/${this.cfg.igUserId}/media_publish`, {
      creation_id: container.id,
    });

    let url: string | undefined;
    try {
      const info = await this.get<IgMedia>(`/${published.id}`, { fields: "permalink" });
      url = info.permalink;
    } catch {
      // The post is live; a missing permalink must not turn this into a failure (and a duplicate retry).
    }
    return { externalId: published.id, url };
  }

  async fetchPublished(since?: Date): Promise<RemotePost[]> {
    const res = await this.get<{ data: IgMedia[] }>(`/${this.cfg.igUserId}/media`, {
      fields: "id,caption,media_type,permalink,timestamp,like_count,comments_count",
      limit: "50",
    });
    return res.data
      .filter((m) => m.timestamp && (!since || new Date(m.timestamp) >= since))
      .map((m) => ({
        channel: "instagram" as const,
        externalId: m.id,
        url: m.permalink,
        text: m.caption ?? "",
        mediaKinds: [m.media_type === "VIDEO" ? ("video" as const) : ("image" as const)],
        publishedAt: m.timestamp!,
        metrics: this.toMetrics(m),
      }));
  }

  async fetchMetrics(externalId: string): Promise<Metrics | null> {
    const m = await this.get<IgMedia>(`/${externalId}`, { fields: "like_count,comments_count" });
    return this.toMetrics(m);
  }

  private toMetrics(m: IgMedia): Metrics {
    return { likes: m.like_count, comments: m.comments_count, collectedAt: new Date().toISOString() };
  }

  private async waitUntilReady(containerId: string) {
    const max = this.cfg.maxStatusPolls ?? 30;
    for (let i = 0; i < max; i++) {
      const s = await this.get<{ status_code?: string }>(`/${containerId}`, { fields: "status_code" });
      if (s.status_code === "FINISHED") return;
      if (s.status_code === "ERROR" || s.status_code === "EXPIRED") {
        throw new AdapterError(`instagram container ${s.status_code}`, true);
      }
      await this.sleep(this.cfg.pollIntervalMs ?? 5000);
    }
    throw new AdapterError("instagram video processing timed out", false);
  }

  private async post<T>(path: string, params: Record<string, string>): Promise<T> {
    const body = new URLSearchParams({ ...params, access_token: this.cfg.accessToken });
    const { body: out } = await requestJson<T>(this.fetchFn, `${this.base}${path}`, { method: "POST", body });
    return out;
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams({ ...params, access_token: this.cfg.accessToken });
    const { body } = await requestJson<T>(this.fetchFn, `${this.base}${path}?${qs}`);
    return body;
  }
}
