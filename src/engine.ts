import { analyzeChannel, suggestTime, type ChannelInsights } from "./analyze.js";
import { CHANNEL_LABELS, CHANNEL_SPECS, validateVariant } from "./channels.js";
import { buildCarousel } from "./carousel/build.js";
import type { Brand } from "./carousel/render.js";
import { DEFAULT_SLIDES, MAX_SLIDES, MIN_SLIDES, type CarouselWriter } from "./carousel/write.js";
import type { Asset, AssetKind, Channel, ContentBrief, MediaJob, Memo, PostVariant, PublishedPost, TranscriptSegment } from "./domain.js";
import { DEFAULT_MEMO_IDEAS, MAX_MEMO_IDEAS, type MemoIdea, type MemoPlanner } from "./memo.js";
import { captionChunks, reelCut, snapSegments } from "./reel/align.js";
import type { ReelAudio, ReelRenderer } from "./reel/ffmpeg.js";
import { DEFAULT_BRAND } from "./carousel/render.js";
import type { Transcriber } from "./transcribe.js";
import { AdapterError, NotSupportedError, type ChannelAdapter, type FetchLike, type RemotePost } from "./adapters/types.js";
import type { ContentGenerator, GeneratedVariant } from "./generate.js";
import {
  buildImagePrompt,
  buildVideoPrompt,
  checkMonthlyCap,
  DEFAULT_MONTHLY_CAP_USD,
  DEFAULT_VIDEO_MODEL,
  findVideoModel,
  MediaCapReachedError,
  monthStartIso,
  VIDEO_MODELS,
  type ImageAspect,
  type ImageGenerator,
  type MediaStorage,
  type VideoGenerator,
} from "./media.js";
import { excerpt, type Notifier, type NotifyEvent } from "./notify.js";
import { runDue, type SchedulerOptions, type TickResult } from "./scheduler.js";
import type { Store } from "./store.js";

export interface EngineConfig {
  store: Store;
  adapters: Partial<Record<Channel, ChannelAdapter>>;
  generator: ContentGenerator;
  /** Paid video generation. Needs `mediaStorage` as well, so results outlive the provider's links. */
  videoGenerator?: VideoGenerator;
  mediaStorage?: MediaStorage;
  /** Paid image generation (synchronous). Also needs `mediaStorage`. */
  imageGenerator?: ImageGenerator;
  /** Writes carousels. Needs `mediaStorage` as well: the pages are drawn here and stored as public images. */
  carouselWriter?: CarouselWriter;
  /** Turns recordings into text. Needed for voice memos from audio. */
  transcriber?: Transcriber;
  /** Finds the ideas in a transcript. Needed for voice memos. */
  memoPlanner?: MemoPlanner;
  /** Channels voice-memo ideas are drafted for. Default: every configured channel. */
  memoChannels?: Channel[];
  /** Ideas per memo, 1 to 6. Default 3. */
  memoMaxIdeas?: number;
  /** Makes Reels (vertical video with the owner's voice) from voice memos. Needs `mediaStorage`, a timed transcript and the recording. */
  reelRenderer?: ReelRenderer;
  /** Longest Reel in seconds. Default 60. */
  reelMaxSeconds?: number;
  /** Fetches a memo's recording again (it is not kept). Memos transcribed in this same run need no fetching. */
  memoAudio?: (memo: Memo) => Promise<ReelAudio | undefined>;
  /** Colours and handle drawn on carousel pages and Reels. */
  brand?: Brand;
  /** Pause between safe retries of a video submission. Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Monthly spend limit for media generation, in USD. Default 50. */
  mediaMonthlyCapUsd?: number;
  fetch?: FetchLike;
  /** Tells the owner what happened (published, failed, drafts ready, …). Optional; a failing notifier never stops work. */
  notifier?: Notifier;
  /** Address of the review app; a tapped notification opens it. */
  appUrl?: string;
  /** How long a post may stay "publishing" (or a request "processing") before it is treated as abandoned. Default 30 minutes. */
  strandedAfterMs?: number;
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
  private readonly audioCache = new Map<string, ReelAudio>();

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

  private async saveAsset(kind: AssetKind, origin: Asset["origin"], uri: string, meta?: Record<string, unknown>) {
    const asset: Asset = { id: crypto.randomUUID(), kind, origin, uri, createdAt: this.now().toISOString(), meta };
    await this.store.putAsset(asset);
    return asset;
  }

  // ── Media generation (paid, asynchronous) ─────────────────────────────

  private async guardCap(estimateUsd: number) {
    const spentUsd = await this.store.mediaSpendUsd(monthStartIso(this.now()));
    const capUsd = this.cfg.mediaMonthlyCapUsd ?? DEFAULT_MONTHLY_CAP_USD;
    const guard = checkMonthlyCap({ spentUsd, capUsd, estimateUsd });
    if (!guard.allowed) throw new MediaCapReachedError(guard.message!);
    // Warn once, at the moment spending crosses 80 % of the cap — so it needs no stored state to avoid repeating.
    const warnAt = capUsd * 0.8 - 1e-9; // tolerance: 19 × 0.04 is not exactly 0.76 in floating point
    if (capUsd > 0 && spentUsd < warnAt && spentUsd + estimateUsd >= warnAt) {
      await this.tell({
        kind: "budget",
        title: "Mediataket närmar sig",
        message: `${(spentUsd + estimateUsd).toFixed(2)} av ${capUsd.toFixed(2)} USD använt denna månad (80 % eller mer).`,
      });
    }
  }

