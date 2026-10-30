import { validateVariant } from "./channels.js";
import type { Channel, PostVariant } from "./domain.js";
import { AdapterError, type ChannelAdapter } from "./adapters/types.js";
import type { Store } from "./store.js";

export interface SchedulerOptions {
  maxAttempts?: number;
  /** Delay before retry n (1-based). */
  backoffMs?: (attempt: number) => number;
}

export interface TickResult {
  published: string[];
  retried: string[];
  failed: string[];
}

const defaultBackoff = (attempt: number) => Math.min(60 * 60 * 1000, 2 ** attempt * 60 * 1000);

/**
 * Publishes every due `scheduled` variant. Each variant is claimed with an
 * atomic status transition before the network call, so overlapping ticks (or
 * two workers) can never publish the same variant twice.
 */
export async function runDue(
  store: Store,
  adapters: Partial<Record<Channel, ChannelAdapter>>,
  now: Date,
  opts: SchedulerOptions = {},
): Promise<TickResult> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const backoff = opts.backoffMs ?? defaultBackoff;
  const result: TickResult = { published: [], retried: [], failed: [] };

  const due = (await store.listVariants({ status: "scheduled" }))
    .filter((v) => v.scheduledAt && new Date(v.scheduledAt) <= now)
    .sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!));

  for (const candidate of due) {
    const claimed = await store.transitionVariant(candidate.id, "scheduled", "publishing");
    if (!claimed) continue;
    const v: PostVariant = { ...claimed, attempts: claimed.attempts + 1 };

    const fail = async (message: string, permanent: boolean) => {
      v.lastError = message;
      if (permanent || v.attempts >= maxAttempts) {
        v.status = "failed";
        result.failed.push(v.id);
      } else {
        v.status = "scheduled";
        v.scheduledAt = new Date(now.getTime() + backoff(v.attempts)).toISOString();
        result.retried.push(v.id);
      }
      await store.putVariant(v);
    };

    const adapter = adapters[v.channel];
    if (!adapter) {
      await fail(`no adapter configured for ${v.channel}`, true);
      continue;
    }

    const assets = await store.getAssets(v.assetIds);
    const problems = validateVariant(v, assets);
    if (problems.length > 0) {
      await fail(`invalid for ${v.channel}: ${problems.join("; ")}`, true);
      continue;
    }

    try {
      const res = await adapter.publish(v, assets);
      v.status = "published";
      v.externalId = res.externalId;
      v.url = res.url;
      v.publishedAt = now.toISOString();
      v.lastError = undefined;
      await store.putVariant(v);
      await store.upsertPost({
        id: crypto.randomUUID(),
        channel: v.channel,
        externalId: res.externalId,
        url: res.url,
        text: v.text,
        mediaKinds: assets.map((a) => a.kind),
        publishedAt: v.publishedAt,
        variantId: v.id,
      });
      result.published.push(v.id);
    } catch (err) {
      const permanent = err instanceof AdapterError ? err.permanent : false;
      await fail((err as Error).message, permanent);
    }
  }
  return result;
}
