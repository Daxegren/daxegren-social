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
