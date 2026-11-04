import { createHash } from "node:crypto";
import type { RemotePost } from "../adapters/types.js";
import type { AssetKind, Channel, Metrics } from "../domain.js";

export const MAX_IMPORT_ROWS = 5000;

export interface ImportResult {
  posts: RemotePost[];
  skipped: Array<{ row: number; reason: string }>;
}

/** RFC 4180 CSV: quoted fields, "" escapes, newlines inside quotes, BOM, and , ; or tab as delimiter. */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] ?? "";
  const count = (ch: string) => firstLine.split(ch).length - 1;
  const delimiter = [",", ";", "\t"].reduce((best, ch) => (count(ch) > count(best) ? ch : best), ",");

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    if (row.some((f) => f.trim() !== "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) endField();
    else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
    } else if (ch === "\n") endRow();
    else field += ch;
  }
  if (quoted) throw new Error("the CSV has an unclosed quote");
  endRow();
  return rows;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const ALIASES: Record<string, string[]> = {
  text: ["text", "body", "caption", "content", "commentary", "sharecommentary", "message", "post"],
  date: ["date", "publishedat", "published", "time", "timestamp", "sharedate", "created", "createdat", "createdtime"],
  url: ["url", "link", "permalink", "sharelink"],
  id: ["id", "externalid", "postid"],
  media: ["media", "mediatype", "type"],
  mediaurl: ["mediaurl"],
  impressions: ["impressions", "impression"],
  reach: ["reach"],
  views: ["views", "videoviews", "plays"],
  likes: ["likes", "likecount", "reactions"],
  comments: ["comments", "commentcount"],
  shares: ["shares", "reposts", "sharecount"],
  saves: ["saves", "bookmarks"],
  clicks: ["clicks", "linkclicks"],
};
const METRIC_FIELDS = ["impressions", "reach", "views", "likes", "comments", "shares", "saves", "clicks"] as const;

function canonicalKey(header: string): string | undefined {
  const n = norm(header);
  return Object.entries(ALIASES).find(([, names]) => names.includes(n))?.[0];
}

function parseDate(raw: string): string | undefined {
  const v = raw.trim();
  if (!v) return undefined;
  // No timezone given: read as UTC so the same file always imports the same way.
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(v)
    ? `${v}T00:00:00Z`
    : /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v)
      ? `${v.replace(" ", "T")}Z`
      : /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(v)
        ? v.replace(" ", "T")
        : undefined;
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function parseCount(raw: unknown): number | undefined | "invalid" {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "number") return Number.isInteger(raw) && raw >= 0 ? raw : "invalid";
  const v = String(raw).replace(/[\s ]/g, "");
  if (v === "" || v === "-") return undefined;
  if (/^\d+$/.test(v)) return Number(v);
  if (/^\d{1,3}([,.]\d{3})+$/.test(v)) return Number(v.replace(/[,.]/g, ""));
  return "invalid";
}

function parseMedia(raw: unknown): AssetKind[] | "invalid" {
  const parts = String(raw ?? "").toLowerCase().split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
  const out = new Set<AssetKind>();
  for (const p of parts) {
    if (["image", "photo", "picture", "carousel", "pin"].includes(p)) out.add("image");
    else if (["video", "reel", "short", "clip"].includes(p)) out.add("video");
    else if (!["none", "text", "no", "-"].includes(p)) return "invalid";
  }
  return [...out];
}

const asString = (v: unknown) => (v === undefined || v === null ? "" : String(v));

/** Turns a CSV or JSON export into posts. Rows that cannot be read are reported, never guessed. */
export function parsePosts(input: string, opts: { channel: Channel; now: Date }): ImportResult {
  const trimmed = input.trim();
  let records: Array<Record<string, unknown>>;
  let label: (i: number) => string;

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as unknown;
    const list = Array.isArray(parsed) ? parsed : (parsed as { posts?: unknown }).posts;
    if (!Array.isArray(list)) throw new Error('JSON must be an array of posts, or {"posts": [...]}');
    records = list.map((item) => {
      const rec: Record<string, unknown> = {};
      for (const [k, v] of Object.entries((item ?? {}) as Record<string, unknown>)) {
        const key = canonicalKey(k);
        if (key && rec[key] === undefined) rec[key] = v;
      }
      return rec;
    });
    label = (i) => `item ${i + 1}`;
  } else {
    const rows = parseCsv(trimmed);
    const header = rows[0];
    if (!header) throw new Error("the file is empty");
    const keys = header.map(canonicalKey);
    if (!keys.includes("date") || !(keys.includes("text") || keys.includes("media"))) {
      throw new Error(`could not find the columns: need a date column and a text column. Found: ${header.join(", ")}`);
    }
    records = rows.slice(1).map((cells) => {
      const rec: Record<string, unknown> = {};
      keys.forEach((k, i) => {
        if (k && rec[k] === undefined) rec[k] = cells[i] ?? "";
      });
      return rec;
    });
    label = (i) => `row ${i + 2}`; // matches the spreadsheet row: header is row 1
  }

  if (records.length > MAX_IMPORT_ROWS) throw new Error(`too many rows (${records.length}); the limit is ${MAX_IMPORT_ROWS} per file`);

  const result: ImportResult = { posts: [], skipped: [] };
  const seen = new Map<string, string>();

  records.forEach((rec, i) => {
    const where = label(i);
    const skip = (reason: string) => result.skipped.push({ row: i + 1, reason: `${where}: ${reason}` });

    const publishedAt = parseDate(asString(rec.date));
    if (!publishedAt) return skip(`unrecognised date "${asString(rec.date)}" (use YYYY-MM-DD or YYYY-MM-DD HH:MM, UTC)`);

    const text = asString(rec.text).trim();
    const mediaKinds = rec.media !== undefined && asString(rec.media).trim() !== "" ? parseMedia(rec.media) : asString(rec.mediaurl).trim() ? (["image"] as AssetKind[]) : [];
    if (mediaKinds === "invalid") return skip(`unrecognised media "${asString(rec.media)}" (use image, video or none)`);
    if (!text && mediaKinds.length === 0) return skip("no text and no media");

    const metrics: Metrics = { collectedAt: opts.now.toISOString() };
    let any = false;
    for (const field of METRIC_FIELDS) {
      const n = parseCount(rec[field]);
      if (n === "invalid") return skip(`${field} is not a whole number ("${asString(rec[field])}")`);
      if (n !== undefined) {
        metrics[field] = n;
        any = true;
      }
    }

    const externalId =
      asString(rec.id).trim() || `import-${createHash("sha256").update(`${opts.channel}|${publishedAt}|${text}`).digest("hex").slice(0, 20)}`;
    const dupe = seen.get(externalId);
    if (dupe) return skip(`duplicate of ${dupe}`);
    seen.set(externalId, where);

    result.posts.push({
      channel: opts.channel,
      externalId,
      url: asString(rec.url).trim() || undefined,
      text,
      mediaKinds,
      publishedAt,
      metrics: any ? metrics : undefined,
    });
  });
  return result;
}
