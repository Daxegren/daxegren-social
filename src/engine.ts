import { analyzeChannel, suggestTime, type ChannelInsights } from "./analyze.js";
import { validateVariant } from "./channels.js";
import type { Asset, AssetKind, Channel, ContentBrief, PostVariant, PublishedPost } from "./domain.js";
import { NotSupportedError, type ChannelAdapter, type RemotePost } from "./adapters/types.js";
import type { ContentGenerator, MediaGenerator, MediaRequest } from "./generate.js";
import { runDue, type SchedulerOptions, type TickResult } from "./scheduler.js";
import type { Store } from "./store.js";

export interface EngineConfig {
  store: Store;
  adapters: Partial<Record<Channel, ChannelAdapter>>;
  generator: ContentGenerator;
  mediaGenerator?: MediaGenerator;
  /**
   * Channels whose generated variants skip the review queue and are scheduled
   * right away. Default: none — every variant waits for human approval.
   */
  autoApprove?: Channel[];
  scheduler?: SchedulerOptions;
  now?: () => Date;
}

export class ContentEngine {
  private readonly store: Store;
  private readonly adapters: Partial<Record<Channel, ChannelAdapter>>;
  private readonly now: () => Date;

  constructor(private readonly cfg: EngineConfig) {
    this.store = cfg.store;
    this.adapters = cfg.adapters;
    this.now = cfg.now ?? (() => new Date());
  }

  // ── Assets ────────────────────────────────────────────────────────────

  /** Register material you filmed or photographed yourself. */
  async addCapturedAsset(kind: AssetKind, uri: string, meta?: Record<string, unknown>): Promise<Asset> {
    return this.saveAsset(kind, "captured", uri, meta);
  }

  /** Generate an image/video and store it as a `generated` asset. */
  async generateAsset(req: MediaRequest): Promise<Asset> {
    if (!this.cfg.mediaGenerator) throw new Error("no media generator configured");
    const out = await this.cfg.mediaGenerator.generate(req);
    return this.saveAsset(req.kind, "generated", out.uri, { ...out.meta, prompt: req.prompt });
  }

  private async saveAsset(kind: AssetKind, origin: Asset["origin"], uri: string, meta?: Record<string, unknown>) {
    const asset: Asset = { id: crypto.randomUUID(), kind, origin, uri, createdAt: this.now().toISOString(), meta };
    await this.store.putAsset(asset);
    return asset;
  }

  // ── 1. Ingest ─────────────────────────────────────────────────────────

  /** Pull published posts from a channel's API. Returns the number stored. */
  async ingest(channel: Channel, since?: Date): Promise<number> {
    const adapter = this.requireAdapter(channel);
    if (!adapter.capabilities.canIngest) throw new NotSupportedError(`${channel} ingestion`);
    return this.importPosts(await adapter.fetchPublished(since));
  }

  /** Import posts from any source (data export, CSV, other tool). Idempotent per (channel, externalId). */
  async importPosts(posts: RemotePost[]): Promise<number> {
    for (const p of posts) await this.store.upsertPost({ ...p, id: crypto.randomUUID() });
    return posts.length;
  }

  /** Refresh metrics for already-published posts on channels that can measure. */
  async refreshMetrics(channel: Channel): Promise<number> {
    const adapter = this.requireAdapter(channel);
    if (!adapter.capabilities.canMeasure) return 0;
    let updated = 0;
    for (const post of await this.store.listPosts({ channel })) {
      const metrics = await adapter.fetchMetrics(post.externalId);
      if (!metrics) continue;
      await this.store.upsertPost({ ...post, metrics });
      updated++;
    }
    return updated;
  }

  // ── 2. Analyse ────────────────────────────────────────────────────────

  async analyze(channels: Channel[]): Promise<Partial<Record<Channel, ChannelInsights>>> {
    const posts = await this.store.listPosts();
    return Object.fromEntries(channels.map((c) => [c, analyzeChannel(c, posts)]));
  }

  // ── 3. Generate ───────────────────────────────────────────────────────

  async createBrief(input: {
    idea: string;
    angle?: string;
    goal?: string;
    sourcePostIds?: string[];
    assetIds?: string[];
  }): Promise<ContentBrief> {
    const brief: ContentBrief = {
      id: crypto.randomUUID(),
      idea: input.idea,
      angle: input.angle,
      goal: input.goal,
      sourcePostIds: input.sourcePostIds ?? [],
      assetIds: input.assetIds ?? [],
      createdAt: this.now().toISOString(),
    };
    await this.store.putBrief(brief);
    return brief;
  }

