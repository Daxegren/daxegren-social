import { InstagramAdapter } from "../adapters/instagram.js";
import { LinkedInAdapter } from "../adapters/linkedin.js";
import type { ChannelAdapter, FetchLike } from "../adapters/types.js";
import { CHANNELS, type Channel } from "../domain.js";
import { ContentEngine } from "../engine.js";
import { ClaudeContentGenerator, type ContentGenerator } from "../generate.js";
import type { Store } from "../store.js";

export type Env = Record<string, string | undefined>;

export interface Wiring {
  engine: ContentEngine;
  configuredChannels: Channel[];
}

/** Builds the engine from environment variables. A channel is enabled when its credentials are present. */
export function buildEngine(env: Env, store: Store, opts: { fetch?: FetchLike; now?: () => Date } = {}): Wiring {
  const adapters: Partial<Record<Channel, ChannelAdapter>> = {};

  if (env.INSTAGRAM_USER_ID && env.INSTAGRAM_ACCESS_TOKEN) {
    adapters.instagram = new InstagramAdapter({ igUserId: env.INSTAGRAM_USER_ID, accessToken: env.INSTAGRAM_ACCESS_TOKEN, fetch: opts.fetch });
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

  return {
    engine: new ContentEngine({ store, adapters, generator, autoApprove, now: opts.now }),
    configuredChannels: Object.keys(adapters) as Channel[],
  };
}
