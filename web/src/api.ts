import type { SupabaseClient } from "@supabase/supabase-js";
import type { Asset, PostVariant, VariantStatus } from "../../src/domain.js";

/** What the review queue needs from the backend. Faked in tests. */
export interface SocialApi {
  listVariants(status: VariantStatus): Promise<PostVariant[]>;
  getAssets(ids: string[]): Promise<Asset[]>;
  approve(id: string, input: { text: string; scheduledAt: Date }): Promise<void>;
  reject(id: string): Promise<void>;
}

type Row = Record<string, any>;

const opt = <T,>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);
const iso = (v: string | null | undefined) => (v ? new Date(v).toISOString() : undefined);

export function toVariant(r: Row): PostVariant {
  return {
    id: r.id,
    briefId: r.brief_id,
    channel: r.channel,
    text: r.body,
    assetIds: r.asset_ids ?? [],
    status: r.status,
    rationale: opt(r.rationale),
    scheduledAt: iso(r.scheduled_at),
    attempts: r.attempts,
    lastError: opt(r.last_error),
    externalId: opt(r.external_id),
    url: opt(r.url),
    publishedAt: iso(r.published_at),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

function toAsset(r: Row): Asset {
  return { id: r.id, kind: r.kind, origin: r.origin, uri: r.uri, createdAt: new Date(r.created_at).toISOString(), meta: opt(r.meta) };
}

/** Row level security (migration 0002) is what actually protects the data; this only talks to PostgREST. */
export function supabaseSocialApi(client: SupabaseClient): SocialApi {
  return {
    async listVariants(status) {
      const { data, error } = await client
        .from("social_variants")
        .select("*")
        .eq("status", status)
        .order(status === "draft" ? "created_at" : "scheduled_at", { ascending: status === "draft" });
      if (error) throw new Error(error.message);
      return (data ?? []).map(toVariant);
    },

    async getAssets(ids) {
      if (ids.length === 0) return [];
      const { data, error } = await client.from("social_assets").select("*").in("id", ids);
      if (error) throw new Error(error.message);
      return (data ?? []).map(toAsset);
    },

    async approve(id, { text, scheduledAt }) {
      const { data, error } = await client
        .from("social_variants")
        .update({ body: text, scheduled_at: scheduledAt.toISOString(), status: "scheduled" })
        .eq("id", id)
        .eq("status", "draft")
        .select("id");
      if (error) throw new Error(error.message);
      // RLS hides non-draft rows from UPDATE, so "nothing updated" means it was changed elsewhere (or no access).
      if (!data || data.length === 0) throw new Error("Utkastet finns inte längre som utkast. Ladda om listan.");
    },

    async reject(id) {
      const { data, error } = await client
        .from("social_variants")
        .update({ status: "rejected" })
        .eq("id", id)
        .eq("status", "draft")
        .select("id");
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) throw new Error("Utkastet finns inte längre som utkast. Ladda om listan.");
    },
  };
}
