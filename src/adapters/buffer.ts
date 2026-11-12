import type { Asset, AssetKind, Channel, Metrics, PostVariant } from "../domain.js";
import {
  AdapterError,
  type AdapterCapabilities,
  type ChannelAdapter,
  type FetchLike,
  type HandoffState,
  type PublishResult,
  type RemotePost,
} from "./types.js";

export interface BufferConfig {
  /** Personal API key from Buffer → Settings → API. Server side only. */
  apiKey: string;
  /** The Buffer channel this adapter posts to. */
  channelId: string;
  /** Which of our channels it stands for (default: derived from the Buffer channel's service). */
  channel: Channel;
  /** Looked up from the account when omitted. */
  organizationId?: string;
  fetch?: FetchLike;
  endpoint?: string;
}

/** Buffer's service names where they differ from ours. */
const SERVICE: Partial<Record<Channel, string>> = { x: "twitter" };
export const bufferService = (channel: Channel) => SERVICE[channel] ?? channel;

interface BufferMetric {
  type: string;
  value: number;
  unit?: string;
}

interface BufferPost {
  id: string;
  text?: string;
  status?: string;
  dueAt?: string | null;
  sentAt?: string | null;
  externalLink?: string | null;
  assets?: Array<{ mimeType?: string }>;
  error?: { message?: string } | null;
  metrics?: BufferMetric[] | null;
  metricsUpdatedAt?: string | null;
}

const METRICS = "metrics { type name value unit } metricsUpdatedAt";
const POST_FIELDS = `id text status dueAt sentAt externalLink assets { mimeType } error { message } ${METRICS}`;

/** Buffer's normalised metric names onto ours. Several Buffer metrics can feed one of ours (shares + reposts). */
export function toMetrics(list: BufferMetric[] | null | undefined, collectedAt: string): Metrics | undefined {
  if (!list?.length) return undefined;
  const sum = (...types: string[]) => {
    const found = list.filter((m) => types.includes(m.type) && Number.isFinite(m.value));
    return found.length ? found.reduce((a, m) => a + m.value, 0) : undefined;
  };
  const metrics: Metrics = {
    impressions: sum("impressions"),
    reach: sum("reach"),
    views: sum("views"),
    likes: sum("reactions"),
    comments: sum("comments"),
    shares: sum("shares", "reposts"),
    saves: sum("saves"),
    clicks: sum("clicks"),
    collectedAt,
  };
  return Object.values(metrics).some((v) => typeof v === "number") ? metrics : undefined;
}

/**
 * Publishes through Buffer (https://developers.buffer.com): one adapter instance per Buffer channel. Buffer owns the
 * platform connection, so no per-platform app review is needed, and it reports performance back.
 *
 * - Posts are handed to Buffer with `shareNow` when our scheduler says they are due. Buffer then publishes
 *   asynchronously, so a handed-over post is not yet a published one: `reconcile` finds out which it became.
 * - Media must be a public, stable https URL (Drive/Dropbox share links do not work); our storage bucket qualifies.
 * - Free plans allow roughly 1,000 requests per channel per 30 days, so history and metrics are read in batches.
 *
 * Written from Buffer's documentation (checked 2026-11-06); not yet run against a live account.
 */
export class BufferAdapter implements ChannelAdapter {
  readonly channel: Channel;
  readonly capabilities: AdapterCapabilities = { canIngest: true, canMeasure: true };

  private readonly fetchFn: FetchLike;
  private readonly endpoint: string;
  private orgId?: string;

  constructor(private readonly cfg: BufferConfig) {
    this.channel = cfg.channel;
    this.fetchFn = cfg.fetch ?? fetch;
    this.endpoint = cfg.endpoint ?? "https://api.buffer.com";
    this.orgId = cfg.organizationId;
  }

