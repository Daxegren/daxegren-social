import type {
  Asset,
  Channel,
  ContentBrief,
  MediaJob,
  MediaJobStatus,
  PostVariant,
  PublishedPost,
  VariantStatus,
} from "./domain.js";

/**
 * Persistence boundary. The engine only talks to this interface so it can run
 * against memory (tests), or Postgres/Supabase (see db/migrations).
 */
export interface Store {
  putAsset(asset: Asset): Promise<void>;
  getAssets(ids: string[]): Promise<Asset[]>;

  /** Upsert keyed on (channel, externalId). Returns the stored post. */
  upsertPost(post: PublishedPost): Promise<PublishedPost>;
  listPosts(filter?: { channel?: Channel }): Promise<PublishedPost[]>;
  getPost(id: string): Promise<PublishedPost | undefined>;

  putBrief(brief: ContentBrief): Promise<void>;
  getBrief(id: string): Promise<ContentBrief | undefined>;

  putVariant(variant: PostVariant): Promise<void>;
  getVariant(id: string): Promise<PostVariant | undefined>;
  listVariants(filter?: { status?: VariantStatus; briefId?: string }): Promise<PostVariant[]>;

  putMediaJob(job: MediaJob): Promise<void>;
  getMediaJob(id: string): Promise<MediaJob | undefined>;
  listMediaJobs(filter?: { statuses?: MediaJobStatus[] }): Promise<MediaJob[]>;
  /** Money committed to media generation since `sinceIso`: actual cost where known, otherwise the estimate. */
  mediaSpendUsd(sinceIso: string): Promise<number>;

  /**
   * Atomically move a variant from `from` to `to`. Returns the updated variant,
   * or undefined if it was not in `from` (someone else claimed it).
   */
  transitionVariant(id: string, from: VariantStatus, to: VariantStatus): Promise<PostVariant | undefined>;
}

export class MemoryStore implements Store {
  private assets = new Map<string, Asset>();
  private posts = new Map<string, PublishedPost>();
  private briefs = new Map<string, ContentBrief>();
  private variants = new Map<string, PostVariant>();
  private mediaJobs = new Map<string, MediaJob>();

  async putAsset(asset: Asset) {
    this.assets.set(asset.id, structuredClone(asset));
  }

  async getAssets(ids: string[]) {
    return ids.flatMap((id) => {
      const a = this.assets.get(id);
      return a ? [structuredClone(a)] : [];
    });
  }

  async upsertPost(post: PublishedPost) {
    const existing = [...this.posts.values()].find(
      (p) => p.channel === post.channel && p.externalId === post.externalId,
    );
    // Same merge rule as PostgresStore: keep provenance and metrics the incoming post does not carry.
    const stored = structuredClone({
      ...post,
      id: existing?.id ?? post.id,
      metrics: post.metrics ?? existing?.metrics,
      variantId: post.variantId ?? existing?.variantId,
    });
    this.posts.set(stored.id, stored);
    return structuredClone(stored);
  }

  async listPosts(filter?: { channel?: Channel }) {
    return [...this.posts.values()]
      .filter((p) => !filter?.channel || p.channel === filter.channel)
      .map((p) => structuredClone(p));
  }

  async getPost(id: string) {
    const p = this.posts.get(id);
    return p ? structuredClone(p) : undefined;
  }

  async putBrief(brief: ContentBrief) {
    this.briefs.set(brief.id, structuredClone(brief));
  }

  async getBrief(id: string) {
    const b = this.briefs.get(id);
    return b ? structuredClone(b) : undefined;
  }

  async putVariant(variant: PostVariant) {
    this.variants.set(variant.id, structuredClone(variant));
  }

  async getVariant(id: string) {
    const v = this.variants.get(id);
    return v ? structuredClone(v) : undefined;
  }

  async listVariants(filter?: { status?: VariantStatus; briefId?: string }) {
    return [...this.variants.values()]
      .filter((v) => !filter?.status || v.status === filter.status)
      .filter((v) => !filter?.briefId || v.briefId === filter.briefId)
      .map((v) => structuredClone(v));
  }

  async putMediaJob(job: MediaJob) {
    this.mediaJobs.set(job.id, structuredClone(job));
  }

  async getMediaJob(id: string) {
    const j = this.mediaJobs.get(id);
    return j ? structuredClone(j) : undefined;
  }

  async listMediaJobs(filter?: { statuses?: MediaJobStatus[] }) {
    return [...this.mediaJobs.values()]
      .filter((j) => !filter?.statuses || filter.statuses.includes(j.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((j) => structuredClone(j));
  }

  async mediaSpendUsd(sinceIso: string) {
    return [...this.mediaJobs.values()]
      .filter((j) => j.createdAt >= sinceIso)
      .reduce((sum, j) => sum + (j.actualCostUsd ?? j.estimatedCostUsd), 0);
  }

  async transitionVariant(id: string, from: VariantStatus, to: VariantStatus) {
    const v = this.variants.get(id);
    if (!v || v.status !== from) return undefined;
    v.status = to;
    return structuredClone(v);
  }
}
