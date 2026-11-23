import { GeminiImageGenerator } from "../adapters/gemini-image.js";
import { BufferAdapter } from "../adapters/buffer.js";
import { GoogleDriveSource } from "../adapters/google-drive.js";
import { FacebookAdapter } from "../adapters/facebook.js";
import { HiggsfieldVideoGenerator } from "../adapters/higgsfield.js";
import { InstagramAdapter } from "../adapters/instagram.js";
import { LinkedInAdapter } from "../adapters/linkedin.js";
import { SupabaseStorage } from "../adapters/supabase-storage.js";
import type { ChannelAdapter, FetchLike } from "../adapters/types.js";
import { CHANNELS, type Channel } from "../domain.js";
import { ContentEngine } from "../engine.js";
import { brandFromEnv } from "../carousel/build.js";
import { ClaudeCarouselWriter } from "../carousel/write.js";
import { ClaudeContentGenerator, type ContentGenerator } from "../generate.js";
import { ClaudeMemoPlanner } from "../memo.js";
import { FfmpegReelRenderer } from "../reel/ffmpeg.js";
import { audioMime, GeminiTranscriber } from "../transcribe.js";
import { WebhookNotifier, type Notifier, type WebhookFormat } from "../notify.js";
import type { Store } from "../store.js";

export type Env = Record<string, string | undefined>;

/** `linkedin=abc123,instagram=def456` (and the shorthand BUFFER_LINKEDIN_CHANNEL_ID) → channel/id pairs. */
export function parseBufferChannels(env: Env): Array<[Channel, string]> {
  const pairs = new Map<Channel, string>();
  for (const part of (env.BUFFER_CHANNELS ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const [name, id, ...rest] = part.split("=").map((x) => x.trim());
    if (!name || !id || rest.length) throw new Error(`BUFFER_CHANNELS: expected channel=id, got "${part}"`);
    if (!(CHANNELS as readonly string[]).includes(name)) throw new Error(`BUFFER_CHANNELS: unknown channel "${name}"`);
    pairs.set(name as Channel, id);
  }
  if (env.BUFFER_LINKEDIN_CHANNEL_ID && !pairs.has("linkedin")) pairs.set("linkedin", env.BUFFER_LINKEDIN_CHANNEL_ID.trim());
  return [...pairs];
}

/** Drive photos/videos source, when `GOOGLE_SERVICE_ACCOUNT_JSON` and `DRIVE_FOLDER_ID` are set. */
export function buildDrive(env: Env, opts: { fetch?: FetchLike; now?: () => Date } = {}): GoogleDriveSource | undefined {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON || !env.DRIVE_FOLDER_ID) return undefined;
  return new GoogleDriveSource({ serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON, folderId: env.DRIVE_FOLDER_ID.trim(), fetch: opts.fetch, now: opts.now });
}

/** Public media storage (Supabase), when configured. */
export function buildStorage(env: Env, opts: { fetch?: FetchLike } = {}): SupabaseStorage | undefined {
  return env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
    ? new SupabaseStorage({ url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY, bucket: env.SOCIAL_MEDIA_BUCKET, fetch: opts.fetch })
    : undefined;
}

/** `MEMO_CHANNELS=linkedin,instagram`: where voice-memo ideas are drafted. Unset means every configured channel. */
export function memoChannels(env: Env): Channel[] | undefined {
  const names = (env.MEMO_CHANNELS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) return undefined;
  for (const n of names) if (!(CHANNELS as readonly string[]).includes(n)) throw new Error(`MEMO_CHANNELS: unknown channel "${n}"`);
  return names as Channel[];
}

export interface Wiring {
  engine: ContentEngine;
  configuredChannels: Channel[];
  notifier?: Notifier;
}

