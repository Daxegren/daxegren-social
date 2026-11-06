import type { FetchLike } from "./adapters/types.js";

export type NotifyKind = "drafts_ready" | "published" | "failed" | "request_failed" | "media" | "stranded" | "budget" | "test";

export interface NotifyEvent {
  kind: NotifyKind;
  title: string;
  message: string;
  /** Opened when the notification is tapped, where the service supports it. */
  url?: string;
}

/** Sends a short message to the owner. Implementations must never throw into the engine's work. */
export interface Notifier {
  notify(event: NotifyEvent): Promise<void>;
}

export type WebhookFormat = "ntfy" | "slack" | "discord" | "json";

export interface WebhookConfig {
  /** The webhook address. Treat it as a secret: for ntfy the topic name is the only protection. */
  url: string;
  /** Detected from the address when omitted. */
  format?: WebhookFormat;
  fetch?: FetchLike;
}

export function detectFormat(url: string): WebhookFormat {
  const host = new URL(url).hostname;
  if (host === "ntfy.sh" || host.startsWith("ntfy.")) return "ntfy";
  if (host === "hooks.slack.com") return "slack";
  if (host === "discord.com" || host === "discordapp.com") return "discord";
  return "json";
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One-line excerpt of a post for use in a notification. */
export const excerpt = (text: string, n = 80) => clip(text.replace(/\s+/g, " ").trim(), n);

export class WebhookNotifier implements Notifier {
  readonly format: WebhookFormat;
  private readonly fetchFn: FetchLike;

  constructor(private readonly cfg: WebhookConfig) {
    if (!/^https:\/\//.test(cfg.url)) throw new Error("NOTIFY_URL must be an https URL");
    this.format = cfg.format ?? detectFormat(cfg.url);
    this.fetchFn = cfg.fetch ?? fetch;
  }

  async notify(event: NotifyEvent): Promise<void> {
    const { url, init } = this.request(event);
    let res: Response;
    try {
      res = await this.fetchFn(url, init);
    } catch (err) {
      throw new Error(this.scrub(`notification failed: ${(err as Error).message}`));
    }
    if (!res.ok) throw new Error(this.scrub(`notification failed: HTTP ${res.status}`));
  }

  private request(e: NotifyEvent): { url: string; init: RequestInit } {
    const title = clip(e.title, 100);
    const message = clip(e.message, 1000);
    const json = (body: unknown, url = this.cfg.url): { url: string; init: RequestInit } => ({
      url,
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    });
    switch (this.format) {
      case "ntfy": {
        // Publish as JSON to the server root so Swedish characters are not squeezed through HTTP headers.
        const u = new URL(this.cfg.url);
        const topic = u.pathname.replace(/^\/+|\/+$/g, "");
        if (!topic) throw new Error("the ntfy address must include a topic, e.g. https://ntfy.sh/my-secret-topic");
        return json({ topic, title, message, ...(e.url ? { click: e.url } : {}) }, `${u.origin}/`);
      }
      case "slack":
        return json({ text: `*${title}*\n${message}${e.url ? `\n<${e.url}|Öppna>` : ""}` });
      case "discord":
        return json({ content: clip(`**${title}**\n${message}${e.url ? `\n${e.url}` : ""}`, 1900) });
      default:
        return json({ kind: e.kind, title, message, url: e.url });
    }
  }

  /** The address is the credential; keep it out of every message. */
  private scrub(text: string): string {
    const topic = new URL(this.cfg.url).pathname.replace(/^\/+|\/+$/g, "");
    let out = text.split(this.cfg.url).join("[redacted]");
    if (topic.length >= 6) out = out.split(topic).join("[redacted]");
    return out;
  }
}