  async publish(variant: PostVariant, assets: Asset[]): Promise<PublishResult> {
    const input = {
      text: variant.text,
      channelId: this.cfg.channelId,
      schedulingType: "automatic",
      mode: "shareNow",
      aiAssisted: true,
      assets: assets.map((a) => (a.kind === "image" ? { image: { url: a.uri } } : { video: { url: a.uri } })),
    };

    let data: { createPost: { post?: BufferPost; message?: string } };
    try {
      data = await this.gql(
        `mutation CreatePost($input: CreatePostInput!) {
           createPost(input: $input) {
             ... on PostActionSuccess { post { id status externalLink } }
             ... on MutationError { message }
           }
         }`,
        { input },
      );
    } catch (err) {
      if (err instanceof AdapterError && !err.permanent) {
        // The request may have gone through before the connection broke. Buffer has no idempotency key, so look for
        // the post before anyone retries; a second post is worse than a failed one.
        const existing = await this.findRecent(variant.text).catch(() => undefined);
        if (existing) return { externalId: existing.id, url: existing.externalLink ?? undefined };
      }
      throw err;
    }

    const result = data.createPost;
    if (!result.post) throw new AdapterError(`Buffer refused the post: ${result.message ?? "no reason given"}`, true);
    return { externalId: result.post.id, url: result.post.externalLink ?? undefined };
  }

  async fetchPublished(since?: Date): Promise<RemotePost[]> {
    const posts = await this.listPosts({ statuses: ["sent"], since, maxPages: 3 });
    return posts.flatMap((p) => {
      const when = p.sentAt ?? p.dueAt;
      if (!when) return [];
      return [
        {
          channel: this.channel,
          externalId: p.id,
          url: p.externalLink ?? undefined,
          text: p.text ?? "",
          mediaKinds: mediaKinds(p),
          publishedAt: new Date(when).toISOString(),
          metrics: toMetrics(p.metrics, p.metricsUpdatedAt ?? new Date().toISOString()),
        },
      ];
    });
  }

  async fetchMetrics(externalId: string): Promise<Metrics | null> {
    const data = await this.gql<{ post: BufferPost | null }>(`query Post($id: PostId!) { post(input: { id: $id }) { id ${METRICS} } }`, { id: externalId });
    return toMetrics(data.post?.metrics, data.post?.metricsUpdatedAt ?? new Date().toISOString()) ?? null;
  }

  /** Metrics for many posts in one or two requests (the latest sent posts), instead of one request per post. */
  async fetchMetricsBatch(externalIds: string[]): Promise<Map<string, Metrics>> {
    const wanted = new Set(externalIds);
    const out = new Map<string, Metrics>();
    for (const p of await this.listPosts({ statuses: ["sent"], maxPages: 2 })) {
      if (!wanted.has(p.id)) continue;
      const m = toMetrics(p.metrics, p.metricsUpdatedAt ?? new Date().toISOString());
      if (m) out.set(p.id, m);
    }
    return out;
  }

  /** What became of the posts we handed over: sent (with its link), failed (with Buffer's reason), or still pending. */
  async reconcile(externalIds: string[]): Promise<Map<string, HandoffState>> {
    const out = new Map<string, HandoffState>(externalIds.map((id) => [id, { state: "pending" }]));
    const since = new Date(Date.now() - 2 * 86_400_000);
    for (const p of await this.listPosts({ statuses: ["sent", "error"], since, maxPages: 1 })) {
      if (!out.has(p.id)) continue;
      out.set(
        p.id,
        p.status === "error"
          ? { state: "error", error: p.error?.message ?? "Buffer could not publish the post" }
          : { state: "sent", url: p.externalLink ?? undefined },
      );
    }
    return out;
  }

  // ── Buffer plumbing ───────────────────────────────────────────────────

  private async findRecent(text: string): Promise<BufferPost | undefined> {
    const recent = await this.listPosts({ statuses: ["sending", "scheduled", "sent"], since: new Date(Date.now() - 15 * 60_000), maxPages: 1 });
    return recent.find((p) => (p.text ?? "").trim() === text.trim());
  }

