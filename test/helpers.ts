import type { Channel, PostVariant } from "../src/domain.js";
import {
  AdapterError,
  type AdapterCapabilities,
  type ChannelAdapter,
  type PublishResult,
} from "../src/adapters/types.js";
import type { ContentGenerator, GeneratedVariant } from "../src/generate.js";
import type { Asset, Metrics } from "../src/domain.js";

export class FakeAdapter implements ChannelAdapter {
  capabilities: AdapterCapabilities = { canIngest: false, canMeasure: false };
  published: PostVariant[] = [];
  /** Errors thrown (in order) by successive publish calls before one succeeds. */
  failures: Error[] = [];

  constructor(readonly channel: Channel) {}

  async fetchPublished() {
    return [];
  }

  async fetchMetrics(): Promise<Metrics | null> {
    return null;
  }

  async publish(variant: PostVariant, _assets: Asset[]): Promise<PublishResult> {
    const err = this.failures.shift();
    if (err) throw err;
    this.published.push(variant);
    return { externalId: `ext-${this.published.length}`, url: `https://example.test/${this.channel}/${this.published.length}` };
  }
}

export const transient = () => new AdapterError("boom", false, 503);
export const permanent = () => new AdapterError("rejected", true, 400);

export class FakeGenerator implements ContentGenerator {
  constructor(private readonly make: (channel: Channel) => Partial<GeneratedVariant> = () => ({})) {}

  async generate(input: Parameters<ContentGenerator["generate"]>[0]): Promise<GeneratedVariant[]> {
    return input.channels.map((channel) => ({
      channel,
      text: `post for ${channel}`,
      assetIds: [],
      ...this.make(channel),
    }));
  }
}

/** fetch stub that records calls and replies from a queue of [matcher, response]. */
export function mockFetch(routes: Array<{ match: (url: string, init?: RequestInit) => boolean; reply: () => Response }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes.find((r) => r.match(url, init));
    if (!route) throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
    return route.reply();
  }) as typeof fetch;
  return { fn, calls };
}

export const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

import type { MediaCost, MediaStorage, VideoGenerator, VideoJobState, VideoRequest } from "../src/media.js";

export class FakeVideoGenerator implements VideoGenerator {
  readonly provider = "fake";
  submitted: VideoRequest[] = [];
  estimateUsd = 0.1;
  /** What status() returns, in order; the last one repeats. */
  states: VideoJobState[] = [{ status: "completed", videoUrl: "https://provider.test/v.mp4" }];
  submitError?: Error;
  /** Errors thrown (in order) by successive submit calls before one succeeds. */
  submitFailures: Error[] = [];
  attempts: VideoRequest[] = [];
  statusError?: Error;

  async estimate(): Promise<MediaCost> {
    return { usd: this.estimateUsd, isEstimate: true, source: "fake" };
  }

  async submit(req: VideoRequest) {
    this.attempts.push(req);
    const failure = this.submitFailures.shift();
    if (failure) throw failure;
    if (this.submitError) throw this.submitError;
    this.submitted.push(req);
    return { providerJobId: `job-${this.submitted.length}-abcdefgh` };
  }

  async status(): Promise<VideoJobState> {
    if (this.statusError) throw this.statusError;
    return this.states.length > 1 ? this.states.shift()! : this.states[0]!;
  }
}

export class MemoryStorage implements MediaStorage {
  files = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  async put(path: string, bytes: Uint8Array, mimeType: string) {
    this.files.set(path, { bytes, mimeType });
    return `https://storage.test/public/${path}`;
  }
}

import type { GeneratedImage, ImageGenerator, ImageRequest } from "../src/media.js";

export class FakeImageGenerator implements ImageGenerator {
  readonly provider = "fake-image";
  readonly model = "fake-model";
  requests: ImageRequest[] = [];
  estimateUsd = 0.04;
  error?: Error;

  async estimate(): Promise<MediaCost> {
    return { usd: this.estimateUsd, isEstimate: true, source: "fake" };
  }

  async generate(req: ImageRequest): Promise<GeneratedImage> {
    if (this.error) throw this.error;
    this.requests.push(req);
    return { bytes: new Uint8Array([137, 80, 78, 71]), mimeType: "image/png" };
  }
}

/** A Messages API response with one text block, in the shape the SDK expects. */
export const claudeMessage = (text: string, over: Record<string, unknown> = {}) =>
  json({ id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, ...over });

/** Matches the Messages endpoint, with or without the `?beta=true` the SDK adds for beta features. */
export const isClaude = (url: string) => url.startsWith("https://api.anthropic.com/v1/messages");
