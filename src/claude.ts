import Anthropic from "@anthropic-ai/sdk";
import type { FetchLike } from "./adapters/types.js";

/** The model the engine uses for writing and research unless CLAUDE_MODEL says otherwise. */
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

export interface ClaudeOptions {
  apiKey?: string;
  /** Inject a ready client (tests, or a client configured elsewhere). */
  client?: Anthropic;
  model?: string;
  fetch?: FetchLike;
  baseUrl?: string;
  /** SDK retries on 429/5xx/connection errors. Default 2. */
  maxRetries?: number;
}

export function claudeClient(opts: ClaudeOptions): Anthropic {
  if (opts.client) return opts.client;
  if (!opts.apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  return new Anthropic({ apiKey: opts.apiKey, fetch: opts.fetch, baseURL: opts.baseUrl, maxRetries: opts.maxRetries });
}

/**
 * Server-side fallback for the models that support it: if the safety classifiers decline a request, the API re-runs it on
 * this model inside the same call. Other models get none.
 */
export function fallbackFor(model: string): string | undefined {
  if (model === "claude-opus-5-5") return "claude-opus-4-8";
  if (model === "claude-sonnet-5-5") return "claude-sonnet-5";
  return undefined;
}

export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** The model declined the request. Retrying the same request will not help. */
export class ClaudeRefusalError extends Error {
  constructor(readonly category?: string) {
    super(`Claude declined to answer${category ? ` (${category})` : ""}`);
    this.name = "ClaudeRefusalError";
  }
}

interface MessageLike {
  stop_reason?: string | null;
  stop_details?: { category?: string | null } | null;
  content: Array<{ type: string; text?: string }>;
}

/** Concatenated text of a response, after checking it actually finished. */
export function answerText(res: MessageLike): string {
  if (res.stop_reason === "refusal") throw new ClaudeRefusalError(res.stop_details?.category ?? undefined);
  if (res.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off (max_tokens); the request needs a higher limit");
  return res.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
}
