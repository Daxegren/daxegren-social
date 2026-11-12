import type Anthropic from "@anthropic-ai/sdk";
import type { ChannelInsights } from "./analyze.js";
import { answerText, claudeClient, DEFAULT_CLAUDE_MODEL, FALLBACK_BETA, fallbackFor, type ClaudeOptions } from "./claude.js";
import { CHANNEL_SPECS } from "./channels.js";
import type { Asset, Channel, ContentBrief, PublishedPost } from "./domain.js";

export interface GenerationInput {
  brief: ContentBrief;
  channels: Channel[];
  insights: Partial<Record<Channel, ChannelInsights>>;
  /** Source posts the brief builds on, plus the best performers, as style/voice examples. */
  examples: PublishedPost[];
  /** Assets available to attach (captured by the owner or generated). Images are shown to the model. */
  assets: Asset[];
  /** What the engine has learned about what works (updated by `research`). */
  playbook?: string;
  /** What is trending right now in the owner's field (updated by `research`). */
  trends?: string;
  /** Also ask for a picture description per post, so an image can be generated for it. */
  wantImagePrompt?: boolean;
}

export interface GeneratedVariant {
  channel: Channel;
  text: string;
  assetIds: string[];
  rationale?: string;
  /** Scene description for an image generator. Set when `wantImagePrompt` was requested. */
  imagePrompt?: string;
}

/** Text generation. Swap implementations without touching the engine. */
export interface ContentGenerator {
  generate(input: GenerationInput): Promise<GeneratedVariant[]>;
}

export interface ClaudeGeneratorConfig extends ClaudeOptions {
  maxTokens?: number;
  /** `false` turns the server-side refusal fallback off. */
  fallbackModel?: string | false;
}

const SYSTEM_PROMPT = `You write social media posts for one specific creator, in their voice.
- Match the voice of the creator's example posts. Write in the language of those examples; if there are none, write in Swedish.
- Never invent facts, numbers, quotes, customers or results. If a picture or brief does not say it, do not claim it.
- When pictures are provided, look at them: let what is actually visible shape the post, and never describe things that are not there.
- Adapt each post to its channel's norms and hard limits; do not paste the same text everywhere.
- Follow the playbook and trend notes when they are provided; they are what has been learned about what works. Lean on them, but do not force a trend that does not fit the idea.
- Only reference asset ids that appear in the provided asset list.
- Put the hook in the first line. No hashtag spam, no emoji walls.`;

/** Image formats Claude can look at (and that a public URL can serve). */
const VIEWABLE = ["jpg", "jpeg", "png", "webp", "gif"];
const MAX_IMAGES = 8;

const variantSchema = (channels: Channel[], wantImagePrompt: boolean) => ({
  type: "object",
  properties: {
    variants: {
      type: "array",
      items: {
        type: "object",
        properties: {
          channel: { type: "string", enum: channels },
          text: { type: "string" },
          assetIds: { type: "array", items: { type: "string" } },
          rationale: { type: "string" },
          ...(wantImagePrompt ? { imagePrompt: { type: "string" } } : {}),
        },
        required: ["channel", "text", "assetIds", "rationale", ...(wantImagePrompt ? ["imagePrompt"] : [])],
        additionalProperties: false,
      },
    },
  },
  required: ["variants"],
  additionalProperties: false,
});

export class ClaudeContentGenerator implements ContentGenerator {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(private readonly cfg: ClaudeGeneratorConfig) {
    this.client = claudeClient(cfg);
    this.model = cfg.model ?? DEFAULT_CLAUDE_MODEL;
  }

  async generate(input: GenerationInput): Promise<GeneratedVariant[]> {
    const fallback = this.cfg.fallbackModel === false ? undefined : (this.cfg.fallbackModel ?? fallbackFor(this.model));
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: this.cfg.maxTokens ?? 16000,
      ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: [{ model: fallback }] } : {}),
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: { type: "json_schema", schema: variantSchema(input.channels, Boolean(input.wantImagePrompt)) } },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildContent(input) }],
    });
    return parseVariants(answerText(response), input);
  }
}

