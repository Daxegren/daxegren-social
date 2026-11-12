import type { FetchLike } from "../adapters/types.js";
import { PostgresStore, type SqlClient } from "../postgres-store.js";
import { DEFAULT_MONTHLY_CAP_USD, monthStartIso } from "../media.js";
import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_GEMINI_IMAGE_MODEL } from "../adapters/gemini-image.js";
import { claudeClient, DEFAULT_CLAUDE_MODEL } from "../claude.js";
import { loadBufferAccount } from "../adapters/buffer-channels.js";
import { bufferService } from "../adapters/buffer.js";
import { DEFAULT_LINKEDIN_VERSION } from "../adapters/linkedin.js";
import { buildDrive, buildEngine, parseBufferChannels, type Env } from "./env.js";
import { migrationFiles } from "./migrate.js";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorDeps {
  env: Env;
  sql: SqlClient;
  fetch?: FetchLike;
  now?: () => Date;
}

const SECRET_KEY = /KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL|NOTIFY_URL|SERVICE_ACCOUNT/i;

/** Removes every secret value in `env` from `text`, so no check can leak a credential into a log. */
export function scrubSecrets(text: string, env: Env): string {
  let out = text;
  for (const [k, v] of Object.entries(env)) {
    if (!v || v.length < 7 || !SECRET_KEY.test(k)) continue;
    // `id:secret` credentials, and the topic at the end of a webhook address (which is its only protection).
    for (const part of [v, ...v.split(":"), v.split("/").pop() ?? ""]) if (part.length >= 7) out = out.split(part).join("[redacted]");
    // A service-account key file: the private key itself, however it is formatted.
    if (v.trimStart().startsWith("{")) {
      try {
        const pk = (JSON.parse(v) as { private_key?: string }).private_key;
        if (pk && pk.length >= 7) out = out.split(pk).join("[redacted]");
      } catch {
        /* not JSON */
      }
    }
  }
  return out;
}

/** Direct (non-Buffer) credentials are present for the channel. */
const directCredentials = (env: Env, channel: string) =>
  (channel === "linkedin" && env.LINKEDIN_AUTHOR_URN && env.LINKEDIN_ACCESS_TOKEN) ||
  (channel === "instagram" && env.INSTAGRAM_USER_ID && env.INSTAGRAM_ACCESS_TOKEN) ||
  (channel === "facebook" && env.FACEBOOK_PAGE_ID && env.FACEBOOK_PAGE_ACCESS_TOKEN);

const ok = (name: string, detail: string): Check => ({ name, status: "ok", detail });
const warn = (name: string, detail: string): Check => ({ name, status: "warn", detail });
const fail = (name: string, detail: string): Check => ({ name, status: "fail", detail });
const skip = (name: string, detail: string): Check => ({ name, status: "skip", detail });