  /** Generate one variant per channel. Lands in the review queue unless the channel is in `autoApprove`. */
  async proposeVariants(briefId: string, channels: Channel[]): Promise<PostVariant[]> {
    const brief = await this.store.getBrief(briefId);
    if (!brief) throw new Error(`unknown brief ${briefId}`);

    const [insights, assets] = await Promise.all([this.analyze(channels), this.store.getAssets(brief.assetIds)]);
    const examples = await this.pickExamples(brief, insights);

    const generated = await this.cfg.generator.generate({ brief, channels, insights, examples, assets });

    const now = this.now();
    const out: PostVariant[] = [];
    for (const g of generated) {
      const variant: PostVariant = {
        id: crypto.randomUUID(),
        briefId,
        channel: g.channel,
        text: g.text,
        assetIds: g.assetIds,
        rationale: g.rationale,
        status: "draft",
        attempts: 0,
        createdAt: now.toISOString(),
      };
      if (this.cfg.autoApprove?.includes(g.channel)) {
        const problems = validateVariant(variant, await this.store.getAssets(variant.assetIds));
        if (problems.length === 0) {
          variant.status = "scheduled";
          variant.scheduledAt = suggestTime(insights[g.channel], now).toISOString();
        } else {
          variant.lastError = `not auto-approved: ${problems.join("; ")}`;
        }
      }
      await this.store.putVariant(variant);
      out.push(variant);
    }
    return out;
  }

  private async pickExamples(
    brief: ContentBrief,
    insights: Partial<Record<Channel, ChannelInsights>>,
  ): Promise<PublishedPost[]> {
    const ids = new Set(brief.sourcePostIds);
    for (const ins of Object.values(insights)) for (const t of ins?.topPosts ?? []) ids.add(t.postId);
    const posts = await Promise.all([...ids].map((id) => this.store.getPost(id)));
    return posts.filter((p): p is PublishedPost => p !== undefined);
  }

  // ── 4. Review ─────────────────────────────────────────────────────────

  /** Approve a draft (optionally edited) and schedule it. Rejects invalid variants up front. */
  async approve(variantId: string, opts: { scheduledAt?: Date; text?: string } = {}): Promise<PostVariant> {
    const variant = await this.requireVariant(variantId);
    if (variant.status !== "draft") throw new Error(`variant is ${variant.status}, only drafts can be approved`);

    const text = opts.text ?? variant.text;
    const problems = validateVariant({ ...variant, text }, await this.store.getAssets(variant.assetIds));
    if (problems.length > 0) throw new Error(`cannot approve: ${problems.join("; ")}`);

    const updated: PostVariant = {
      ...variant,
      text,
      status: "scheduled",
      scheduledAt: (opts.scheduledAt ?? this.now()).toISOString(),
    };
    await this.store.putVariant(updated);
    return updated;
  }

  async reject(variantId: string): Promise<PostVariant> {
    const variant = await this.requireVariant(variantId);
    if (variant.status !== "draft") throw new Error(`variant is ${variant.status}, only drafts can be rejected`);
    const updated: PostVariant = { ...variant, status: "rejected" };
    await this.store.putVariant(updated);
    return updated;
  }

  /** Put a failed variant back in the queue. */
  async retry(variantId: string, scheduledAt: Date = this.now()): Promise<PostVariant> {
    const variant = await this.requireVariant(variantId);
    if (variant.status !== "failed") throw new Error(`variant is ${variant.status}, only failed variants can be retried`);
    const updated: PostVariant = { ...variant, status: "scheduled", attempts: 0, scheduledAt: scheduledAt.toISOString() };
    await this.store.putVariant(updated);
    return updated;
  }

  // ── 5. Publish ────────────────────────────────────────────────────────

  /** Call on an interval (cron, Supabase scheduled function, …). */
  tick(): Promise<TickResult> {
    return runDue(this.store, this.adapters, this.now(), this.cfg.scheduler);
  }

  // ── helpers ───────────────────────────────────────────────────────────

  private requireAdapter(channel: Channel): ChannelAdapter {
    const a = this.adapters[channel];
    if (!a) throw new Error(`no adapter configured for ${channel}`);
    return a;
  }

  private async requireVariant(id: string): Promise<PostVariant> {
    const v = await this.store.getVariant(id);
    if (!v) throw new Error(`unknown variant ${id}`);
    return v;
  }
}