  /**
   * Generates an image (optionally based on a reference image), stores it durably and registers it as a generated
   * Asset. Counts against the same monthly cap as video; the job row is written before the provider is called.
   */
  async generateImage(input: { prompt: string; aspect?: ImageAspect; referenceImageUri?: string }): Promise<Asset> {
    const generator = this.cfg.imageGenerator;
    const storage = this.cfg.mediaStorage;
    if (!generator) throw new Error("no image generator configured (set GEMINI_API_KEY)");
    if (!storage) throw new Error("no media storage configured (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)");
    if (input.referenceImageUri && !input.referenceImageUri.startsWith("https://")) throw new Error("the reference image must be an https URL");

    const aspect = input.aspect ?? "4:5";
    const estimate = await generator.estimate({ aspect });
    await this.guardCap(estimate.usd);

    const job: MediaJob = {
      id: crypto.randomUUID(),
      kind: "image",
      provider: generator.provider,
      model: generator.model,
      prompt: buildImagePrompt(input.prompt, aspect, Boolean(input.referenceImageUri)),
      sourceImageUri: input.referenceImageUri,
      status: "in_progress",
      estimatedCostUsd: estimate.usd,
      createdAt: this.now().toISOString(),
    };
    await this.store.putMediaJob(job);

    try {
      let reference: { bytes: Uint8Array; mimeType: string } | undefined;
      if (input.referenceImageUri) {
        const res = await (this.cfg.fetch ?? fetch)(input.referenceImageUri);
        if (!res.ok) throw new Error(`could not download the reference image (HTTP ${res.status})`);
        reference = { bytes: new Uint8Array(await res.arrayBuffer()), mimeType: res.headers.get("content-type")?.split(";")[0] ?? "image/jpeg" };
      }
      const image = await generator.generate({ prompt: job.prompt, aspect, reference });
      const ext = image.mimeType.includes("jpeg") ? "jpg" : image.mimeType.includes("webp") ? "webp" : "png";
      const uri = await storage.put(`generated/${job.id}.${ext}`, image.bytes, image.mimeType);
      const asset: Asset = {
        id: job.id,
        kind: "image",
        origin: "generated",
        uri,
        createdAt: this.now().toISOString(),
        meta: { provider: job.provider, model: job.model, prompt: job.prompt, jobId: job.id, costUsd: image.actualCostUsd ?? estimate.usd },
      };
      await this.store.putAsset(asset);
      await this.store.putMediaJob({ ...job, status: "completed", assetId: asset.id, actualCostUsd: image.actualCostUsd, finishedAt: this.now().toISOString() });
      return asset;
    } catch (err) {
      await this.store.putMediaJob({ ...job, status: "failed", error: (err as Error).message, actualCostUsd: 0, finishedAt: this.now().toISOString() });
      throw err;
    }
  }

  /**
   * Starts a video generation. Refuses when the monthly cap would be exceeded. The job is saved before the
   * provider is called and its provider id right after, so a paid result can always be collected later.
   */
  async startVideo(input: { prompt: string; sourceImageUri?: string; model?: string }): Promise<MediaJob> {
    const generator = this.cfg.videoGenerator;
    if (!generator) throw new Error("no video generator configured (set HIGGSFIELD_API_KEY)");
    if (!this.cfg.mediaStorage) throw new Error("no media storage configured (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)");

    const model = findVideoModel(input.model ?? DEFAULT_VIDEO_MODEL);
    if (!model) throw new Error(`unknown video model "${input.model}". Known: ${VIDEO_MODELS.map((m) => m.id).join(", ")}`);
    if (model.mode === "image-to-video" && !input.sourceImageUri) {
      throw new Error(`${model.id} turns an image into a video: pass a source image (https URL)`);
    }
    if (input.sourceImageUri && !input.sourceImageUri.startsWith("https://")) throw new Error("the source image must be an https URL");

    const request = { model: model.id, prompt: buildVideoPrompt(input.prompt), sourceImageUri: input.sourceImageUri };
    const estimate = await generator.estimate(request);

    const now = this.now();
    await this.guardCap(estimate.usd);

    const job: MediaJob = {
      id: crypto.randomUUID(),
      kind: "video",
      provider: generator.provider,
      model: model.id,
      prompt: request.prompt,
      sourceImageUri: input.sourceImageUri,
      status: "queued",
      estimatedCostUsd: estimate.usd,
      createdAt: now.toISOString(),
    };
    await this.store.putMediaJob(job);

    try {
      // The job id is the idempotency key: after a timeout or 5xx we cannot know whether the provider accepted the
      // request, and resubmitting with the same key returns the original instead of creating (and charging) another.
      const sleep = this.cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      let providerJobId: string | undefined;
      for (let attempt = 1; providerJobId === undefined; attempt++) {
        try {
          providerJobId = (await generator.submit({ ...request, idempotencyKey: job.id })).providerJobId;
        } catch (err) {
          const permanent = err instanceof AdapterError && err.permanent;
          if (permanent || attempt >= 3) throw err;
          await sleep(attempt * 2000);
        }
      }
      job.providerJobId = providerJobId;
      job.status = "in_progress";
    } catch (err) {
      job.status = "failed";
      job.error = (err as Error).message;
      job.actualCostUsd = 0;
      job.finishedAt = this.now().toISOString();
      await this.store.putMediaJob(job);
      throw err;
    }
    await this.store.putMediaJob(job);
    return job;
  }

