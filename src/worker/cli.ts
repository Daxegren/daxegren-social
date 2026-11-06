import { readFileSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { CHANNELS, type Channel } from "../domain.js";
import { IMAGE_ASPECTS, type ImageAspect } from "../media.js";
import type { FetchLike } from "../adapters/types.js";
import { PostgresStore, type SqlClient } from "../postgres-store.js";
import { formatReport, runDoctor } from "./doctor.js";
import { buildEngine, type Env } from "./env.js";
import { parsePosts } from "./importer.js";
import { migrate } from "./migrate.js";

export const USAGE = `usage: social <command>

  doctor                                    check the setup (free, read-only, never prints secrets)
  notify-test                               send a test notification to NOTIFY_URL
  migrate                                   apply database migrations
  tick                                      publish everything that is due
  ingest <channel>                          read published posts from a channel
  refresh-metrics <channel>                 update metrics on known posts
  import <channel> <file.csv|file.json>     load posts you already published (with metrics, if you have them)
           [--dry-run]
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
    },
  });
  const [command, ...rest] = positionals;
  if (command === "doctor") {
    const checks = await runDoctor({ env: deps.env, sql: deps.sql, fetch: deps.fetch, now: deps.now });
    const report = formatReport(checks);
    if (checks.some((c) => c.status === "fail")) throw new Error(report);
    return report;
  }
  if (command === "migrate") return `applied: ${JSON.stringify(await migrate(deps.sql))}`;

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
