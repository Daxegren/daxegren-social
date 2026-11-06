import { GeminiImageGenerator } from "../adapters/gemini-image.js";
import { FacebookAdapter } from "../adapters/facebook.js";
import { HiggsfieldVideoGenerator } from "../adapters/higgsfield.js";
import { InstagramAdapter } from "../adapters/instagram.js";
import { LinkedInAdapter } from "../adapters/linkedin.js";
import { SupabaseStorage } from "../adapters/supabase-storage.js";
import type { ChannelAdapter, FetchLike } from "../adapters/types.js";
import { CHANNELS, type Channel } from "../domain.js";
import { ContentEngine } from "../engine.js";
import { ClaudeContentGenerator, type ContentGenerator } from "../generate.js";
import { WebhookNotifier, type Notifier, type WebhookFormat } from "../notify.js";
import type { Store } from "../store.js";

export type Env = Record<string, string | undefined>;

export interface Wiring {
  engine: ContentEngine;
  configuredChannels: Channel[];
  notifier?: Notifier;
}

/** Builds the engine from environment variables. A channel is enabled when its credentials are present. */
export function buildEngine(env: Env, store: Store, opts: { fetch?: FetchLike; now?: () => Date } = {}): Wiring {
  const adapters: Partial<Record<Channel, ChannelAdapter>> = {};

  if (env.INSTAGRAM_USER_ID && env.INSTAGRAM_ACCESS_TOKEN) {
    adapters.instagram = new InstagramAdapter({ igUserId: env.INSTAGRAM_USER_ID, accessToken: env.INSTAGRAM_ACCESS_TOKEN, fetch: opts.fetch });
  }
  if (env.FACEBOOK_PAGE_ID && env.FACEBOOK_PAGE_ACCESS_TOKEN) {
    adapters.facebook = new FacebookAdapter({ pageId: env.FACEBOOK_PAGE_ID, accessToken: env.FACEBOOK_PAGE_ACCESS_TOKEN, fetch: opts.fetch });
  }
  if (env.LINKEDIN_AUTHOR_URN && env.LINKEDIN_ACCESS_TOKEN) {
    adapters.linkedin = new LinkedInAdapter({ authorUrn: env.LINKEDIN_AUTHOR_URN, accessToken: env.LINKEDIN_ACCESS_TOKEN, fetch: opts.fetch });
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
      autoApprove,
      now: opts.now,
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
      mediaStorage:
        env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
          ? new SupabaseStorage({ url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY, bucket: env.SOCIAL_MEDIA_BUCKET, fetch: opts.fetch })
          : undefined,
    }),
    configuredChannels: Object.keys(adapters) as Channel[],
  };
}
