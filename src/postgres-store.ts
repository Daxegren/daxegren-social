import type {
  Asset,
  AssetKind,
  Channel,
  ContentBrief,
  Metrics,
  PostVariant,
  PublishedPost,
  VariantStatus,
} from "./domain.js";
import type { Store } from "./store.js";

/**
 * The only thing the store needs from a database driver. Adapt any driver:
 *   pg:          { query: async (t, p) => (await pool.query(t, p)).rows }
 *   postgres.js: { query: (t, p) => sql.unsafe(t, p) }
 *   PGlite:      { query: async (t, p) => (await db.query(t, p)).rows }
 */
export interface SqlClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

type Row = Record<string, any>;

const iso = (v: unknown): string | undefined =>
  v === null || v === undefined ? undefined : v instanceof Date ? v.toISOString() : new Date(v as string).toISOString();
const opt = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

function toAsset(r: Row): Asset {
  return { id: r.id, kind: r.kind, origin: r.origin, uri: r.uri, createdAt: iso(r.created_at)!, meta: opt(r.meta) };
}

function toPost(r: Row): PublishedPost {
  return {
    id: r.id,
    channel: r.channel,
    externalId: r.external_id,
    url: opt(r.url),
    text: r.body,
    mediaKinds: r.media_kinds as AssetKind[],
    publishedAt: iso(r.published_at)!,
    metrics: opt(r.metrics) as Metrics | undefined,
    variantId: opt(r.variant_id),
  };
}

function toBrief(r: Row): ContentBrief {
  return {
    id: r.id,
    idea: r.idea,
    angle: opt(r.angle),
    goal: opt(r.goal),
    sourcePostIds: r.source_post_ids,
    assetIds: r.asset_ids,
    createdAt: iso(r.created_at)!,
  };
}

function toVariant(r: Row): PostVariant {
  return {
    id: r.id,
    briefId: r.brief_id,
    channel: r.channel,
    text: r.body,
    assetIds: r.asset_ids,
    status: r.status,
    rationale: opt(r.rationale),
    scheduledAt: iso(r.scheduled_at),
    attempts: r.attempts,
    lastError: opt(r.last_error),
    externalId: opt(r.external_id),
    url: opt(r.url),
    publishedAt: iso(r.published_at),
    createdAt: iso(r.created_at)!,
  };
}

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

/** Store backed by the tables in db/migrations. */
export class PostgresStore implements Store {
  constructor(private readonly sql: SqlClient) {}

  async putAsset(a: Asset) {
    await this.sql.query(
      `insert into social_assets (id, kind, origin, uri, meta, created_at)
       values ($1, $2, $3, $4, $5::jsonb, $6)
       on conflict (id) do update set kind = excluded.kind, origin = excluded.origin,
         uri = excluded.uri, meta = excluded.meta`,
      [a.id, a.kind, a.origin, a.uri, json(a.meta), a.createdAt],
    );
  }

  async getAssets(ids: string[]) {
    if (ids.length === 0) return [];
    const rows = await this.sql.query<Row>(`select * from social_assets where id = any($1::uuid[])`, [ids]);
    const byId = new Map(rows.map((r) => [r.id as string, toAsset(r)]));
    return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  }

  async upsertPost(p: PublishedPost) {
    // variant_id and metrics are kept when the incoming post does not carry them,
    // so re-ingesting a post we published ourselves cannot erase its provenance.
    const rows = await this.sql.query<Row>(
      `insert into social_posts (id, channel, external_id, url, body, media_kinds, published_at, metrics, variant_id)
       values ($1, $2, $3, $4, $5, $6::text[], $7, $8::jsonb, $9)
       on conflict (channel, external_id) do update set
         url = excluded.url, body = excluded.body, media_kinds = excluded.media_kinds,
         published_at = excluded.published_at,
         metrics = coalesce(excluded.metrics, social_posts.metrics),
         variant_id = coalesce(excluded.variant_id, social_posts.variant_id)
       returning *`,
      [p.id, p.channel, p.externalId, p.url ?? null, p.text, p.mediaKinds, p.publishedAt, json(p.metrics), p.variantId ?? null],
    );
    return toPost(rows[0]!);
  }

  async listPosts(filter?: { channel?: Channel }) {
    const rows = filter?.channel
      ? await this.sql.query<Row>(`select * from social_posts where channel = $1 order by published_at`, [filter.channel])
      : await this.sql.query<Row>(`select * from social_posts order by published_at`);
    return rows.map(toPost);
  }

  async getPost(id: string) {
    const rows = await this.sql.query<Row>(`select * from social_posts where id = $1`, [id]);
    return rows[0] ? toPost(rows[0]) : undefined;
  }

  async putBrief(b: ContentBrief) {
    await this.sql.query(
      `insert into social_briefs (id, idea, angle, goal, source_post_ids, asset_ids, created_at)
       values ($1, $2, $3, $4, $5::uuid[], $6::uuid[], $7)
       on conflict (id) do update set idea = excluded.idea, angle = excluded.angle, goal = excluded.goal,
         source_post_ids = excluded.source_post_ids, asset_ids = excluded.asset_ids`,
      [b.id, b.idea, b.angle ?? null, b.goal ?? null, b.sourcePostIds, b.assetIds, b.createdAt],
    );
  }

  async getBrief(id: string) {
    const rows = await this.sql.query<Row>(`select * from social_briefs where id = $1`, [id]);
    return rows[0] ? toBrief(rows[0]) : undefined;
  }

  async putVariant(v: PostVariant) {
    await this.sql.query(
      `insert into social_variants (id, brief_id, channel, body, asset_ids, status, rationale, scheduled_at,
         attempts, last_error, external_id, url, published_at, created_at)
       values ($1, $2, $3, $4, $5::uuid[], $6, $7, $8, $9, $10, $11, $12, $13, $14)
       on conflict (id) do update set channel = excluded.channel, body = excluded.body,
         asset_ids = excluded.asset_ids, status = excluded.status, rationale = excluded.rationale,
         scheduled_at = excluded.scheduled_at, attempts = excluded.attempts, last_error = excluded.last_error,
         external_id = excluded.external_id, url = excluded.url, published_at = excluded.published_at`,
      [
        v.id, v.briefId, v.channel, v.text, v.assetIds, v.status, v.rationale ?? null, v.scheduledAt ?? null,
        v.attempts, v.lastError ?? null, v.externalId ?? null, v.url ?? null, v.publishedAt ?? null, v.createdAt,
      ],
    );
  }

  async getVariant(id: string) {
    const rows = await this.sql.query<Row>(`select * from social_variants where id = $1`, [id]);
    return rows[0] ? toVariant(rows[0]) : undefined;
  }

  async listVariants(filter?: { status?: VariantStatus; briefId?: string }) {
    const rows = await this.sql.query<Row>(
      `select * from social_variants
       where ($1::text is null or status = $1) and ($2::uuid is null or brief_id = $2)
       order by created_at`,
      [filter?.status ?? null, filter?.briefId ?? null],
    );
    return rows.map(toVariant);
  }

  async transitionVariant(id: string, from: VariantStatus, to: VariantStatus) {
    const rows = await this.sql.query<Row>(
      `update social_variants set status = $3 where id = $1 and status = $2 returning *`,
      [id, from, to],
    );
    return rows[0] ? toVariant(rows[0]) : undefined;
  }
}