/** Builds the engine from environment variables. A channel is enabled when its credentials are present. */
export function buildEngine(env: Env, store: Store, opts: { fetch?: FetchLike; now?: () => Date; sleep?: (ms: number) => Promise<void> } = {}): Wiring {
  const adapters: Partial<Record<Channel, ChannelAdapter>> = {};

  if (env.INSTAGRAM_USER_ID && env.INSTAGRAM_ACCESS_TOKEN) {
    adapters.instagram = new InstagramAdapter({ igUserId: env.INSTAGRAM_USER_ID, accessToken: env.INSTAGRAM_ACCESS_TOKEN, fetch: opts.fetch });
  }
  if (env.FACEBOOK_PAGE_ID && env.FACEBOOK_PAGE_ACCESS_TOKEN) {
    adapters.facebook = new FacebookAdapter({ pageId: env.FACEBOOK_PAGE_ID, accessToken: env.FACEBOOK_PAGE_ACCESS_TOKEN, fetch: opts.fetch });
  }
  if (env.LINKEDIN_AUTHOR_URN && env.LINKEDIN_ACCESS_TOKEN) {
    adapters.linkedin = new LinkedInAdapter({ authorUrn: env.LINKEDIN_AUTHOR_URN, accessToken: env.LINKEDIN_ACCESS_TOKEN, apiVersion: env.LINKEDIN_API_VERSION, fetch: opts.fetch });
  }

  // Buffer takes over the channels it is configured for: `BUFFER_CHANNELS=linkedin=<channel id>,instagram=<channel id>`.
  if (env.BUFFER_API_KEY) {
    for (const [channel, channelId] of parseBufferChannels(env)) {
      adapters[channel] = new BufferAdapter({ apiKey: env.BUFFER_API_KEY, channelId, channel, fetch: opts.fetch });
    }
  }

  const generator: ContentGenerator = env.ANTHROPIC_API_KEY
    ? new ClaudeContentGenerator({ apiKey: env.ANTHROPIC_API_KEY, model: env.CLAUDE_MODEL, fetch: opts.fetch })
    : {
        generate: async () => {
          throw new Error("ANTHROPIC_API_KEY is not set; cannot generate content");
        },
      };

  const autoApprove = (env.AUTO_APPROVE_CHANNELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((c) => {
      if (!(CHANNELS as readonly string[]).includes(c)) throw new Error(`AUTO_APPROVE_CHANNELS: unknown channel "${c}"`);
      return c as Channel;
    });

  const cap = env.MEDIA_MONTHLY_CAP_USD ? Number(env.MEDIA_MONTHLY_CAP_USD) : undefined;
  if (cap !== undefined && !(cap >= 0)) throw new Error(`MEDIA_MONTHLY_CAP_USD must be a number, got "${env.MEDIA_MONTHLY_CAP_USD}"`);

  const memoIdeas = env.MEMO_MAX_IDEAS ? Number(env.MEMO_MAX_IDEAS) : undefined;
  if (memoIdeas !== undefined && !(Number.isInteger(memoIdeas) && memoIdeas >= 1 && memoIdeas <= 6)) throw new Error(`MEMO_MAX_IDEAS must be a whole number from 1 to 6, got "${env.MEMO_MAX_IDEAS}"`);

  const reelSeconds = env.REEL_MAX_SECONDS ? Number(env.REEL_MAX_SECONDS) : undefined;
  if (reelSeconds !== undefined && !(Number.isInteger(reelSeconds) && reelSeconds >= 10 && reelSeconds <= 180)) throw new Error(`REEL_MAX_SECONDS must be a whole number from 10 to 180, got "${env.REEL_MAX_SECONDS}"`);

  // A memo's recording is not kept; a Reel fetches it from Drive again when it is made later than the transcription.
  let drive: ReturnType<typeof buildDrive>;
  try {
    drive = buildDrive(env, { fetch: opts.fetch, now: opts.now });
  } catch {
    drive = undefined; // a broken Drive setup is reported by `doctor` and `drive-sync`, and must not stop publishing
  }

  const formats: WebhookFormat[] = ["ntfy", "slack", "discord", "json"];
  if (env.NOTIFY_FORMAT && !formats.includes(env.NOTIFY_FORMAT as WebhookFormat)) {
    throw new Error(`NOTIFY_FORMAT must be one of ${formats.join(", ")}, got "${env.NOTIFY_FORMAT}"`);
  }
  const notifier = env.NOTIFY_URL ? new WebhookNotifier({ url: env.NOTIFY_URL, format: env.NOTIFY_FORMAT as WebhookFormat | undefined, fetch: opts.fetch }) : undefined;

  return {
    notifier,
    engine: new ContentEngine({
      store,
      adapters,
      generator,
      transcriber: env.GEMINI_API_KEY ? new GeminiTranscriber({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_TRANSCRIBE_MODEL, apiRevision: env.GEMINI_API_REVISION, fetch: opts.fetch }) : undefined,
      memoPlanner: env.ANTHROPIC_API_KEY ? new ClaudeMemoPlanner({ apiKey: env.ANTHROPIC_API_KEY, model: env.CLAUDE_MODEL, fetch: opts.fetch }) : undefined,
      memoChannels: memoChannels(env),
      memoMaxIdeas: env.MEMO_MAX_IDEAS ? Number(env.MEMO_MAX_IDEAS) : undefined,
      reelRenderer: env.MEMO_REELS === "false" ? undefined : new FfmpegReelRenderer(),
      reelMaxSeconds: reelSeconds,
      memoAudio: drive
        ? async (memo) => (memo.driveFileId ? { bytes: await drive!.download({ id: memo.driveFileId }), mimeType: audioMime("", memo.name) ?? "audio/m4a", name: memo.name } : undefined)
        : undefined,
      carouselWriter: env.ANTHROPIC_API_KEY ? new ClaudeCarouselWriter({ apiKey: env.ANTHROPIC_API_KEY, model: env.CLAUDE_MODEL, fetch: opts.fetch }) : undefined,
      brand: brandFromEnv(env),
      autoApprove,
      now: opts.now,
      sleep: opts.sleep,
      fetch: opts.fetch,
      notifier,
      appUrl: env.APP_URL,
      mediaMonthlyCapUsd: cap,
      imageGenerator: env.GEMINI_API_KEY
        ? new GeminiImageGenerator({
            apiKey: env.GEMINI_API_KEY,
            model: env.GEMINI_IMAGE_MODEL,
            apiRevision: env.GEMINI_API_REVISION,
            costPerImageUsd: env.GEMINI_IMAGE_COST_USD ? Number(env.GEMINI_IMAGE_COST_USD) : undefined,
            fetch: opts.fetch,
          })
        : undefined,
      videoGenerator: env.HIGGSFIELD_API_KEY ? new HiggsfieldVideoGenerator({ apiKey: env.HIGGSFIELD_API_KEY, fetch: opts.fetch }) : undefined,
      mediaStorage: buildStorage(env, { fetch: opts.fetch }),
    }),
    configuredChannels: Object.keys(adapters) as Channel[],
  };
}
