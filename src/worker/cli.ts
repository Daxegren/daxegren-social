import { parseArgs } from "node:util";
import { CHANNELS, type Channel } from "../domain.js";
import type { FetchLike } from "../adapters/types.js";
import { PostgresStore, type SqlClient } from "../postgres-store.js";
import { buildEngine, type Env } from "./env.js";
import { migrate } from "./migrate.js";

export const USAGE = `usage: social <command>

  migrate                                   apply database migrations
  tick                                      publish everything that is due
  ingest <channel>                          read published posts from a channel
  refresh-metrics <channel>                 update metrics on known posts
  generate "<idea>" --channels a,b          create a brief and draft one variant per channel
           [--angle <text>] [--goal <text>]
`;

export interface CliDeps {
  env: Env;
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
    },
  });
  const [command, ...rest] = positionals;
  if (command === "migrate") return `applied: ${JSON.stringify(await migrate(deps.sql))}`;

  const { engine, configuredChannels } = buildEngine(deps.env, new PostgresStore(deps.sql), { fetch: deps.fetch, now: deps.now });

  switch (command) {
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
    case "generate": {
      const idea = rest[0];
      if (!idea) throw new Error('generate needs an idea: social generate "<idea>" --channels linkedin,instagram');
      const channels = (values.channels ?? configuredChannels.join(",")).split(",").filter(Boolean).map(channelArg);
      if (channels.length === 0) throw new Error("no channels given and none configured");
      const brief = await engine.createBrief({ idea, angle: values.angle, goal: values.goal });
      const drafts = await engine.proposeVariants(brief.id, channels);
      return drafts.map((d) => `${d.channel}\t${d.status}\t${d.id}`).join("\n") || "generator returned no variants";
    }
    default:
      throw new Error(`unknown command "${command ?? ""}"\n\n${USAGE}`);
  }
}
