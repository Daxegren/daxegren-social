import type { ChannelInsights } from "./analyze.js";
import { CHANNEL_SPECS } from "./channels.js";
import type { Asset, AssetKind, Channel, ContentBrief, PublishedPost } from "./domain.js";
import type { FetchLike } from "./adapters/types.js";

export interface GenerationInput {
  brief: ContentBrief;
  channels: Channel[];
  insights: Partial<Record<Channel, ChannelInsights>>;
  /** Source posts the brief builds on, plus the best performers, as style/voice examples. */
  examples: PublishedPost[];
  /** Assets available to attach (captured by the owner or generated). */
  assets: Asset[];
}

export interface GeneratedVariant {
  channel: Channel;
  text: string;
  assetIds: string[];
  rationale?: string;
}

/** Text generation. Swap implementations without touching the engine. */
export interface ContentGenerator {
  generate(input: GenerationInput): Promise<GeneratedVariant[]>;
}

export interface MediaRequest {
  kind: AssetKind;
  prompt: string;
  channel?: Channel;
}

/**
 * Image/video generation. The engine stores the result as an Asset with
 * origin `generated`. Plug in whichever provider you use.
 */
export interface MediaGenerator {
  generate(req: MediaRequest): Promise<{ uri: string; meta?: Record<string, unknown> }>;
}

export interface ClaudeGeneratorConfig {
  apiKey: string;
  model?: string;
  fetch?: FetchLike;
  baseUrl?: string;
  maxTokens?: number;
}

const SYSTEM_PROMPT = `You write social media content for one specific creator.
Match the creator's voice from the example posts. Never invent facts, numbers, quotes or results.
Adapt each post to its channel's norms and hard limits; do not paste the same text everywhere.
Only reference asset ids that appear in the provided asset list.
Respond with JSON only, no prose: {"variants":[{"channel":string,"text":string,"assetIds":string[],"rationale":string}]}`;

export class ClaudeContentGenerator implements ContentGenerator {
  private readonly fetchFn: FetchLike;

  constructor(private readonly cfg: ClaudeGeneratorConfig) {
    this.fetchFn = cfg.fetch ?? fetch;
  }

  async generate(input: GenerationInput): Promise<GeneratedVariant[]> {
    const res = await this.fetchFn(`${this.cfg.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.cfg.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.cfg.model ?? "claude-sonnet-5-5",
        max_tokens: this.cfg.maxTokens ?? 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildPrompt(input) }],
      }),
    });
    if (!res.ok) throw new Error(`Claude API HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    return parseVariants(text, input);
  }
}

export function buildPrompt(input: GenerationInput): string {
  const { brief, channels, insights, examples, assets } = input;
  const specs = channels.map((c) => ({ channel: c, ...CHANNEL_SPECS[c] }));
  const learned = channels.map((c) => insights[c]).filter(Boolean);
  return [
    `## Brief\nIdea: ${brief.idea}\nAngle: ${brief.angle ?? "-"}\nGoal: ${brief.goal ?? "-"}`,
    `## Channels and hard limits\n${JSON.stringify(specs)}`,
    `## What has worked (engagement rate per channel)\n${JSON.stringify(learned)}`,
    `## Example posts in the creator's voice\n${examples.map((p) => `[${p.channel}] ${p.text}`).join("\n---\n") || "(none yet)"}`,
    `## Available assets\n${JSON.stringify(assets.map((a) => ({ id: a.id, kind: a.kind, origin: a.origin })))}`,
    `Write one variant per channel.`,
  ].join("\n\n");
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
    });
  }
  return out;
}