/** Read-only, free checks of everything the engine depends on. Never spends money and never prints a secret. */
export async function runDoctor(deps: DoctorDeps): Promise<Check[]> {
  const { env, sql } = deps;
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const checks: Check[] = [];

  const run = async (name: string, fn: () => Promise<Check | Check[]>) => {
    try {
      const r = await fn();
      checks.push(...(Array.isArray(r) ? r : [r]));
    } catch (err) {
      checks.push(fail(name, scrubSecrets((err as Error).message, env)));
    }
  };

  await run("config", async () => {
    const { configuredChannels } = buildEngine(env, new PostgresStore(sql));
    const auto = env.AUTO_APPROVE_CHANNELS?.trim();
    return configuredChannels.length === 0
      ? warn("channels", "no channel has credentials, so nothing can be published (set INSTAGRAM_* or LINKEDIN_*)")
      : ok("channels", `publishing enabled for ${configuredChannels.join(", ")}${auto ? `; auto-approve: ${auto}` : "; every draft needs your approval"}`);
  });

  await run("notifications", async () => {
    if (!env.NOTIFY_URL) return skip("notifications", "NOTIFY_URL not set (optional: a push message to your phone when something happens)");
    const { WebhookNotifier } = await import("../notify.js");
    const n = new WebhookNotifier({ url: env.NOTIFY_URL, format: env.NOTIFY_FORMAT as never });
    return ok("notifications", `configured (${n.format}); run notify-test to see one arrive${env.APP_URL ? "" : "; set APP_URL so a tap opens the app"}`);
  });

  await run("database", async () => {
    await sql.query("select 1");
    const files = migrationFiles();
    let applied: string[];
    try {
      applied = (await sql.query<{ name: string }>("select name from social_migrations")).map((r) => r.name);
    } catch {
      return fail("database", "connected, but no migrations have run. Run: npm run social -- migrate");
    }
    const missing = files.filter((x) => !applied.includes(x));
    const out: Check[] = [
      missing.length
        ? fail("database", `connected, but ${missing.length} migration(s) are missing (${missing.join(", ")}). Run: npm run social -- migrate`)
        : ok("database", `connected; ${files.length}/${files.length} migrations applied`),
    ];
    if (!missing.length) {
      const n = (await sql.query<{ n: number }>("select count(*)::int as n from social_admins"))[0]?.n ?? 0;
      out.push(n === 0 ? warn("reviewer", "no row in social_admins, so the review queue will be empty for everyone") : ok("reviewer", `${n} reviewer(s) registered`));
    }
    return out;
  });

  await run("media budget", async () => {
    const cap = env.MEDIA_MONTHLY_CAP_USD ? Number(env.MEDIA_MONTHLY_CAP_USD) : DEFAULT_MONTHLY_CAP_USD;
    const spent = await new PostgresStore(sql).mediaSpendUsd(monthStartIso(now()));
    return ok("media budget", `${spent.toFixed(2)} of ${cap.toFixed(2)} USD used this month`);
  });

  await run("storage", async () => {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return skip("storage", "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (needed to store generated media)");
    const bucket = env.SOCIAL_MEDIA_BUCKET ?? "social-media";
    const res = await f(`${env.SUPABASE_URL.replace(/\/+$/, "")}/storage/v1/bucket/${encodeURIComponent(bucket)}`, {
      headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, apikey: env.SUPABASE_SERVICE_ROLE_KEY },
    });
    if (res.status === 404 || res.status === 400) return fail("storage", `bucket "${bucket}" not found. Migration 0005 creates it; otherwise create a public bucket with that name`);
    if (!res.ok) return fail("storage", `HTTP ${res.status} from Supabase Storage (wrong URL or service-role key?)`);
    const body = (await res.json()) as { public?: boolean };
    return body.public ? ok("storage", `bucket "${bucket}" exists and is public`) : fail("storage", `bucket "${bucket}" exists but is private; the platforms need public URLs`);
  });

  await run("drive", async () => {
    if (!env.GOOGLE_SERVICE_ACCOUNT_JSON && !env.DRIVE_FOLDER_ID) return skip("drive", "GOOGLE_SERVICE_ACCOUNT_JSON / DRIVE_FOLDER_ID not set (needed to build posts from photos in Drive)");
    if (!env.GOOGLE_SERVICE_ACCOUNT_JSON || !env.DRIVE_FOLDER_ID) return fail("drive", "set both GOOGLE_SERVICE_ACCOUNT_JSON and DRIVE_FOLDER_ID");
    const drive = buildDrive(env, { fetch: f, now });
    const files = await drive!.listMedia();
    return ok("drive", `signed in as ${drive!.clientEmail}; ${files.length} photo/video file(s) found in the folder`);
  });

  await run("anthropic", async () => {
    if (!env.ANTHROPIC_API_KEY) return skip("anthropic", "ANTHROPIC_API_KEY not set (needed to generate drafts)");
    const client = claudeClient({ apiKey: env.ANTHROPIC_API_KEY, fetch: f, maxRetries: 0 });
    let ids: string[];
    try {
      ids = (await client.models.list({ limit: 100 })).data.map((m) => m.id);
    } catch (err) {
      if (err instanceof Anthropic.APIError && (err.status === 401 || err.status === 403)) return fail("anthropic", `key rejected (HTTP ${err.status})`);
      throw err;
    }
    const model = env.CLAUDE_MODEL ?? DEFAULT_CLAUDE_MODEL;
    return ids.length && !ids.includes(model) ? warn("anthropic", `key works, but model "${model}" is not in the list. Set CLAUDE_MODEL`) : ok("anthropic", `key works; model ${model}`);
  });

  await run("gemini", async () => {
    if (!env.GEMINI_API_KEY) return skip("gemini", "GEMINI_API_KEY not set (needed for image generation)");
    const res = await f("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", { headers: { "x-goog-api-key": env.GEMINI_API_KEY } });
    if (res.status === 400 || res.status === 401 || res.status === 403) return fail("gemini", `key rejected (HTTP ${res.status}). It must be a Google AI Studio API key, not a Gemini subscription`);
    if (!res.ok) return fail("gemini", `HTTP ${res.status}`);
    const models = ((await res.json()) as { models?: Array<{ name: string }> }).models ?? [];
    const wanted = env.GEMINI_IMAGE_MODEL ?? DEFAULT_GEMINI_IMAGE_MODEL;
    if (models.some((m) => m.name === `models/${wanted}`)) return ok("gemini", `key works; model ${wanted} is listed`);
    // The Interactions API may serve models the classic list does not show, so this is a hint, not a failure.
    const similar = models.map((m) => m.name.replace("models/", "")).filter((n) => /image|banana/i.test(n)).slice(0, 6);
    return warn("gemini", `key works, but "${wanted}" is not in the model list${similar.length ? ` (image models listed: ${similar.join(", ")})` : ""}. If generation fails with a model error, set GEMINI_IMAGE_MODEL`);
  });

  await run("higgsfield", async () => (env.HIGGSFIELD_API_KEY ? skip("higgsfield", "key is set; there is no free check, so the first video run is the test") : skip("higgsfield", "HIGGSFIELD_API_KEY not set (needed for video)")));

  await run("instagram", async () => {
    if (!env.INSTAGRAM_USER_ID || !env.INSTAGRAM_ACCESS_TOKEN) return skip("instagram", "INSTAGRAM_USER_ID / INSTAGRAM_ACCESS_TOKEN not set");
    const qs = new URLSearchParams({ fields: "id,username", access_token: env.INSTAGRAM_ACCESS_TOKEN });
    const res = await f(`https://graph.facebook.com/v21.0/${encodeURIComponent(env.INSTAGRAM_USER_ID)}?${qs}`);
    const body = (await res.json().catch(() => ({}))) as { username?: string; error?: { message?: string } };
    if (!res.ok) return fail("instagram", scrubSecrets(`HTTP ${res.status}: ${body.error?.message ?? "request failed"}`, env));
    return ok("instagram", `token works; account ${body.username ?? env.INSTAGRAM_USER_ID}`);
  });

  await run("buffer", async () => {
    if (!env.BUFFER_API_KEY) return skip("buffer", "BUFFER_API_KEY not set (optional: Buffer can publish and report results for your channels)");
    const wanted = parseBufferChannels(env);
    const account = await loadBufferAccount({ apiKey: env.BUFFER_API_KEY, fetch: f });
    const all = account.organizations.flatMap((o) => o.channels);
    const out: Check[] = [ok("buffer", `key works; ${account.organizations.length} organization(s), ${all.length} channel(s)`)];
    if (wanted.length === 0) {
      return [...out, warn("buffer channels", "BUFFER_CHANNELS is not set, so Buffer is not used for publishing. Run buffer-channels to see ids")];
    }
    for (const [channel, id] of wanted) {
      const found = all.find((c) => c.id === id);
      const name = `buffer ${channel}`;
      if (!found) out.push(fail(name, `channel id ${id} is not in your Buffer account. Run buffer-channels`));
      else if (found.service !== bufferService(channel)) out.push(fail(name, `that id is a ${found.service} channel, not ${channel}`));
      else if (found.isDisconnected) out.push(fail(name, `${found.displayName ?? found.name ?? id} is disconnected in Buffer: reconnect it there`));
      else if (found.isLocked) out.push(fail(name, `${found.displayName ?? found.name ?? id} is locked (over the plan's channel limit)`));
      else out.push(ok(name, `posts go to ${found.displayName ?? found.name ?? id} through Buffer${directCredentials(env, channel) ? " (replaces the direct credentials you also set)" : ""}`));
    }
    return out;
  });

  await run("facebook", async () => {
    if (!env.FACEBOOK_PAGE_ID || !env.FACEBOOK_PAGE_ACCESS_TOKEN) return skip("facebook", "FACEBOOK_PAGE_ID / FACEBOOK_PAGE_ACCESS_TOKEN not set");
    const qs = new URLSearchParams({ fields: "id,name", access_token: env.FACEBOOK_PAGE_ACCESS_TOKEN });
    const res = await f(`https://graph.facebook.com/v21.0/${encodeURIComponent(env.FACEBOOK_PAGE_ID)}?${qs}`);
    const body = (await res.json().catch(() => ({}))) as { name?: string; error?: { message?: string } };
    if (!res.ok) return fail("facebook", scrubSecrets(`HTTP ${res.status}: ${body.error?.message ?? "request failed"}`, env));
    return ok("facebook", `token works; page ${body.name ?? env.FACEBOOK_PAGE_ID}. Posting also needs the pages_manage_posts permission`);
  });

  await run("linkedin", async () => {
    if (!env.LINKEDIN_AUTHOR_URN || !env.LINKEDIN_ACCESS_TOKEN) return skip("linkedin", "LINKEDIN_AUTHOR_URN / LINKEDIN_ACCESS_TOKEN not set");
    const urn = /^urn:li:(person|organization):[A-Za-z0-9_-]+$/.test(env.LINKEDIN_AUTHOR_URN)
      ? skip("linkedin", "author URN looks right; there is no free check for the token, so the first post is the test")
      : fail("linkedin", "LINKEDIN_AUTHOR_URN must look like urn:li:person:<id> or urn:li:organization:<id>");

    // LinkedIn supports each monthly API version for about a year and then rejects it.
    const version = env.LINKEDIN_API_VERSION ?? DEFAULT_LINKEDIN_VERSION;
    const m = /^(\d{4})(0[1-9]|1[0-2])$/.exec(version);
    if (!m) return [urn, fail("linkedin version", `LINKEDIN_API_VERSION must be YYYYMM, got "${version}"`)];
    const today = now();
    const age = today.getUTCFullYear() * 12 + today.getUTCMonth() + 1 - (Number(m[1]) * 12 + Number(m[2]));
    const where = env.LINKEDIN_API_VERSION ? "LINKEDIN_API_VERSION" : "the built-in default";
    return [
      urn,
      age >= 13
        ? fail("linkedin version", `${version} (${where}) is ${age} months old and has most likely been sunset. Set LINKEDIN_API_VERSION to a recent YYYYMM`)
        : age >= 10
          ? warn("linkedin version", `${version} (${where}) is ${age} months old; LinkedIn supports a version for about a year. Set LINKEDIN_API_VERSION to a newer YYYYMM`)
          : ok("linkedin version", `${version} (${where}), ${Math.max(age, 0)} month(s) old`),
    ];
  });

  return checks;
}

const SYMBOL: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗", skip: "-" };

export function formatReport(checks: Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length));
  const lines = checks.map((c) => `${SYMBOL[c.status]} ${c.name.padEnd(width)}  ${c.detail}`);
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  return `${lines.join("\n")}\n\n${fails ? `${fails} problem(s) to fix` : "no problems found"}${warns ? `, ${warns} warning(s)` : ""}`;
}