  /** Polls one job; when the provider is done, stores the file durably and registers it as a generated Asset. */
  async advanceJob(jobId: string): Promise<MediaJob> {
    const job = await this.store.getMediaJob(jobId);
    if (!job) throw new Error(`unknown media job ${jobId}`);
    if (job.status === "completed" || job.status === "failed") return job;

    const age = this.now().getTime() - new Date(job.createdAt).getTime();
    const finish = async (patch: Partial<MediaJob>) => {
      const done = { ...job, ...patch, finishedAt: this.now().toISOString() };
      await this.store.putMediaJob(done);
      return done;
    };

    if (job.kind === "image") {
      // Images finish inside generateImage. A row still open after a few minutes means the process died: nothing is stored.
      return age > 10 * 60_000 ? finish({ status: "failed", error: "interrupted before the image was stored", actualCostUsd: 0 }) : job;
    }

    const generator = this.cfg.videoGenerator;
    const storage = this.cfg.mediaStorage;
    if (!generator || !storage) throw new Error("video generation is not configured");

    if (!job.providerJobId) {
      // Saved but never submitted: nothing was charged. Give an in-flight start a few minutes before giving up.
      return age > 10 * 60_000 ? finish({ status: "failed", error: "never submitted to the provider", actualCostUsd: 0 }) : job;
    }

    const state = await generator.status(job.providerJobId);
    if (state.status === "failed") return finish({ status: "failed", error: state.error ?? "failed", actualCostUsd: 0 });
    if (state.status !== "completed") {
      if (age > 60 * 60_000) {
        // Cost is unknown, so the estimate keeps counting against the cap.
        return finish({ status: "failed", error: "timed out waiting for the provider" });
      }
      if (state.status !== job.status) {
        const updated = { ...job, status: state.status };
        await this.store.putMediaJob(updated);
        return updated;
      }
      return job;
    }
    if (!state.videoUrl?.startsWith("https://")) return finish({ status: "failed", error: "provider returned no video" });

    const res = await (this.cfg.fetch ?? fetch)(state.videoUrl);
    if (!res.ok) throw new Error(`could not download the generated video (HTTP ${res.status}); will retry`);
    const uri = await storage.put(`generated/${job.id}.mp4`, new Uint8Array(await res.arrayBuffer()), "video/mp4");

    // The asset reuses the job's id, so finishing the same job twice (after a crash) cannot create duplicates.
    await this.store.putAsset({
      id: job.id,
      kind: "video",
      origin: "generated",
      uri,
      createdAt: this.now().toISOString(),
      meta: { provider: job.provider, model: job.model, prompt: job.prompt, jobId: job.id, costUsd: state.actualCostUsd ?? job.estimatedCostUsd },
    });
    return finish({ status: "completed", assetId: job.id, actualCostUsd: state.actualCostUsd });
  }

  /** Advances every unfinished job. One failing job (e.g. a network blip) does not stop the others. */
  async advanceMedia(): Promise<{ completed: string[]; failed: string[]; pending: number; errors: string[] }> {
    const result = { completed: [] as string[], failed: [] as string[], pending: 0, errors: [] as string[] };
    for (const job of await this.store.listMediaJobs({ statuses: ["queued", "in_progress"] })) {
      try {
        const next = await this.advanceJob(job.id);
        if (next.status === "completed") result.completed.push(next.id);
        else if (next.status === "failed") result.failed.push(next.id);
        else result.pending++;
      } catch (err) {
        result.pending++;
        result.errors.push(`${job.id}: ${(err as Error).message}`);
      }
    }
    return result;
  }

