import { readFileSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { CHANNELS, type Channel } from "../domain.js";
import { IMAGE_ASPECTS, type ImageAspect } from "../media.js";
import type { FetchLike } from "../adapters/types.js";
import { PostgresStore, type SqlClient } from "../postgres-store.js";
import { formatReport, runDoctor } from "./doctor.js";
import { buildDrive, buildEngine, buildStorage, type Env } from "./env.js";
import { describeDriveSync, syncDrive } from "../drive-sync.js";
import { describeMemoSync, syncMemos } from "../memo-sync.js";
import { brandFromEnv, buildCarousel } from "../carousel/build.js";
import { ClaudeCarouselWriter, DEFAULT_SLIDES, MAX_SLIDES, MIN_SLIDES } from "../carousel/write.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { audioMime, MAX_AUDIO_BYTES } from "../transcribe.js";
import { listBufferChannels } from "../adapters/buffer-channels.js";
import { parsePosts } from "./importer.js";
import { migrate } from "./migrate.js";

export const USAGE = `usage: social <command>

  doctor                                    check the setup (free, read-only, never prints secrets)
  notify-test                               send a test notification to NOTIFY_URL
  buffer-channels                           list your Buffer channels and ids (for BUFFER_CHANNELS)
  migrate                                   apply database migrations
  tick                                      publish everything that is due
  ingest <channel>                          read published posts from a channel
  refresh-metrics <channel>                 update metrics on known posts
  import <channel> <file.csv|file.json>     load posts you already published (with metrics, if you have them)
           [--dry-run]
  drive-sync                                copy new photos/videos from your Drive folder into storage (no cost)
           [--max <n>]
  carousel "<idea>" --channels a,b         write a carousel (pages drawn as images) and draft one variant per channel
           [--slides 4-12] [--keyword <word>] [--assets id,id]
           [--preview <dir>]                 only draw the pages into <dir> (no database, no storage)
  memo <audio-file>                         transcribe a recording and draft ideas from it (Gemini + Claude)
  memo --text "<what you said>"             draft ideas from text you already have (no transcription)
           [--name <label>]
  memo-sync                                 pick up new voice memos from your Drive folder and draft ideas from them
           [--max <n>]
  add-asset <image|video> <https-url>       register a photo or video you made yourself; prints its id
  media video "<prompt>"                    generate a video (costs money; capped per month)
           [--source <https image url>] [--model <id>] [--async]
  media image "<prompt>"                    generate an image with Gemini (costs money; same cap)
           [--source <https reference image url>] [--aspect 1:1|4:5|9:16]
  generate "<idea>" --channels a,b          create a brief and draft one variant per channel
           [--angle <text>] [--goal <text>] [--assets id,id]
`;

export interface CliDeps {
  env: Env;
  sleep?: (ms: number) => Promise<void>;
  sql: SqlClient;
  fetch?: FetchLike;
  now?: () => Date;
}

function channelArg(v: string | undefined): Channel {
  if (!v || !(CHANNELS as readonly string[]).includes(v)) throw new Error(`expected a channel (${CHANNELS.join(", ")}), got "${v ?? ""}"`);
  return v as Channel;
}

function slidesArg(v: string | undefined): number {
  if (v === undefined) return DEFAULT_SLIDES;
  const n = Number(v);
  if (!Number.isInteger(n) || n < MIN_SLIDES || n > MAX_SLIDES) throw new Error(`--slides must be a whole number from ${MIN_SLIDES} to ${MAX_SLIDES}`);
  return n;
}

/** Runs one command and returns what to print. Throws on failure. */
export async function runCli(argv: string[], deps: CliDeps): Promise<string> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      channels: { type: "string" },
      angle: { type: "string" },
      goal: { type: "string" },
      assets: { type: "string" },
      source: { type: "string" },
      model: { type: "string" },
      async: { type: "boolean" },
      aspect: { type: "string" },
      "dry-run": { type: "boolean" },
      max: { type: "string" },
      slides: { type: "string" },
      keyword: { type: "string" },
      preview: { type: "string" },
      text: { type: "string" },
      name: { type: "string" },
    },
  });
  const [command, ...rest] = positionals;
  if (command === "doctor") {
    const checks = await runDoctor({ env: deps.env, sql: deps.sql, fetch: deps.fetch, now: deps.now });
    const report = formatReport(checks);
    if (checks.some((c) => c.status === "fail")) throw new Error(report);
    return report;
  }
  if (command === "buffer-channels") {
    if (!deps.env.BUFFER_API_KEY) throw new Error("BUFFER_API_KEY is not set (Buffer → Settings → API)");
    return listBufferChannels({ apiKey: deps.env.BUFFER_API_KEY, fetch: deps.fetch });
  }
  if (command === "migrate") return `applied: ${JSON.stringify(await migrate(deps.sql))}`;

  if (command === "carousel" && values.preview) {
    // Draws the pages locally so the look and the writing can be judged before anything is stored or posted.
    if (!deps.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
    const idea = rest[0];
    if (!idea) throw new Error('usage: carousel "<idea>" --channels linkedin --preview <dir>');
    const channels = (values.channels ?? "linkedin").split(",").filter(Boolean).map(channelArg);
    const slideCount = slidesArg(values.slides);
    const built = await buildCarousel({
      writer: new ClaudeCarouselWriter({ apiKey: deps.env.ANTHROPIC_API_KEY, model: deps.env.CLAUDE_MODEL, fetch: deps.fetch }),
      input: { brief: { id: "preview", idea, sourcePostIds: [], assetIds: [], createdAt: new Date().toISOString() }, channels, insights: {}, examples: [], assets: [], slideCount, keyword: values.keyword },
      brand: brandFromEnv(deps.env),
      fetch: deps.fetch,
    });
    mkdirSync(values.preview, { recursive: true });
    built.images.forEach((img, i) => writeFileSync(join(values.preview!, `page-${String(i + 1).padStart(2, "0")}.jpg`), img));
    writeFileSync(join(values.preview, "captions.txt"), built.captions.map((c) => `[${c.channel}]\n${c.text}`).join("\n\n---\n\n"));
    return `${built.images.length} pages and ${built.captions.length} caption(s) written to ${values.preview}`;
  }

  const { engine, configuredChannels, notifier } = buildEngine(deps.env, new PostgresStore(deps.sql), { fetch: deps.fetch, now: deps.now, sleep: deps.sleep });

  switch (command) {
    case "notify-test": {
      if (!notifier) throw new Error("NOTIFY_URL is not set");
      await notifier.notify({ kind: "test", title: "Testnotis", message: "Det här är ett test från din innehållsmotor.", url: deps.env.APP_URL });
      return `test notification sent (${(notifier as { format?: string }).format ?? "webhook"})`;
    }
    case "tick":
      return JSON.stringify(await engine.tick());
    case "ingest": {
      const channel = channelArg(rest[0]);
      return `ingested ${await engine.ingest(channel)} posts from ${channel}`;
    }
    case "refresh-metrics": {
      const channel = channelArg(rest[0]);
      return `updated metrics on ${await engine.refreshMetrics(channel)} posts on ${channel}`;
    }
    case "import": {
      const channel = channelArg(rest[0]);
      const file = rest[1];
      if (!file) throw new Error("usage: import <channel> <file.csv|file.json> [--dry-run]");
      if (statSync(file).size > 5_000_000) throw new Error("the file is larger than 5 MB");
      const { posts, skipped } = parsePosts(readFileSync(file, "utf8"), { channel, now: (deps.now ?? (() => new Date()))() });
      if (!values["dry-run"]) await engine.importPosts(posts);
      const withMetrics = posts.filter((p) => p.metrics).length;
      const head = `${values["dry-run"] ? "would import" : "imported"} ${posts.length} post(s) into ${channel} (${withMetrics} with metrics)`;
      return skipped.length ? `${head}; skipped ${skipped.length}:\n${skipped.slice(0, 20).map((s) => `  ${s.reason}`).join("\n")}${skipped.length > 20 ? `\n  …and ${skipped.length - 20} more` : ""}` : head;
    }
    case "drive-sync": {
      const drive = buildDrive(deps.env, { fetch: deps.fetch, now: deps.now });
      if (!drive) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON and DRIVE_FOLDER_ID must be set (see docs/LINKEDIN.md)");
      const storage = buildStorage(deps.env, { fetch: deps.fetch });
      if (!storage) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set: Drive files are copied to public storage");
      const maxNew = values.max ? Number(values.max) : undefined;
      if (maxNew !== undefined && !(maxNew > 0)) throw new Error("--max must be a positive number");
      const result = await syncDrive({ drive, store: new PostgresStore(deps.sql), storage, now: deps.now, maxNew });
      const text = describeDriveSync(result);
      if (result.failed.length && !result.added.length && !result.updated.length) throw new Error(text);
      return text;
    }
    case "memo-sync": {
      const drive = buildDrive(deps.env, { fetch: deps.fetch, now: deps.now });
      if (!drive) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON and DRIVE_FOLDER_ID must be set (see docs/MEMOS.md)");
      const maxNew = values.max ? Number(values.max) : undefined;
      if (maxNew !== undefined && !(maxNew > 0)) throw new Error("--max must be a positive number");
      const result = await syncMemos({ drive, store: new PostgresStore(deps.sql), engine, maxNew });
      const text = describeMemoSync(result);
      if (result.failed.length && result.transcribed.length === 0 && result.planned === 0) throw new Error(text);
      return text;
    }
    case "memo": {
      const label = values.name;
      const memo = values.text
        ? await engine.addMemoFromText({ name: label ?? "Text", transcript: values.text })
        : await (async () => {
            const file = rest[0];
            if (!file) throw new Error('usage: memo <audio-file>  or  memo --text "<what you said>"');
            if (statSync(file).size > MAX_AUDIO_BYTES) throw new Error(`the file is larger than ${MAX_AUDIO_BYTES / 1024 / 1024} MB (about 25 minutes); split it`);
            const mimeType = audioMime("", file);
            if (!mimeType) throw new Error("unsupported audio format; use m4a, mp3, wav, aac, ogg, flac or webm");
            return engine.addMemoFromAudio({ name: label ?? basename(file), bytes: new Uint8Array(readFileSync(file)), mimeType });
          })();
      if (memo.status === "failed") throw new Error(`memo failed: ${memo.error}`);
      const done = await engine.processMemos();
      const after = await new PostgresStore(deps.sql).getMemo(memo.id);
      const summary = `memo ${memo.id}: ${after?.status ?? "unknown"}, ${after?.ideaCount ?? 0} idea(s), ${done.drafts} draft(s)`;
      if (after?.status !== "planned") throw new Error(`${summary}${after?.error ? `\n${after.error}` : ""}`);
      return after.error ? `${summary}\n${after.error}` : summary;
    }
    case "carousel": {
      const idea = rest[0];
      if (!idea) throw new Error('carousel needs an idea: social carousel "<idea>" --channels linkedin,instagram');
      const channels = (values.channels ?? configuredChannels.join(",")).split(",").filter(Boolean).map(channelArg);
      if (channels.length === 0) throw new Error("no channels given and none configured");
      const assetIds = (values.assets ?? "").split(",").filter(Boolean);
      const brief = await engine.createBrief({ idea, assetIds, format: "carousel", ctaKeyword: values.keyword });
      const drafts = await engine.createCarousel(brief.id, channels, { slideCount: slidesArg(values.slides), keyword: values.keyword });
      return drafts.map((d) => `${d.channel}\t${d.status}\t${d.id}\t${d.assetIds.length} pages`).join("\n");
    }
    case "add-asset": {
      const [kind, uri] = rest;
      if ((kind !== "image" && kind !== "video") || !uri) throw new Error("usage: add-asset <image|video> <https-url>");
      if (!uri.startsWith("https://")) throw new Error("the asset must be a public https URL");
      return (await engine.addCapturedAsset(kind, uri)).id;
    }
    case "media": {
      if (rest[0] === "image" && rest[1]) {
        const aspect = (values.aspect ?? "4:5") as ImageAspect;
        if (!IMAGE_ASPECTS.includes(aspect)) throw new Error(`--aspect must be one of ${IMAGE_ASPECTS.join(", ")}`);
        const asset = await engine.generateImage({ prompt: rest[1], aspect, referenceImageUri: values.source });
        return `asset ${asset.id}`;
      }
      if (rest[0] !== "video" || !rest[1]) throw new Error('usage: media video|image "<prompt>" [--source <https image url>] ...');
      const job = await engine.startVideo({ prompt: rest[1], sourceImageUri: values.source, model: values.model });
      if (values.async) return `job ${job.id} started (estimated ${job.estimatedCostUsd.toFixed(2)} USD); \`tick\` collects it when ready`;
      const done = await engine.waitForJob(job.id, { sleep: deps.sleep });
      if (done.status === "completed") return `asset ${done.assetId}`;
      if (done.status === "failed") throw new Error(`video generation failed: ${done.error}`);
      return `job ${done.id} is still running (estimated ${done.estimatedCostUsd.toFixed(2)} USD); \`tick\` collects it when ready`;
    }
    case "generate": {
      const idea = rest[0];
      if (!idea) throw new Error('generate needs an idea: social generate "<idea>" --channels linkedin,instagram');
      const channels = (values.channels ?? configuredChannels.join(",")).split(",").filter(Boolean).map(channelArg);
      if (channels.length === 0) throw new Error("no channels given and none configured");
      const assetIds = (values.assets ?? "").split(",").filter(Boolean);
      const brief = await engine.createBrief({ idea, angle: values.angle, goal: values.goal, assetIds });
      const drafts = await engine.proposeVariants(brief.id, channels);
      return drafts.map((d) => `${d.channel}\t${d.status}\t${d.id}`).join("\n") || "generator returned no variants";
    }
    default:
      throw new Error(`unknown command "${command ?? ""}"\n\n${USAGE}`);
  }
}