  private async organizationId(): Promise<string> {
    if (this.orgId) return this.orgId;
    const account = await this.gql<{ account: { organizations: Array<{ id: string }> } }>("query { account { organizations { id } } }");
    for (const org of account.account.organizations) {
      const channels = await this.gql<{ channels: Array<{ id: string }> }>(
        `query Channels($org: OrganizationId!) { channels(input: { organizationId: $org }) { id } }`,
        { org: org.id },
      );
      if (channels.channels.some((c) => c.id === this.cfg.channelId)) return (this.orgId = org.id);
    }
    throw new AdapterError(`Buffer channel ${this.cfg.channelId} was not found in your account (run: buffer-channels)`, true);
  }

  private async listPosts(o: { statuses: string[]; since?: Date; maxPages: number }): Promise<BufferPost[]> {
    const org = await this.organizationId();
    const filter = [
      `channelIds: [${JSON.stringify(this.cfg.channelId)}]`,
      `status: [${o.statuses.join(", ")}]`,
      o.since ? `startDate: ${JSON.stringify(o.since.toISOString())}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    const query = `query Posts($first: Int!, $after: String) {
      posts(first: $first, after: $after, input: { organizationId: ${JSON.stringify(org)}, filter: { ${filter} }, sort: [{ field: createdAt, direction: desc }] }) {
        edges { node { ${POST_FIELDS} } }
        pageInfo { hasNextPage endCursor }
      }
    }`;

    const posts: BufferPost[] = [];
    let after: string | null = null;
    for (let page = 0; page < o.maxPages; page++) {
      const data: { posts: { edges: Array<{ node: BufferPost }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await this.gql(query, { first: 50, after });
      posts.push(...data.posts.edges.map((e) => e.node));
      if (!data.posts.pageInfo.hasNextPage) break;
      after = data.posts.pageInfo.endCursor;
    }
    return posts;
  }

  /** One GraphQL request. HTTP and API-level problems become AdapterErrors with the right retry behaviour. */
  private async gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.cfg.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      throw new AdapterError(`network error: ${this.scrub((err as Error).message)}`, false);
    }

    const text = await res.text();
    if (res.status === 429 || res.status >= 500) throw new AdapterError(`Buffer HTTP ${res.status}: ${this.scrub(text.slice(0, 300))}`, false, res.status);
    if (!res.ok) throw new AdapterError(`Buffer HTTP ${res.status}: ${this.scrub(text.slice(0, 300))}`, true, res.status);

    let body: { data?: T; errors?: Array<{ message?: string; extensions?: { code?: string } }> };
    try {
      body = JSON.parse(text);
    } catch {
      throw new AdapterError("Buffer returned something that is not JSON", false);
    }
    if (body.errors?.length) {
      const e = body.errors[0]!;
      const code = e.extensions?.code ?? "";
      // Per Buffer's docs: UNEXPECTED and RATE_LIMIT_EXCEEDED are worth retrying; the rest will not change.
      const transient = code === "UNEXPECTED" || code === "RATE_LIMIT_EXCEEDED";
      throw new AdapterError(`Buffer ${code || "error"}: ${this.scrub(e.message ?? "unknown")}`, !transient);
    }
    if (!body.data) throw new AdapterError("Buffer returned no data", false);
    return body.data;
  }

  private scrub(text: string): string {
    return this.cfg.apiKey.length > 6 ? text.split(this.cfg.apiKey).join("[redacted]") : text;
  }
}

function mediaKinds(p: BufferPost): AssetKind[] {
  const kinds = new Set<AssetKind>();
  for (const a of p.assets ?? []) {
    if (a.mimeType?.startsWith("video/")) kinds.add("video");
    else if (a.mimeType?.startsWith("image/")) kinds.add("image");
  }
  return [...kinds];
}
