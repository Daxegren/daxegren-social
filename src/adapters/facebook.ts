import type { Asset, AssetKind, Metrics, PostVariant } from "../domain.js";
import { requestJson } from "./http.js";
import {
  AdapterError,
  type AdapterCapabilities,
  type ChannelAdapter,
  type FetchLike,
  type PublishResult,
  type RemotePost,
} from "./types.js";

export interface FacebookConfig {
  pageId: string;
  /** A *Page* access token (pages_manage_posts, pages_read_engagement). */
  accessToken: string;
  graphVersion?: string;
  fetch?: FetchLike;
}

interface FbPost {
  id: string;
  message?: string;
  created_time?: string;
  permalink_url?: string;
  attachments?: { data?: Array<{ media_type?: string; subattachments?: { data?: Array<{ media_type?: string }> } }> };
  reactions?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number } };
  shares?: { count?: number };
}

const METRIC_FIELDS = "reactions.summary(true).limit(0),comments.summary(true).limit(0),shares";

/**
 * Facebook Page publishing through the Graph API: text, one photo, several photos, or one video.
 * NOTE: written from memory of the Graph API and not yet confirmed against a live Page token — post once and read the
 * result before relying on it.
 */
export class FacebookAdapter implements ChannelAdapter {
  readonly channel = "facebook" as const;
  readonly capabilities: AdapterCapabilities = { canIngest: true, canMeasure: true };

  private readonly fetchFn: FetchLike;
  private readonly base: string;

  constructor(private readonly cfg: FacebookConfig) {
    this.fetchFn = cfg.fetch ?? fetch;
    this.base = `https://graph.facebook.com/${cfg.graphVersion ?? "v21.0"}`;
  }

  async publish(variant: PostVariant, assets: Asset[]): Promise<PublishResult> {
    const images = assets.filter((a) => a.kind === "image");
    const videos = assets.filter((a) => a.kind === "video");
    if (videos.length > 1) throw new AdapterError("a facebook post can hold one video", true);
    if (videos.length === 1 && images.length > 0) throw new AdapterError("facebook cannot mix photos and a video in one post", true);

    const page = this.cfg.pageId;
    let externalId: string;

    if (assets.length === 0) {
      externalId = (await this.post<{ id: string }>(`/${page}/feed`, { message: variant.text })).id;
    } else if (videos.length === 1) {
      externalId = (await this.post<{ id: string }>(`/${page}/videos`, { file_url: videos[0]!.uri, description: variant.text })).id;
    } else if (images.length === 1) {
      const r = await this.post<{ id: string; post_id?: string }>(`/${page}/photos`, { url: images[0]!.uri, caption: variant.text, published: "true" });
      externalId = r.post_id ?? r.id;
    } else {
      // Several photos: upload each unpublished, then attach them all to one feed post.
      const ids: string[] = [];
      for (const img of images) ids.push((await this.post<{ id: string }>(`/${page}/photos`, { url: img.uri, published: "false" })).id);
      const params: Record<string, string> = { message: variant.text };
      ids.forEach((id, i) => (params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id })));
      externalId = (await this.post<{ id: string }>(`/${page}/feed`, params)).id;
    }

    let url: string | undefined;
    try {
      url = (await this.get<{ permalink_url?: string }>(`/${externalId}`, { fields: "permalink_url" })).permalink_url;
    } catch {
      // The post is live; a missing permalink must not turn this into a failure (and a duplicate retry).
    }
    return { externalId, url };
  }

  async fetchPublished(since?: Date): Promise<RemotePost[]> {
    const res = await this.get<{ data: FbPost[] }>(`/${this.cfg.pageId}/posts`, {
      fields: `id,message,created_time,permalink_url,attachments{media_type,subattachments{media_type}},${METRIC_FIELDS}`,
      limit: "50",
    });
    return res.data
      .filter((p) => p.created_time && (!since || new Date(p.created_time) >= since))
      .map((p) => ({
        channel: "facebook" as const,
        externalId: p.id,
        url: p.permalink_url,
        text: p.message ?? "",
        mediaKinds: this.mediaKinds(p),
        publishedAt: new Date(p.created_time!).toISOString(),
        metrics: this.toMetrics(p),
      }));
  }

  async fetchMetrics(externalId: string): Promise<Metrics | null> {
    return this.toMetrics(await this.get<FbPost>(`/${externalId}`, { fields: METRIC_FIELDS }));
  }

  private toMetrics(p: FbPost): Metrics {
    return { likes: p.reactions?.summary?.total_count, comments: p.comments?.summary?.total_count, shares: p.shares?.count, collectedAt: new Date().toISOString() };
  }

  private mediaKinds(p: FbPost): AssetKind[] {
    const types = (p.attachments?.data ?? []).flatMap((a) => [a.media_type, ...(a.subattachments?.data ?? []).map((s) => s.media_type)]);
    const kinds = new Set<AssetKind>();
    for (const t of types) {
      if (t === "video") kinds.add("video");
      else if (t === "photo" || t === "album") kinds.add("image");
    }
    return [...kinds];
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
