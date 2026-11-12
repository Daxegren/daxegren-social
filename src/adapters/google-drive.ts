import { createSign } from "node:crypto";
import { AdapterError, type FetchLike } from "./types.js";

export interface DriveConfig {
  /** The service account key file's contents (JSON text). */
  serviceAccountJson: string;
  /** The Drive folder to read. It must be shared with the service account's e-mail address (Viewer is enough). */
  folderId: string;
  fetch?: FetchLike;
  now?: () => Date;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  /** Bytes, as text (the API returns it that way). */
  size?: string;
  modifiedTime: string;
}

const FOLDER = "application/vnd.google-apps.folder";
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
const ID = /^[A-Za-z0-9_-]+$/;
const MAX_DEPTH = 3;
const MAX_LISTED = 500;

const b64url = (input: string | Buffer) => Buffer.from(input).toString("base64url");

/**
 * Reads photos and videos from a Drive folder with a service account (no person has to be signed in, which is what a
 * scheduled run needs). Checked against Google's documentation 2026-11-06: JWT bearer grant, files.list, alt=media.
 * Not yet run against a live account.
 */
export class GoogleDriveSource {
  readonly clientEmail: string;
  private readonly key: string;
  private readonly tokenUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly now: () => Date;
  private token?: { value: string; expiresAt: number };

  constructor(private readonly cfg: DriveConfig) {
    let parsed: { client_email?: string; private_key?: string; token_uri?: string };
    try {
      parsed = JSON.parse(cfg.serviceAccountJson);
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: paste the whole key file");
    }
    if (!parsed.client_email || !parsed.private_key) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON must contain client_email and private_key");
    if (!ID.test(cfg.folderId)) throw new Error("DRIVE_FOLDER_ID looks wrong: it is the last part of the folder's address");
    this.clientEmail = parsed.client_email;
    this.key = parsed.private_key;
    this.tokenUrl = parsed.token_uri ?? DEFAULT_TOKEN_URL;
    this.fetchFn = cfg.fetch ?? fetch;
    this.now = cfg.now ?? (() => new Date());
  }

  /** Photos and videos in the folder and its subfolders (three levels deep), newest first. */
  async listMedia(): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    const queue = [{ id: this.cfg.folderId, depth: 0 }];
    while (queue.length && files.length < MAX_LISTED) {
      const folder = queue.shift()!;
      let pageToken: string | undefined;
      do {
        const qs = new URLSearchParams({
          q: `'${folder.id}' in parents and trashed = false`,
          fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime)",
          pageSize: "100",
          orderBy: "modifiedTime desc",
          supportsAllDrives: "true",
          includeItemsFromAllDrives: "true",
        });
        if (pageToken) qs.set("pageToken", pageToken);
        const page = await this.api<{ files?: DriveFile[]; nextPageToken?: string }>(`https://www.googleapis.com/drive/v3/files?${qs}`);
        for (const f of page.files ?? []) {
          if (f.mimeType === FOLDER) {
            if (folder.depth < MAX_DEPTH && ID.test(f.id)) queue.push({ id: f.id, depth: folder.depth + 1 });
          } else if (f.mimeType.startsWith("image/") || f.mimeType.startsWith("video/")) {
            files.push(f);
          }
        }
        pageToken = page.nextPageToken;
      } while (pageToken && files.length < MAX_LISTED);
    }
    return files.slice(0, MAX_LISTED);
  }

  async download(file: Pick<DriveFile, "id">): Promise<Uint8Array> {
    if (!ID.test(file.id)) throw new AdapterError("invalid Drive file id", true);
    const res = await this.authorised(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`);
    return new Uint8Array(await res.arrayBuffer());
  }

  // ── plumbing ──────────────────────────────────────────────────────────

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now().getTime() + 60_000) return this.token.value;

    const iat = Math.floor(this.now().getTime() / 1000);
    const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
      JSON.stringify({ iss: this.clientEmail, scope: SCOPE, aud: this.tokenUrl, iat, exp: iat + 3600 }),
    )}`;
    let assertion: string;
    try {
      assertion = `${unsigned}.${b64url(createSign("RSA-SHA256").update(unsigned).sign(this.key))}`;
    } catch {
      throw new AdapterError("the service account's private_key could not be used to sign (is the key file complete?)", true);
    }

    let res: Response;
    try {
      res = await this.fetchFn(this.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      });
    } catch (err) {
      throw new AdapterError(`network error: ${(err as Error).message}`, false);
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) {
      throw new AdapterError(`Google sign-in failed: ${body.error_description ?? body.error ?? `HTTP ${res.status}`}`, res.status < 500 && res.status !== 429, res.status);
    }
    this.token = { value: body.access_token, expiresAt: this.now().getTime() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  private async authorised(url: string): Promise<Response> {
    const token = await this.accessToken();
    let res: Response;
    try {
      res = await this.fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      throw new AdapterError(`network error: ${(err as Error).message}`, false);
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    const transient = res.status === 429 || res.status >= 500;
    const hint =
      res.status === 404 ? ` (is the folder shared with ${this.clientEmail}?)` : res.status === 403 ? " (is the Drive API enabled for the service account's project, and the folder shared with it?)" : "";
    throw new AdapterError(`Drive HTTP ${res.status}${hint}: ${text.slice(0, 200)}`, !transient, res.status);
  }

  private async api<T>(url: string): Promise<T> {
    return (await (await this.authorised(url)).json()) as T;
  }
}