/** Viewable image assets, in the order given, capped. */
export function viewableImages(assets: Asset[]): Asset[] {
  return assets
    .filter((a) => {
      if (a.kind !== "image" || !a.uri.startsWith("https://")) return false;
      const ext = /\.([A-Za-z0-9]+)$/.exec(a.uri.split(/[?#]/)[0] ?? "")?.[1]?.toLowerCase();
      return !ext || VIEWABLE.includes(ext);
    })
    .slice(0, MAX_IMAGES);
}

/** The user message: the brief as text, with each viewable image shown right after its label. */
export function buildContent(input: GenerationInput): Anthropic.Beta.Messages.BetaContentBlockParam[] {
  const images = viewableImages(input.assets);
  const shown = new Set(images.map((a) => a.id));
  const blocks: Anthropic.Beta.Messages.BetaContentBlockParam[] = [{ type: "text", text: buildPrompt(input, shown) }];
  for (const a of images) {
    blocks.push({ type: "text", text: `Asset ${a.id} (${a.origin === "captured" ? "the creator's own photo" : "generated"}):` });
    blocks.push({ type: "image", source: { type: "url", url: a.uri } });
  }
  return blocks;
}

export function buildPrompt(input: GenerationInput, shownAssetIds: Set<string> = new Set()): string {
  const { brief, channels, insights, examples, assets } = input;
  const specs = channels.map((c) => ({ channel: c, ...CHANNEL_SPECS[c] }));
  const learned = channels.map((c) => insights[c]).filter(Boolean);
  const assetLines = assets.map((a) => `${a.id}: ${a.kind}, ${a.origin === "captured" ? "own" : "generated"}${shownAssetIds.has(a.id) ? " (shown below)" : a.kind === "video" ? " (video, cannot be viewed)" : ""}`);
  return [
    `## Brief\nIdea: ${brief.idea}\nAngle: ${brief.angle ?? "-"}\nGoal: ${brief.goal ?? "-"}`,
    input.playbook ? `## Playbook (what has been learned about what works)\n${input.playbook}` : "",
    input.trends ? `## Trends right now\n${input.trends}` : "",
    `## Channels and hard limits\n${JSON.stringify(specs)}`,
    `## What has worked (engagement rate per channel)\n${JSON.stringify(learned)}`,
    `## Example posts in the creator's voice\n${examples.map((p) => `[${p.channel}] ${p.text}`).join("\n---\n") || "(none yet)"}`,
    `## Available assets\n${assetLines.join("\n") || "(none)"}`,
    input.wantImagePrompt
      ? "For every post also write `imagePrompt`: one concrete scene (subject, setting, light, mood) for an image generator to illustrate that post. No text or logos in the image. If a picture of the creator's own is shown, base the scene on it."
      : "",
    `Write one variant per channel.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function parseVariants(raw: string, input: GenerationInput): GeneratedVariant[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("generator returned no JSON");

  const parsed = JSON.parse(raw.slice(start, end + 1)) as { variants?: unknown };
  if (!Array.isArray(parsed.variants)) throw new Error("generator JSON has no variants array");

  const knownAssets = new Set(input.assets.map((a) => a.id));
  const out: GeneratedVariant[] = [];
  for (const v of parsed.variants as Array<Record<string, unknown>>) {
    const channel = v.channel as Channel;
    if (!input.channels.includes(channel) || typeof v.text !== "string") continue;
    const assetIds = Array.isArray(v.assetIds) ? (v.assetIds as string[]).filter((id) => knownAssets.has(id)) : [];
    out.push({
      channel,
      text: v.text,
      assetIds,
      rationale: typeof v.rationale === "string" ? v.rationale : undefined,
      imagePrompt: typeof v.imagePrompt === "string" && v.imagePrompt.trim() ? v.imagePrompt.trim() : undefined,
    });
  }
  return out;
}
