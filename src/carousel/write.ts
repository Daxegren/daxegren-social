import type Anthropic from "@anthropic-ai/sdk";
import type { ChannelInsights } from "../analyze.js";
import { answerText, claudeClient, DEFAULT_CLAUDE_MODEL, FALLBACK_BETA, fallbackFor, type ClaudeOptions } from "../claude.js";
import { CHANNEL_SPECS } from "../channels.js";
import type { Asset, Channel, ContentBrief, PublishedPost } from "../domain.js";
import { viewableImages } from "../generate.js";
import type { Slide } from "./render.js";

export interface CarouselInput {
  brief: ContentBrief;
  /** Channels that get a caption. Only channels that take images should be passed. */
  channels: Channel[];
  insights: Partial<Record<Channel, ChannelInsights>>;
  examples: PublishedPost[];
  assets: Asset[];
  /** Number of pages, cover and closing page included. */
  slideCount: number;
  /** The word readers are asked to comment on the last page. */
  keyword?: string;
  playbook?: string;
  trends?: string;
}

export interface WrittenCarousel {
  slides: Slide[];
  captions: Array<{ channel: Channel; text: string }>;
}

/** Writing a carousel (pages and one caption per channel). Swap implementations without touching the engine. */
export interface CarouselWriter {
  write(input: CarouselInput): Promise<WrittenCarousel>;
}

export const MIN_SLIDES = 4;
export const MAX_SLIDES = 12;
export const DEFAULT_SLIDES = 8;

const SYSTEM_PROMPT = `You write carousels (swipeable pages of text) for one specific creator, in their voice.
- Page 1 is the cover: a hook that makes people swipe. Concrete and specific, at most about 70 characters.
- Middle pages each carry ONE idea. Mix the kinds: "point" (a title and one or two sentences), "list" (3-6 short rows), "statement" (one punchy sentence).
- The last page is kind "cta". Its title says what the reader gets or should do next. If a keyword is given, set it in \`keyword\`.
- Keep the text on the pages short enough to read on a phone: titles under 70 characters, bodies under 200.
- Write in the language of the creator's example posts; if there are none, write in Swedish.
- Never invent facts, numbers, quotes, customers or results. If the brief does not say it, do not claim it.
- If pictures are shown they are the creator's own. Let them shape the content; never describe things that are not visible.
- No emoji, and no characters outside the Latin alphabet: the pages are drawn with a font that has nothing else.
- Write one caption per channel, adapted to its norms and hard limits. The caption is the text posted with the pages: a hook, one or two lines of value, and the call to action. At most three hashtags.
- Follow the playbook and trend notes when provided, but do not force a trend that does not fit.`;

const KINDS = ["cover", "point", "list", "statement", "cta"] as const;

const schema = (channels: Channel[]) => ({
  type: "object",
  properties: {
    slides: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...KINDS] },
          title: { type: "string" },
          body: { type: "string" },
          items: { type: "array", items: { type: "string" } },
          keyword: { type: "string" },
        },
        required: ["kind", "title"],
        additionalProperties: false,
      },
    },
    captions: {
      type: "array",
      items: {
        type: "object",
        properties: { channel: { type: "string", enum: channels }, text: { type: "string" } },
        required: ["channel", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["slides", "captions"],
  additionalProperties: false,
});

export interface ClaudeCarouselConfig extends ClaudeOptions {
  maxTokens?: number;
  fallbackModel?: string | false;
}

export class ClaudeCarouselWriter implements CarouselWriter {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(private readonly cfg: ClaudeCarouselConfig) {
    this.client = claudeClient(cfg);
    this.model = cfg.model ?? DEFAULT_CLAUDE_MODEL;
  }

  async write(input: CarouselInput): Promise<WrittenCarousel> {
    const fallback = this.cfg.fallbackModel === false ? undefined : (this.cfg.fallbackModel ?? fallbackFor(this.model));
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: this.cfg.maxTokens ?? 16000,
      ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: [{ model: fallback }] } : {}),
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: { type: "json_schema", schema: schema(input.channels) } },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildContent(input) }],
    });
    return parseCarousel(answerText(response), input);
  }
}

