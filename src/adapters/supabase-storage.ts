import type { MediaStorage } from "../media.js";
import { requestJson } from "./http.js";
import type { FetchLike } from "./types.js";

export interface SupabaseStorageConfig {
  /** `https://<ref>.supabase.co` */
  url: string;
  /** Service-role key. Server side only. */
  serviceRoleKey: string;
  /** A *public* bucket; create it once in the dashboard. Paths are unguessable uuids. */
  bucket?: string;
  fetch?: FetchLike;
}

export class SupabaseStorage implements MediaStorage {
  private readonly fetchFn: FetchLike;
  private readonly bucket: string;
  private readonly base: string;

  constructor(private readonly cfg: SupabaseStorageConfig) {
    this.fetchFn = cfg.fetch ?? fetch;
    this.bucket = cfg.bucket ?? "social-media";
    this.base = cfg.url.replace(/\/+$/, "");
  }

  async put(path: string, bytes: Uint8Array, mimeType: string): Promise<string> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    await requestJson(this.fetchFn, `${this.base}/storage/v1/object/${this.bucket}/${encoded}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.cfg.serviceRoleKey}`,
        apikey: this.cfg.serviceRoleKey,
        "Content-Type": mimeType,
        "x-upsert": "true",
      },
      body: bytes as BodyInit,
    });
    return `${this.base}/storage/v1/object/public/${this.bucket}/${encoded}`;
  }
}
