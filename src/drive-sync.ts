import { createHash } from "node:crypto";
import type { DriveFile, GoogleDriveSource } from "./adapters/google-drive.js";
import type { Asset } from "./domain.js";
import type { MediaStorage } from "./media.js";
import type { Store } from "./store.js";

/** Formats the platforms accept (see CHANNEL_SPECS): JPEG, PNG, WebP, GIF images and MP4/MOV video. */
const FORMATS: Record<string, { kind: Asset["kind"]; ext: string }> = {
  "image/jpeg": { kind: "image", ext: "jpg" },
  "image/png": { kind: "image", ext: "png" },
  "image/webp": { kind: "image", ext: "webp" },
  "image/gif": { kind: "image", ext: "gif" },
  "video/mp4": { kind: "video", ext: "mp4" },
  "video/quicktime": { kind: "video", ext: "mov" },
};
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** The same Drive file always maps to the same asset id, so a second sync cannot create duplicates. */
export function assetIdForDriveFile(driveFileId: string): string {
  const h = createHash("sha256").update(`drive:${driveFileId}`).digest("hex");
  // Shaped like a version-5 UUID so it fits the uuid columns.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

export interface DriveSyncResult {
  added: string[];
  updated: string[];
  unchanged: number;
  /** Files left for the next run because the per-run limit was reached. */
  remaining: number;
  skipped: Array<{ name: string; reason: string }>;
  failed: Array<{ name: string; reason: string }>;
}

/**
 * Copies new and changed photos/videos from Drive into our own storage and registers them as the creator's own assets.
 * Drive links cannot be used directly: LinkedIn/Buffer/Instagram need a public, stable address.
 */
export async function syncDrive(opts: {
  drive: Pick<GoogleDriveSource, "listMedia" | "download">;
  store: Store;
  storage: MediaStorage;
  now?: () => Date;
  /** Files copied per run (keeps a run short). Default 20. */
  maxNew?: number;
}): Promise<DriveSyncResult> {
  const now = opts.now ?? (() => new Date());
  const maxNew = opts.maxNew ?? 20;
  const result: DriveSyncResult = { added: [], updated: [], unchanged: 0, remaining: 0, skipped: [], failed: [] };

  const files = await opts.drive.listMedia();
  for (const file of files) {
    const id = assetIdForDriveFile(file.id);
    const existing = (await opts.store.getAssets([id]))[0];
    if (existing && existing.meta?.driveModifiedTime === file.modifiedTime) {
      result.unchanged++;
      continue;
    }

    const format = FORMATS[file.mimeType];
    if (!format) {
      result.skipped.push({ name: file.name, reason: `${file.mimeType} is not accepted by the platforms${file.mimeType.includes("heic") ? " (export as JPEG)" : ""}` });
      continue;
    }
    if (file.size && Number(file.size) > MAX_FILE_BYTES) {
      result.skipped.push({ name: file.name, reason: `larger than ${MAX_FILE_BYTES / 1024 / 1024} MB` });
      continue;
    }
    if (result.added.length + result.updated.length >= maxNew) {
      result.remaining++;
      continue;
    }

    try {
      const bytes = await opts.drive.download(file);
      const uri = await opts.storage.put(`drive/${id}.${format.ext}`, bytes, file.mimeType);
      await opts.store.putAsset({
        id,
        kind: format.kind,
        origin: "captured",
        uri,
        createdAt: existing?.createdAt ?? now().toISOString(),
        meta: { source: "drive", driveFileId: file.id, name: file.name, driveModifiedTime: file.modifiedTime, mimeType: file.mimeType },
      });
      (existing ? result.updated : result.added).push(id);
    } catch (err) {
      result.failed.push({ name: file.name, reason: (err as Error).message });
    }
  }
  return result;
}

export function describeDriveSync(r: DriveSyncResult): string {
  const parts = [`${r.added.length} new`, `${r.updated.length} updated`, `${r.unchanged} unchanged`];
  if (r.remaining) parts.push(`${r.remaining} left for the next run`);
  const lines = [`Drive sync: ${parts.join(", ")}`];
  for (const s of r.skipped) lines.push(`  skipped ${s.name}: ${s.reason}`);
  for (const f of r.failed) lines.push(`  failed ${f.name}: ${f.reason}`);
  return lines.join("\n");
}

export type { DriveFile };