export function buildContent(input: CarouselInput): Anthropic.Beta.Messages.BetaContentBlockParam[] {
  const images = viewableImages(input.assets);
  const blocks: Anthropic.Beta.Messages.BetaContentBlockParam[] = [{ type: "text", text: buildPrompt(input) }];
  for (const a of images) {
    blocks.push({ type: "text", text: `The creator's own photo (${a.id}):` });
    blocks.push({ type: "image", source: { type: "url", url: a.uri } });
  }
  return blocks;
}

export function buildPrompt(input: CarouselInput): string {
  const { brief, channels, examples, insights } = input;
  const limits = channels.map((c) => ({ channel: c, maxCaptionChars: CHANNEL_SPECS[c].maxText }));
  const learned = channels.map((c) => insights[c]).filter(Boolean);
  return [
    `## Brief\nIdea: ${brief.idea}\nAngle: ${brief.angle ?? "-"}\nGoal: ${brief.goal ?? "-"}`,
    input.playbook ? `## Playbook (what has been learned about what works)\n${input.playbook}` : "",
    input.trends ? `## Trends right now\n${input.trends}` : "",
    `## Format\nExactly ${input.slideCount} pages. ${input.keyword ? `Closing page keyword: ${input.keyword.toUpperCase()}.` : "No comment keyword: end with a follow or save prompt."}`,
    `## Captions\n${JSON.stringify(limits)}`,
    `## What has worked (engagement rate per channel)\n${JSON.stringify(learned)}`,
    `## Example posts in the creator's voice\n${examples.map((p) => `[${p.channel}] ${p.text}`).join("\n---\n") || "(none yet)"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const clip = (s: unknown, max: number) => (typeof s === "string" ? s.trim().slice(0, max) : "");

/** Turns the model's answer into pages that can always be drawn: unknown kinds, empty pages and extra pages are dropped. */
export function parseCarousel(raw: string, input: Pick<CarouselInput, "channels" | "slideCount" | "keyword">): WrittenCarousel {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("the writer returned no JSON");
  const parsed = JSON.parse(raw.slice(start, end + 1)) as { slides?: unknown; captions?: unknown };
  if (!Array.isArray(parsed.slides)) throw new Error("the writer's JSON has no slides");

  const slides: Slide[] = [];
  for (const s of parsed.slides as Array<Record<string, unknown>>) {
    const kind = s.kind as Slide["kind"];
    const title = clip(s.title, 200);
    if (!(KINDS as readonly string[]).includes(kind) || !title) continue;
    const slide: Slide = { kind, title };
    const body = clip(s.body, 500);
    if (body) slide.body = body;
    if (kind === "list") {
      const items = Array.isArray(s.items) ? (s.items as unknown[]).map((i) => clip(i, 120)).filter(Boolean).slice(0, 8) : [];
      if (items.length === 0) continue;
      slide.items = items;
    }
    if (kind === "cta") {
      const keyword = (input.keyword ?? clip(s.keyword, 30)).replace(/[^\p{L}\p{N}]/gu, "").toUpperCase();
      if (keyword) slide.keyword = keyword;
    }
    slides.push(slide);
  }
  if (slides.length < MIN_SLIDES) throw new Error(`the writer returned ${slides.length} usable pages, at least ${MIN_SLIDES} are needed`);

  // Cover first, closing page last, and never more pages than asked for.
  slides[0]!.kind = "cover";
  const last = [...slides].reverse().find((s) => s.kind === "cta");
  const body = slides.slice(1).filter((s) => s !== last && s.kind !== "cover" && s.kind !== "cta");
  const ordered = [slides[0]!, ...body.slice(0, Math.max(input.slideCount - (last ? 2 : 1), 0))];
  if (last) ordered.push(last);

  const captions: WrittenCarousel["captions"] = [];
  if (Array.isArray(parsed.captions)) {
    for (const c of parsed.captions as Array<Record<string, unknown>>) {
      const text = clip(c.text, 6000);
      if (input.channels.includes(c.channel as Channel) && text && !captions.some((x) => x.channel === c.channel)) {
        captions.push({ channel: c.channel as Channel, text: text.slice(0, CHANNEL_SPECS[c.channel as Channel].maxText) });
      }
    }
  }
  return { slides: ordered, captions };
}
