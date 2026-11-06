import type { SupabaseClient } from "@supabase/supabase-js";
import type { Asset, Channel, ContentBrief, PostVariant, VariantStatus } from "../../src/domain.js";

/** What the review queue needs from the backend. Faked in tests. */
export interface SocialApi {
  listVariants(status: VariantStatus): Promise<PostVariant[]>;
  getAssets(ids: string[]): Promise<Asset[]>;
  approve(id: string, input: { text: string; scheduledAt: Date }): Promise<void>;
  reject(id: string): Promise<void>;
  /** Puts a failed post back in the queue (resets attempts and error). */
  retry(id: string): Promise<void>;
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

    async retry(id) {
      // A database function (not a table update): it also resets the attempt counter and error, which the app may not write.
      const { error } = await client.rpc("social_retry_variant", { p_id: id });
      if (error) throw new Error(error.code === "P0002" ? "Inlägget är inte längre markerat som misslyckat. Ladda om listan." : error.message);
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

// ── Create: upload own media and request drafts ─────────────────────────────

export const MEDIA_BUCKET = "social-media";
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const ALLOWED_UPLOAD_TYPES = ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime"];

/** Returns a Swedish reason the file cannot be used, or undefined when it can. */
export function validateUpload(file: { name: string; type: string; size: number }): string | undefined {
  if (/heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)) {
    return `${file.name}: HEIC stöds inte av plattformarna. På iPhone: Inställningar › Kamera › Format › Mest kompatibel, eller välj en JPEG.`;
  }
  if (!ALLOWED_UPLOAD_TYPES.includes(file.type)) return `${file.name}: filtypen stöds inte (använd JPEG, PNG, WebP, MP4 eller MOV).`;
  if (file.size > MAX_UPLOAD_BYTES) return `${file.name}: filen är större än ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`;
  return undefined;
}

export interface CreateApi {
  listAssets(limit?: number): Promise<Asset[]>;
  uploadAsset(file: File): Promise<Asset>;
  requestDrafts(input: { idea: string; angle?: string; goal?: string; channels: Channel[]; assetIds: string[] }): Promise<void>;
  listRequests(limit?: number): Promise<ContentBrief[]>;
}

function toBrief(r: Row): ContentBrief {
  return {
    id: r.id,
    idea: r.idea,
    angle: opt(r.angle),
    goal: opt(r.goal),
    sourcePostIds: r.source_post_ids ?? [],
    assetIds: r.asset_ids ?? [],
    channels: opt(r.channels),
    status: r.status,
    error: opt(r.error),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export function supabaseCreateApi(client: SupabaseClient): CreateApi {
  return {
    async listAssets(limit = 24) {
      const { data, error } = await client.from("social_assets").select("*").order("created_at", { ascending: false }).limit(limit);
      if (error) throw new Error(error.message);
      return (data ?? []).map(toAsset);
    },

    async uploadAsset(file) {
      const problem = validateUpload(file);
      if (problem) throw new Error(problem);
      const { data: auth, error: authError } = await client.auth.getUser();
      if (authError || !auth.user?.id) throw new Error("Du är inte inloggad.");

      const ext = file.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || (file.type.startsWith("video/") ? "mp4" : "jpg");
      // uploads/<own user id>/…: the only place the storage policy lets a reviewer write.
      const path = `uploads/${auth.user.id}/${crypto.randomUUID()}.${ext}`;
      const up = await client.storage.from(MEDIA_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
      if (up.error) throw new Error(up.error.message);

      const { data: pub } = client.storage.from(MEDIA_BUCKET).getPublicUrl(path);
      const { data, error } = await client
        .from("social_assets")
        .insert({ kind: file.type.startsWith("video/") ? "video" : "image", origin: "captured", uri: pub.publicUrl, meta: { filename: file.name, size: file.size } })
        .select("*")
        .single();
      if (error) {
        await client.storage.from(MEDIA_BUCKET).remove([path]).catch(() => undefined); // do not leave an orphan behind
        throw new Error(error.message);
      }
      return toAsset(data);
    },

    async requestDrafts({ idea, angle, goal, channels, assetIds }) {
      const { error } = await client
        .from("social_briefs")
        .insert({ idea, angle: angle || null, goal: goal || null, channels, asset_ids: assetIds, status: "requested" });
      if (error) throw new Error(error.message);
    },

    async listRequests(limit = 10) {
      const { data, error } = await client
        .from("social_briefs")
        .select("*")
        .not("channels", "is", null)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      return (data ?? []).map(toBrief);
    },
  };
}
