import type { Channel, PublishedPost } from "./domain.js";

export interface ChannelInsights {
  channel: Channel;
  sampleSize: number;
  /** Posts with enough metrics to compute an engagement rate. */
  measuredSize: number;
  topPosts: Array<{ postId: string; text: string; engagementRate: number }>;
  /** UTC hours with the best average engagement rate (min 2 posts per hour). */
  bestHoursUtc: number[];
  byLength: Record<"short" | "medium" | "long", { posts: number; avgEngagementRate: number }>;
  byMedia: Record<"text" | "image" | "video", { posts: number; avgEngagementRate: number }>;
}

/** Engagement actions divided by the largest available audience figure. */
export function engagementRate(post: PublishedPost): number | undefined {
  const m = post.metrics;
  if (!m) return undefined;
  const audience = m.impressions ?? m.reach ?? m.views;
  const actions = (m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0) + (m.saves ?? 0) + (m.clicks ?? 0);
  if (audience && audience > 0) return actions / audience;
  // Platforms that expose no audience figure: fall back to a raw action count so ranking still works.
  return actions > 0 ? actions : undefined;
}

function avg(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function lengthBucket(text: string): "short" | "medium" | "long" {
  return text.length < 150 ? "short" : text.length < 600 ? "medium" : "long";
}

function mediaBucket(p: PublishedPost): "text" | "image" | "video" {
  if (p.mediaKinds.includes("video")) return "video";
  if (p.mediaKinds.includes("image")) return "image";
  return "text";
}

export function analyzeChannel(channel: Channel, posts: PublishedPost[]): ChannelInsights {
  const own = posts.filter((p) => p.channel === channel);
  const measured = own
    .map((p) => ({ post: p, er: engagementRate(p) }))
    .filter((x): x is { post: PublishedPost; er: number } => x.er !== undefined);

  const topPosts = [...measured]
    .sort((a, b) => b.er - a.er)
    .slice(0, 5)
    .map(({ post, er }) => ({ postId: post.id, text: post.text, engagementRate: er }));

  const hours = new Map<number, number[]>();
  for (const { post, er } of measured) {
    const h = new Date(post.publishedAt).getUTCHours();
    hours.set(h, [...(hours.get(h) ?? []), er]);
  }
  const bestHoursUtc = [...hours.entries()]
    .filter(([, ers]) => ers.length >= 2)
    .sort((a, b) => avg(b[1]) - avg(a[1]))
    .slice(0, 3)
    .map(([h]) => h);

  const group = <K extends string>(keys: readonly K[], key: (p: PublishedPost) => K) =>
    Object.fromEntries(
      keys.map((k) => {
        const ers = measured.filter((x) => key(x.post) === k).map((x) => x.er);
        return [k, { posts: ers.length, avgEngagementRate: avg(ers) }];
      }),
    ) as Record<K, { posts: number; avgEngagementRate: number }>;

  return {
    channel,
    sampleSize: own.length,
    measuredSize: measured.length,
    topPosts,
    bestHoursUtc,
    byLength: group(["short", "medium", "long"] as const, (p) => lengthBucket(p.text)),
    byMedia: group(["text", "image", "video"] as const, mediaBucket),
  };
}

/** Next occurrence (strictly after `now`) of a UTC hour, used for scheduling suggestions. */
export function nextOccurrenceOfHour(hourUtc: number, now: Date): Date {
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(hourUtc);
  if (d <= now) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/** Best learned slot if there is one, otherwise one hour from now. */
export function suggestTime(insights: ChannelInsights | undefined, now: Date): Date {
  const hour = insights?.bestHoursUtc[0];
  return hour === undefined ? new Date(now.getTime() + 60 * 60 * 1000) : nextOccurrenceOfHour(hour, now);
}
