import { analyzeChannel, suggestTime, type ChannelInsights } from "./analyze.js";
import { CHANNEL_LABELS, validateVariant } from "./channels.js";
import type { Asset, AssetKind, Channel, ContentBrief, MediaJob, PostVariant, PublishedPost } from "./domain.js";
import { NotSupportedError, type ChannelAdapter, type FetchLike, type RemotePost } from "./adapters/types.js";
import type { ContentGenerator } from "./generate.js";
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
  /** Monthly spend limit for media generation, in USD. Default 50. */
  mediaMonthlyCapUsd?: number;
  fetch?: FetchLike;
  /** Tells the owner what happened (published, failed, drafts ready, …). Optional; a failing notifier never stops work. */
  notifier?: Notifier;
  /** Address of the review app; a tapped notification opens it. */
  appUrl?: string;
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
      const { providerJobId } = await generator.submit(request);
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
      status: "ready",
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
        const drafts = await this.proposeVariants(claimed.id, claimed.channels);
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
      notifyErrors?: string[];
    }
  > {
    this.notifyErrors = [];
    const published = await runDue(this.store, this.adapters, this.now(), this.cfg.scheduler);
    const requests = await this.processBriefRequests();
    const media = (this.cfg.videoGenerator || this.cfg.imageGenerator) && this.cfg.mediaStorage ? await this.advanceMedia() : undefined;

    await this.announce(published, requests, media);

    const result = media ? { ...published, requests, media } : { ...published, requests };
    return this.notifyErrors.length ? { ...result, notifyErrors: this.notifyErrors } : result;
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
  ): Promise<void> {
    if (!this.cfg.notifier) return;
    const label = (c: Channel) => CHANNEL_LABELS[c] ?? c;

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