  /** Polls until the job finishes or `timeoutMs` passes (the job keeps going; `tick` will collect it). */
  async waitForJob(jobId: string, opts: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<MediaJob> {
    const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + (opts.timeoutMs ?? 8 * 60_000);
    for (;;) {
      const job = await this.advanceJob(jobId);
      if (job.status === "completed" || job.status === "failed" || Date.now() >= deadline) return job;
      await sleep(opts.pollMs ?? 5_000);
    }
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
    const posts = await this.store.listPosts({ channel });
    if (posts.length === 0) return 0;

    // One or two requests for all posts where the adapter can (Buffer's free plan allows few requests), else one each.
    const batch = adapter.fetchMetricsBatch ? await adapter.fetchMetricsBatch(posts.map((p) => p.externalId)) : undefined;
    let updated = 0;
    for (const post of posts) {
      const metrics = batch ? batch.get(post.externalId) : await adapter.fetchMetrics(post.externalId);
      if (!metrics) continue;
      await this.store.upsertPost({ ...post, metrics });
      updated++;
    }
    return updated;
  }

  /**
   * For adapters that hand posts to a service which publishes later (Buffer): finds out which posts went live, with
   * their link, and which failed, with the reason. Only recent hand-overs are asked about, so a quiet account costs
   * no requests.
   */
  async reconcileHandoffs(): Promise<{ sent: string[]; failed: string[] }> {
    const result = { sent: [] as string[], failed: [] as string[] };
    const cutoff = this.now().getTime() - 6 * 3_600_000;
    const open = (await this.store.listVariants({ status: "published" })).filter(
      (v) => !v.url && v.externalId && v.publishedAt && new Date(v.publishedAt).getTime() > cutoff,
    );

    for (const channel of new Set(open.map((v) => v.channel))) {
      const adapter = this.adapters[channel];
      if (!adapter?.reconcile) continue;
      const mine = open.filter((v) => v.channel === channel);
      let states: Awaited<ReturnType<NonNullable<ChannelAdapter["reconcile"]>>>;
      try {
        states = await adapter.reconcile(mine.map((v) => v.externalId!));
      } catch {
        continue; // try again next run; nothing is lost by asking later
      }
      for (const v of mine) {
        const st = states.get(v.externalId!);
        if (st?.state === "sent" && st.url) {
          await this.store.putVariant({ ...v, url: st.url });
          const post = (await this.store.listPosts({ channel })).find((p) => p.externalId === v.externalId);
          if (post) await this.store.upsertPost({ ...post, url: st.url });
          result.sent.push(v.id);
        } else if (st?.state === "error") {
          await this.store.putVariant({ ...v, status: "failed", lastError: `Buffer kunde inte publicera: ${st.error ?? "okänt fel"}` });
          result.failed.push(v.id);
        }
      }
    }
    return result;
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
    format?: ContentBrief["format"];
    ctaKeyword?: string;
    memoId?: string;
  }): Promise<ContentBrief> {
    const brief: ContentBrief = {
      id: crypto.randomUUID(),
      idea: input.idea,
      angle: input.angle,
      goal: input.goal,
      sourcePostIds: input.sourcePostIds ?? [],
      assetIds: input.assetIds ?? [],
      format: input.format,
      ctaKeyword: input.ctaKeyword,
      memoId: input.memoId,
      status: "ready",
      createdAt: this.now().toISOString(),
    };
    await this.store.putBrief(brief);
    return brief;
  }

  /** Generate one variant per channel. Lands in the review queue unless the channel is in `autoApprove`. */
  async proposeVariants(briefId: string, channels: Channel[], opts: { assetIds?: string[] } = {}): Promise<PostVariant[]> {
    const brief = await this.store.getBrief(briefId);
    if (!brief) throw new Error(`unknown brief ${briefId}`);

    const [insights, assets] = await Promise.all([this.analyze(channels), this.store.getAssets(brief.assetIds)]);
    const examples = await this.pickExamples(brief, insights);

    const generated = await this.cfg.generator.generate({ brief, channels, insights, examples, assets });
    return this.saveDrafts(briefId, opts.assetIds ? generated.map((g) => ({ ...g, assetIds: opts.assetIds! })) : generated, insights);
  }

