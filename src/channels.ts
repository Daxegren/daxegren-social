import type { Asset, AssetKind, Channel, PostVariant } from "./domain.js";

export interface ChannelSpec {
  maxText: number;
  /** Media kinds the channel accepts. */
  media: AssetKind[];
  requiresMedia: boolean;
  maxAssets: number;
}

/**
 * Conservative publishing limits per channel. These change over time —
 * verify against each platform's current documentation before relying on them.
 */
export const CHANNEL_SPECS: Record<Channel, ChannelSpec> = {
  instagram: { maxText: 2200, media: ["image", "video"], requiresMedia: true, maxAssets: 10 },
  tiktok: { maxText: 2200, media: ["video"], requiresMedia: true, maxAssets: 1 },
  facebook: { maxText: 63206, media: ["image", "video"], requiresMedia: false, maxAssets: 10 },
  linkedin: { maxText: 3000, media: ["image", "video"], requiresMedia: false, maxAssets: 9 },
  pinterest: { maxText: 800, media: ["image", "video"], requiresMedia: true, maxAssets: 1 },
  youtube: { maxText: 5000, media: ["video"], requiresMedia: true, maxAssets: 1 },
  snapchat: { maxText: 250, media: ["image", "video"], requiresMedia: true, maxAssets: 1 },
  x: { maxText: 280, media: ["image", "video"], requiresMedia: false, maxAssets: 4 },
};

/** Returns a list of problems; empty means the variant can be published as-is. */
export function validateVariant(
  variant: Pick<PostVariant, "channel" | "text" | "assetIds">,
  assets: Asset[],
): string[] {
  const spec = CHANNEL_SPECS[variant.channel];
  const problems: string[] = [];

  if (variant.text.length > spec.maxText) {
    problems.push(`text is ${variant.text.length} chars, ${variant.channel} allows ${spec.maxText}`);
  }
  if (spec.requiresMedia && assets.length === 0) {
    problems.push(`${variant.channel} requires media`);
  }
  if (assets.length > spec.maxAssets) {
    problems.push(`${assets.length} assets, ${variant.channel} allows ${spec.maxAssets}`);
  }
  if (assets.length !== variant.assetIds.length) {
    problems.push("one or more referenced assets do not exist");
  }
  for (const a of assets) {
    if (!spec.media.includes(a.kind)) {
      problems.push(`${variant.channel} does not accept ${a.kind}`);
    }
    if (!a.uri.startsWith("https://")) {
      problems.push(`asset ${a.id} must have a public https uri`);
    }
  }
  if (variant.text.trim() === "" && assets.length === 0) {
    problems.push("variant is empty");
  }
  return problems;
}
