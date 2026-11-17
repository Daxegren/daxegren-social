import type { DriveFile, GoogleDriveSource } from "./adapters/google-drive.js";
import { AdapterError } from "./adapters/types.js";
import type { ContentEngine } from "./engine.js";
import type { Store } from "./store.js";
import { audioMime, MAX_AUDIO_BYTES } from "./transcribe.js";

export interface MemoSyncResult {
  /** Recordings turned into transcripts this run. */
  transcribed: string[];
  /** Recordings already handled in an earlier run. */
  known: number;
  /** Left for the next run because the per-run limit was reached. */
  remaining: number;
  skipped: Array<{ name: string; reason: string }>;
  failed: Array<{ name: string; reason: string }>;
  /** Drafts made from memos (this run's and any that were waiting). */
  drafts: number;
  planned: number;
}

/**
 * Picks up new recordings from the Drive folder, transcribes them and drafts ideas from the transcripts. Works on
 * transcripts, so a recording is paid for once however often drafting is retried.
 */
export async function syncMemos(opts: {
  drive: Pick<GoogleDriveSource, "listAudio" | "download">;
  store: Store;
  engine: ContentEngine;
  /** Recordings transcribed per run. Default 5. */
  maxNew?: number;
}): Promise<MemoSyncResult> {
  const maxNew = opts.maxNew ?? 5;
  const result: MemoSyncResult = { transcribed: [], known: 0, remaining: 0, skipped: [], failed: [], drafts: 0, planned: 0 };

  const files: DriveFile[] = await opts.drive.listAudio();
  for (const file of files) {
    if (await opts.store.getMemoByDriveFile(file.id)) {
      result.known++;
      continue;
    }
    if (!audioMime(file.mimeType, file.name)) {
      result.skipped.push({ name: file.name, reason: `${file.mimeType} is not supported; share the memo as m4a or mp3` });
      continue;
    }
    if (file.size && Number(file.size) > MAX_AUDIO_BYTES) {
      result.skipped.push({ name: file.name, reason: `larger than ${MAX_AUDIO_BYTES / 1024 / 1024} MB (about 25 minutes); split it` });
      continue;
    }
    if (result.transcribed.length >= maxNew) {
      result.remaining++;
      continue;
    }
    try {
      const bytes = await opts.drive.download(file);
      const memo = await opts.engine.addMemoFromAudio({ name: file.name, bytes, mimeType: file.mimeType, driveFileId: file.id });
      if (memo.status === "failed") result.failed.push({ name: file.name, reason: memo.error ?? "unknown error" });
      else result.transcribed.push(file.name);
    } catch (err) {
      result.failed.push({ name: file.name, reason: err instanceof AdapterError || err instanceof Error ? err.message : String(err) });
    }
  }

  const processed = await opts.engine.processMemos();
  result.drafts = processed.drafts;
  result.planned = processed.planned.length;
  result.failed.push(...processed.failed.map((id) => ({ name: id, reason: "could not be drafted after three tries; see the memo's error in the database" })));
  return result;
}

export function describeMemoSync(r: MemoSyncResult): string {
  const parts = [`${r.transcribed.length} new recording(s) transcribed`, `${r.known} already handled`];
  if (r.remaining) parts.push(`${r.remaining} left for the next run`);
  const lines = [`Memo sync: ${parts.join(", ")}; ${r.planned} memo(s) drafted into ${r.drafts} draft(s)`];
  for (const s of r.skipped) lines.push(`  skipped ${s.name}: ${s.reason}`);
  for (const f of r.failed) lines.push(`  failed ${f.name}: ${f.reason}`);
  return lines.join("\n");
}