  /** Stores generated variants as drafts, or schedules them right away for channels in `autoApprove` when they are valid. */
  private async saveDrafts(briefId: string, generated: GeneratedVariant[], insights: Partial<Record<Channel, ChannelInsights>>): Promise<PostVariant[]> {
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

  /**
   * Writes a carousel for the brief, draws every page as a JPEG, stores the pages as public images and drafts one
   * variant per channel (the caption plus the pages). Only channels that take at least four images are used.
   */
  async createCarousel(briefId: string, channels: Channel[], opts: { slideCount?: number; keyword?: string } = {}): Promise<PostVariant[]> {
    const writer = this.cfg.carouselWriter;
    if (!writer) throw new Error("no carousel writer is configured (ANTHROPIC_API_KEY is needed)");
    const storage = this.cfg.mediaStorage;
    if (!storage) throw new Error("carousels need public storage (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)");
    const brief = await this.store.getBrief(briefId);
    if (!brief) throw new Error(`unknown brief ${briefId}`);

    const usable = channels.filter((c) => CHANNEL_SPECS[c].media.includes("image") && CHANNEL_SPECS[c].maxAssets >= MIN_SLIDES);
    if (usable.length === 0) throw new Error(`a carousel needs a channel that takes at least ${MIN_SLIDES} images; ${channels.map((c) => CHANNEL_LABELS[c]).join(", ")} does not`);
    const cap = Math.min(MAX_SLIDES, ...usable.map((c) => CHANNEL_SPECS[c].maxAssets));
    const slideCount = Math.max(MIN_SLIDES, Math.min(opts.slideCount ?? DEFAULT_SLIDES, cap));

    const [insights, assets] = await Promise.all([this.analyze(usable), this.store.getAssets(brief.assetIds)]);
    const examples = await this.pickExamples(brief, insights);
    const built = await buildCarousel({
      writer,
      input: { brief, channels: usable, insights, examples, assets, slideCount, keyword: opts.keyword ?? brief.ctaKeyword },
      brand: this.cfg.brand,
      fetch: this.cfg.fetch,
    });

    const run = crypto.randomUUID().slice(0, 8);
    const pageIds: string[] = [];
    for (let i = 0; i < built.images.length; i++) {
      const slide = built.slides[i]!;
      const uri = await storage.put(`carousels/${briefId}/${run}-${i + 1}.jpg`, built.images[i]!, "image/jpeg");
      const asset = await this.saveAsset("image", "generated", uri, { source: "carousel", briefId, page: i + 1, kind: slide.kind, title: slide.title });
      pageIds.push(asset.id);
    }

    const rationale = [`Karusell, ${pageIds.length} sidor`, ...built.notes].join(". ");
    const generated = usable.map<GeneratedVariant>((channel) => ({
      channel,
      text: built.captions.find((c) => c.channel === channel)?.text ?? built.slides[0]!.title,
      assetIds: pageIds,
      rationale,
    }));
    return this.saveDrafts(briefId, generated, insights);
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

  // ── Voice memos ───────────────────────────────────────────────────────

  /**
   * Transcribes a recording and keeps the transcript (never the audio). The same Drive file is never transcribed twice.
   * A format or size the transcriber can never accept is recorded as a failed memo, so it is not retried every run;
   * a temporary error is thrown, and nothing is recorded, so the next run tries again.
   */
  async addMemoFromAudio(input: { name: string; bytes: Uint8Array; mimeType: string; driveFileId?: string }): Promise<Memo> {
    if (input.driveFileId) {
      const existing = await this.store.getMemoByDriveFile(input.driveFileId);
      if (existing) return existing;
    }
    const transcriber = this.cfg.transcriber;
    if (!transcriber) throw new Error("no transcriber is configured (GEMINI_API_KEY is needed to turn recordings into text)");
    let transcript: string;
    let segments: TranscriptSegment[] = [];
    try {
      const audio = { bytes: input.bytes, mimeType: input.mimeType, name: input.name };
      if (this.cfg.reelRenderer && transcriber.transcribeDetailed) {
        const detailed = await transcriber.transcribeDetailed(audio);
        transcript = detailed.text.trim();
        segments = detailed.segments;
      } else {
        transcript = (await transcriber.transcribe(audio)).trim();
      }
    } catch (err) {
      if (!(err instanceof AdapterError) || !err.permanent) throw err;
      return this.saveMemo({ source: input.driveFileId ? "drive" : "cli", driveFileId: input.driveFileId, name: input.name, status: "failed", error: err.message.slice(0, 500) });
    }
    if (!transcript) return this.saveMemo({ source: input.driveFileId ? "drive" : "cli", driveFileId: input.driveFileId, name: input.name, status: "failed", error: "no speech was found in the recording" });
    const memo = await this.saveMemo({ source: input.driveFileId ? "drive" : "cli", driveFileId: input.driveFileId, name: input.name, transcript, segments: segments.length > 0 ? segments : undefined, status: "transcribed" });
    // Kept in memory for this run only, so a Reel can be made without fetching the recording again.
    if (segments.length > 0) this.audioCache.set(memo.id, { bytes: input.bytes, mimeType: input.mimeType, name: input.name });
    return memo;
  }

  /** A memo from text you already have (dictated, pasted or exported from a notes app). */
  async addMemoFromText(input: { name: string; transcript: string }): Promise<Memo> {
    const transcript = input.transcript.trim();
    if (transcript.length < 40) throw new Error("the text is too short to find ideas in (at least 40 characters)");
    return this.saveMemo({ source: "cli", name: input.name, transcript, status: "transcribed" });
  }

  private async saveMemo(m: Pick<Memo, "source" | "name" | "status"> & Partial<Memo>): Promise<Memo> {
    const memo: Memo = { id: crypto.randomUUID(), attempts: 0, ideaCount: 0, createdAt: this.now().toISOString(), ...m };
    await this.store.putMemo(memo);
    return memo;
  }

  private async audioFor(memo: Memo): Promise<ReelAudio | undefined> {
    return this.audioCache.get(memo.id) ?? (await this.cfg.memoAudio?.(memo));
  }

  /**
   * Makes a Reel of a stretch of a voice memo: the owner's own voice, a headline, captions and key-point cards, on a sound
   * wave or on the brief's photos. Stores the video as a public file and drafts a caption for every channel that takes video.
   */
  async createReel(briefId: string, memo: Memo, plan: Pick<MemoIdea, "hook" | "from" | "to" | "cards">, channels: Channel[]): Promise<PostVariant[]> {
    const renderer = this.cfg.reelRenderer;
    if (!renderer) throw new Error("no Reel renderer is configured");
    const storage = this.cfg.mediaStorage;
    if (!storage) throw new Error("Reels need public storage (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)");
    if (!memo.segments?.length) throw new Error("the memo has no timed transcript");
    const brief = await this.store.getBrief(briefId);
    if (!brief) throw new Error(`unknown brief ${briefId}`);
    const usable = channels.filter((c) => CHANNEL_SPECS[c].media.includes("video"));
    if (usable.length === 0) throw new Error(`none of the channels takes video (${channels.map((c) => CHANNEL_LABELS[c]).join(", ")})`);
    const audio = await this.audioFor(memo);
    if (!audio) throw new Error("the recording is no longer available (it is fetched from Drive)");

    const { duration, silences } = await renderer.analyse(audio);
    const snapped = snapSegments(memo.segments, silences, duration);
    const cut = reelCut(snapped, plan.from ?? 0, plan.to ?? 0, this.cfg.reelMaxSeconds ?? 60, duration);
    if (!cut) throw new Error("the chosen stretch of the recording is out of range, too short or too long for a Reel");

    // Each card shows from the segment where its point begins until the next card's, or the end.
    const inCut = (plan.cards ?? []).filter((c) => c.at - 1 >= cut.from && c.at - 1 <= cut.to);
    const cards = inCut.map((c, i) => ({ start: snapped[c.at - 1]!.start, end: inCut[i + 1] ? snapped[inCut[i + 1]!.at - 1]!.start : cut.end, title: c.title, body: c.body }));
    const assets = await this.store.getAssets(brief.assetIds);
    const photos = (await Promise.all(assets.filter((a) => a.kind === "image" && a.uri.startsWith("https://")).slice(0, 4).map((a) => this.fetchPhoto(a.uri)))).filter((p): p is { bytes: Uint8Array } => p !== undefined);

    const mp4 = await renderer.render({ audio, start: cut.start, end: cut.end, hook: plan.hook ?? brief.idea.slice(0, 80), captions: captionChunks(cut.segments), cards, photos, brand: this.cfg.brand ?? DEFAULT_BRAND });
    if (mp4.length > 45 * 1024 * 1024) throw new Error("the finished video is larger than 45 MB");
    const run = crypto.randomUUID().slice(0, 8);
    const uri = await storage.put(`reels/${briefId}/${run}.mp4`, mp4, "video/mp4");
    const video = await this.saveAsset("video", "generated", uri, { source: "reel", memoId: memo.id, seconds: Math.round(cut.end - cut.start), from: cut.from + 1, to: cut.to + 1 });
    await this.store.putBrief({ ...brief, assetIds: [...brief.assetIds, video.id] });
    return this.proposeVariants(briefId, usable, { assetIds: [video.id] });
  }

  private async fetchPhoto(uri: string): Promise<{ bytes: Uint8Array } | undefined> {
    try {
      const res = await (this.cfg.fetch ?? fetch)(uri);
      if (!res.ok) return undefined;
      const bytes = new Uint8Array(await res.arrayBuffer());
      const isImage = (bytes[0] === 0xff && bytes[1] === 0xd8) || (bytes[0] === 0x89 && bytes[1] === 0x50);
      return isImage && bytes.length <= 8 * 1024 * 1024 ? { bytes } : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Finds the ideas in a memo's transcript and drafts them (a carousel for lists and explanations, a post otherwise).
   * Everything lands in the review queue. A memo that could not be drafted stays open and is tried again by the next run,
   * up to three times.
   */
  async planMemo(memoId: string): Promise<{ memo: Memo; drafts: PostVariant[]; errors: string[] } | undefined> {
    const claimed = await this.store.transitionMemo(memoId, "transcribed", "planning");
    if (!claimed) return undefined;
    const errors: string[] = [];
    const drafts: PostVariant[] = [];
    let ideas = 0;
    try {
      const planner = this.cfg.memoPlanner;
      if (!planner) throw new Error("no memo planner is configured (ANTHROPIC_API_KEY is needed)");
      if (!claimed.transcript) throw new Error("the memo has no transcript");
      const channels = this.cfg.memoChannels ?? (Object.keys(this.adapters) as Channel[]);
      if (channels.length === 0) throw new Error("no channels to draft for (configure a channel, or set MEMO_CHANNELS)");
      const maxIdeas = Math.min(Math.max(this.cfg.memoMaxIdeas ?? DEFAULT_MEMO_IDEAS, 1), MAX_MEMO_IDEAS);

      const insights = await this.analyze(channels);
      const examples = await this.pickExamples({ id: "memo", idea: claimed.transcript.slice(0, 300), sourcePostIds: [], assetIds: [], createdAt: claimed.createdAt }, insights);
      const reelsPossible = Boolean(this.cfg.reelRenderer && this.cfg.mediaStorage && claimed.segments?.length && (this.audioCache.has(claimed.id) || this.cfg.memoAudio));
      const maxReelSeconds = this.cfg.reelMaxSeconds ?? 60;
      const planned = await planner.plan({ transcript: claimed.transcript, maxIdeas, channels, examples, segments: reelsPossible ? claimed.segments : undefined, allowReels: reelsPossible, maxReelSeconds });

      for (const idea of planned) {
        const carousel = idea.format === "carousel" && this.cfg.carouselWriter && this.cfg.mediaStorage;
        const reel = idea.format === "reel" && reelsPossible;
        const brief = await this.createBrief({ idea: idea.idea, angle: idea.angle, format: reel ? "reel" : carousel ? "carousel" : "post", ctaKeyword: carousel ? idea.keyword : undefined, memoId: claimed.id });
        try {
          let made: PostVariant[];
          if (reel) {
            try {
              made = await this.createReel(brief.id, claimed, idea, channels);
            } catch (err) {
              // A Reel that cannot be made is not lost: its idea becomes an ordinary post, and the note says why.
              errors.push(`${idea.title}: Reel kunde inte skapas (${(err as Error).message.slice(0, 160)}), gjorde ett inlägg i stället`);
              await this.store.putBrief({ ...brief, format: "post" });
              made = await this.proposeVariants(brief.id, channels);
            }
          } else {
            made = carousel ? await this.createCarousel(brief.id, channels) : await this.proposeVariants(brief.id, channels);
          }
          if (made.length === 0) throw new Error("the generator returned no drafts");
          drafts.push(...made);
          ideas++;
        } catch (err) {
          const message = (err as Error).message.slice(0, 300);
          errors.push(`${idea.title}: ${message}`);
          await this.store.putBrief({ ...brief, status: "failed", error: message });
        }
      }
      if (planned.length > 0 && ideas === 0) throw new Error(errors.join("; "));

      const memo: Memo = { ...claimed, status: "planned", ideaCount: ideas, error: planned.length === 0 ? "the memo held no idea worth publishing" : errors.length ? errors.join("; ").slice(0, 500) : undefined };
      await this.store.putMemo(memo);
      return { memo, drafts, errors };
    } catch (err) {
      const attempts = claimed.attempts + 1;
      const memo: Memo = { ...claimed, status: attempts >= 3 ? "failed" : "transcribed", attempts, error: (err as Error).message.slice(0, 500) };
      await this.store.putMemo(memo);
      return { memo, drafts, errors: [...errors, memo.error ?? "unknown error"] };
    }
  }

  /** Drafts every memo that is waiting, and puts back any that a worker abandoned while planning. */
  async processMemos(): Promise<{ planned: string[]; failed: string[]; drafts: number }> {
    const result = { planned: [] as string[], failed: [] as string[], drafts: 0 };
    const stale = this.now().getTime() - (this.cfg.strandedAfterMs ?? 30 * 60_000);
    for (const m of await this.store.listMemos({ status: "planning" })) {
      if (m.claimedAt && new Date(m.claimedAt).getTime() < stale) await this.store.putMemo({ ...m, status: "transcribed", attempts: m.attempts + 1, claimedAt: undefined, error: "planning was interrupted" });
    }
    for (const m of await this.store.listMemos({ status: "transcribed" })) {
      const done = await this.planMemo(m.id);
      if (!done) continue;
      if (done.memo.status === "planned" && done.memo.ideaCount > 0) {
        result.planned.push(m.id);
        result.drafts += done.drafts.length;
        await this.tell({ kind: "memo", title: done.drafts.length === 1 ? "Röstmemo klart: 1 utkast väntar" : `Röstmemo klart: ${done.drafts.length} utkast väntar`, message: `${excerpt(m.name, 60)}\n${done.memo.ideaCount} idé(er) blev utkast.`, url: this.cfg.appUrl });
      } else if (done.memo.status === "planned") {
        result.planned.push(m.id);
        await this.tell({ kind: "memo", title: "Röstmemot gav inga idéer", message: `${excerpt(m.name, 60)}\nInget i det var värt att publicera.` });
      } else if (done.memo.status === "failed") {
        result.failed.push(m.id);
        await this.tell({ kind: "memo", title: "Röstmemot kunde inte göras till utkast", message: `${excerpt(m.name, 60)}\n${excerpt(done.memo.error ?? "okänt fel", 200)}` });
      }
    }
    return result;
  }

  // ── 5. Publish ────────────────────────────────────────────────────────

  /**
   * Turns requests made in the review app into drafts. A request is claimed atomically, so overlapping runs cannot
   * draft it twice. A failure is written back to the request so it shows up in the app.
   */
  async processBriefRequests(): Promise<{ processed: string[]; failed: string[] }> {
    const result = { processed: [] as string[], failed: [] as string[] };
    for (const request of await this.store.listBriefs({ status: "requested" })) {
      const claimed = await this.store.transitionBrief(request.id, "requested", "processing");
      if (!claimed) continue;
      try {
        if (!claimed.channels?.length) throw new Error("the request has no channels");
        const drafts = claimed.format === "carousel" ? await this.createCarousel(claimed.id, claimed.channels) : await this.proposeVariants(claimed.id, claimed.channels);
        if (drafts.length === 0) throw new Error("the generator returned no drafts");
        await this.store.putBrief({ ...claimed, status: "ready", error: undefined });
        result.processed.push(claimed.id);
      } catch (err) {
        await this.store.putBrief({ ...claimed, status: "failed", error: (err as Error).message.slice(0, 500) });
        result.failed.push(claimed.id);
      }
    }
    return result;
  }

  /** Call on an interval: publishes what is due, drafts what was requested, and collects finished media. */
  async tick(): Promise<
    TickResult & {
      requests: Awaited<ReturnType<ContentEngine["processBriefRequests"]>>;
      media?: Awaited<ReturnType<ContentEngine["advanceMedia"]>>;
      recovered?: Awaited<ReturnType<ContentEngine["recoverStranded"]>>;
      notifyErrors?: string[];
    }
  > {
    this.notifyErrors = [];
    const recovered = await this.recoverStranded();
    const published = await runDue(this.store, this.adapters, this.now(), this.cfg.scheduler);
    const reconciled = await this.reconcileHandoffs();
    published.failed.push(...reconciled.failed);
    const requests = await this.processBriefRequests();
    const media = (this.cfg.videoGenerator || this.cfg.imageGenerator) && this.cfg.mediaStorage ? await this.advanceMedia() : undefined;

    await this.announce(published, requests, media, recovered);

    const found = recovered.variants.length || recovered.briefs.length ? { recovered } : {};
    const result = media ? { ...published, requests, media, ...found } : { ...published, requests, ...found };
    return this.notifyErrors.length ? { ...result, notifyErrors: this.notifyErrors } : result;
  }

  // ── recovery ──────────────────────────────────────────────────────────

  /**
   * Finds work claimed by a worker that never finished (killed run, crash). A post is NEVER published again
   * automatically: it may have gone out before the worker died. It is marked failed with an explanation instead, so
   * it shows up in the app and you decide after checking the platform. An abandoned request is marked failed too.
   */
  async recoverStranded(): Promise<{ variants: string[]; briefs: string[] }> {
    const limit = this.cfg.strandedAfterMs ?? 30 * 60_000;
    const cutoff = this.now().getTime() - limit;
    const result = { variants: [] as string[], briefs: [] as string[] };

    for (const v of await this.store.listVariants({ status: "publishing" })) {
      if (new Date(v.claimedAt ?? v.createdAt).getTime() > cutoff) continue;
      // Compare-and-swap: if the worker finished in the meantime, leave it alone.
      const moved = await this.store.transitionVariant(v.id, "publishing", "failed");
      if (!moved) continue;
      await this.store.putVariant({
        ...moved,
        status: "failed",
        lastError: "Avbröts under publicering. Kontrollera på plattformen om inlägget syns. Om det inte gör det: tryck Försök igen.",
      });
      result.variants.push(v.id);
    }

    for (const b of await this.store.listBriefs({ status: "processing" })) {
      if (new Date(b.claimedAt ?? b.createdAt).getTime() > cutoff) continue;
      const moved = await this.store.transitionBrief(b.id, "processing", "failed");
      if (!moved) continue;
      await this.store.putBrief({ ...moved, status: "failed", error: "Avbröts innan utkasten var klara. Beställ igen." });
      result.briefs.push(b.id);
    }
    return result;
  }

  // ── notifications ─────────────────────────────────────────────────────

  private notifyErrors: string[] = [];

  /** Sends one notification; a failure is recorded, never thrown. */
  private async tell(event: NotifyEvent): Promise<void> {
    if (!this.cfg.notifier) return;
    try {
      await this.cfg.notifier.notify({ ...event, url: event.url ?? this.cfg.appUrl });
    } catch (err) {
      this.notifyErrors.push((err as Error).message);
    }
  }

  /** One message per kind of event, so ten posts in one run are one buzz, not ten. */
  private async announce(
    published: TickResult,
    requests: { processed: string[]; failed: string[] },
    media?: { completed: string[]; failed: string[] },
    recovered?: { variants: string[]; briefs: string[] },
  ): Promise<void> {
    if (!this.cfg.notifier) return;
    const label = (c: Channel) => CHANNEL_LABELS[c] ?? c;

    if (recovered?.variants.length) {
      const vs = (await Promise.all(recovered.variants.map((id) => this.store.getVariant(id)))).filter((v): v is PostVariant => !!v);
      await this.tell({
        kind: "stranded",
        title: vs.length === 1 ? "Ett inlägg fastnade" : `${vs.length} inlägg fastnade`,
        message: `${vs.map((v) => `${label(v.channel)}: ${excerpt(v.text, 50)}`).join("\n")}\nKolla på plattformen om det syns innan du försöker igen.`,
      });
    }
    if (recovered?.briefs.length) {
      await this.tell({ kind: "stranded", title: "En beställning avbröts", message: "Beställ igen i appen." });
    }

    if (published.published.length) {
      const vs = (await Promise.all(published.published.map((id) => this.store.getVariant(id)))).filter((v): v is PostVariant => !!v);
      await this.tell({
        kind: "published",
        title: vs.length === 1 ? `Publicerat på ${label(vs[0]!.channel)}` : `${vs.length} inlägg publicerade`,
        message: vs.map((v) => `${label(v.channel)}: ${excerpt(v.text)}`).join("\n"),
        url: vs.length === 1 ? vs[0]!.url : undefined,
      });
    }

    for (const id of published.failed) {
      const v = await this.store.getVariant(id);
      if (!v) continue;
      await this.tell({ kind: "failed", title: `Misslyckades på ${label(v.channel)}`, message: `${excerpt(v.text, 60)}\n${excerpt(v.lastError ?? "okänt fel", 200)}` });
    }

    const briefs = (await Promise.all(requests.processed.map((id) => this.store.getBrief(id)))).filter((b): b is ContentBrief => !!b);
    let drafts = 0;
    for (const b of briefs) drafts += (await this.store.listVariants({ briefId: b.id, status: "draft" })).length;
    if (briefs.length && drafts) {
      await this.tell({ kind: "drafts_ready", title: drafts === 1 ? "1 nytt utkast väntar" : `${drafts} nya utkast väntar`, message: briefs.map((b) => `Idé: ${excerpt(b.idea)}`).join("\n") });
    }

    for (const id of requests.failed) {
      const b = await this.store.getBrief(id);
      if (b) await this.tell({ kind: "request_failed", title: "Beställningen misslyckades", message: `${excerpt(b.idea, 60)}\n${excerpt(b.error ?? "okänt fel", 200)}` });
    }

    if (media?.completed.length) await this.tell({ kind: "media", title: media.completed.length === 1 ? "Media klar" : `${media.completed.length} media klara`, message: "Finns nu i materialet i Skapa." });
    if (media?.failed.length) await this.tell({ kind: "media", title: "Media misslyckades", message: `${media.failed.length} jobb misslyckades. Se Check setup eller loggen.` });
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
