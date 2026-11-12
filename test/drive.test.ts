import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GoogleDriveSource } from "../src/adapters/google-drive.js";
import { assetIdForDriveFile, describeDriveSync, syncDrive } from "../src/drive-sync.js";
import { MemoryStore } from "../src/store.js";
import { scrubSecrets } from "../src/worker/doctor.js";
import { json, MemoryStorage, mockFetch } from "./helpers.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const KEY_JSON = JSON.stringify({ client_email: "bot@proj.iam.gserviceaccount.com", private_key: privateKey });
const NOW = new Date("2026-11-12T10:00:00Z");

const TOKEN = { match: (u: string) => u === "https://oauth2.googleapis.com/token", reply: () => json({ access_token: "ya29.tok", expires_in: 3600 }) };
const file = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `${id}.jpg`, mimeType: "image/jpeg", size: "1000", modifiedTime: "2026-11-10T00:00:00Z", ...over });
const listing = (folder: string, files: unknown[], next?: string) => ({
  match: (u: string) => u.startsWith("https://www.googleapis.com/drive/v3/files?") && decodeURIComponent(u.replace(/\+/g, " ")).includes(`'${folder}' in parents`) && (next ? true : !u.includes("pageToken")),
  reply: () => json({ files, nextPageToken: next }),
});
const make = (routes: Parameters<typeof mockFetch>[0]) => {
  const m = mockFetch([TOKEN, ...routes]);
  return { drive: new GoogleDriveSource({ serviceAccountJson: KEY_JSON, folderId: "root1", fetch: m.fn, now: () => NOW }), calls: m.calls };
};

describe("GoogleDriveSource", () => {
  it("signs a valid RS256 JWT for the right scope and audience, and reuses the token", async () => {
    const { drive, calls } = make([listing("root1", [file("f1")])]);
    await drive.listMedia();
    await drive.listMedia();
    const tokenCalls = calls.filter((c) => c.url.includes("oauth2"));
    expect(tokenCalls).toHaveLength(1);
    const body = new URLSearchParams(String(tokenCalls[0]!.init!.body));
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h, p, sig] = body.get("assertion")!.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toEqual({
      iss: "bot@proj.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/drive.readonly", aud: "https://oauth2.googleapis.com/token", iat: NOW.getTime() / 1000, exp: NOW.getTime() / 1000 + 3600,
    });
    expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
  });

  it("lists photos and videos, follows pages and subfolders, ignores other files", async () => {
    const { drive } = make([
      { match: (u) => u.includes("pageToken=p2"), reply: () => json({ files: [file("b", { mimeType: "video/mp4" })] }) },
      listing("root1", [file("a"), { ...file("doc"), mimeType: "application/pdf" }, { ...file("sub1"), mimeType: "application/vnd.google-apps.folder" }], "p2"),
      listing("sub1", [file("c")]),
    ]);
    expect((await drive.listMedia()).map((f) => f.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("explains a 404 by naming the account the folder must be shared with", async () => {
    const { drive } = make([{ match: (u) => u.includes("/drive/v3/files"), reply: () => new Response("{}", { status: 404 }) }]);
    await expect(drive.listMedia()).rejects.toThrow(/shared with bot@proj\.iam\.gserviceaccount\.com/);
  });

  it("reports a rejected sign-in clearly", async () => {
    const m = mockFetch([{ match: (u) => u.includes("oauth2"), reply: () => json({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, { status: 400 }) }]);
    const drive = new GoogleDriveSource({ serviceAccountJson: KEY_JSON, folderId: "root1", fetch: m.fn });
    await expect(drive.listMedia()).rejects.toThrow(/Invalid JWT Signature/);
  });

  it("rejects a bad key file or folder id up front", () => {
    expect(() => new GoogleDriveSource({ serviceAccountJson: "nope", folderId: "x" })).toThrow(/not valid JSON/);
    expect(() => new GoogleDriveSource({ serviceAccountJson: "{}", folderId: "x" })).toThrow(/client_email/);
    expect(() => new GoogleDriveSource({ serviceAccountJson: KEY_JSON, folderId: "a' or '1'='1" })).toThrow(/DRIVE_FOLDER_ID/);
  });
});

describe("syncDrive", () => {
  const setup = (files: unknown[]) => {
    const downloads: string[] = [];
    const drive = {
      listMedia: async () => files as any[],
      download: async (f: { id: string }) => {
        downloads.push(f.id);
        return new Uint8Array([1, 2, 3]);
      },
    };
    return { drive, downloads, store: new MemoryStore(), storage: new MemoryStorage() };
  };

  it("copies files into storage and registers them as the creator's own assets, once", async () => {
    const s = setup([file("f1"), file("v1", { mimeType: "video/quicktime", name: "clip.mov" })]);
    const first = await syncDrive({ ...s, now: () => NOW });
    expect(first.added).toHaveLength(2);
    const [photo] = await s.store.getAssets([assetIdForDriveFile("f1")]);
    expect(photo).toMatchObject({ kind: "image", origin: "captured", uri: `https://storage.test/public/drive/${assetIdForDriveFile("f1")}.jpg`, meta: { source: "drive", driveFileId: "f1" } });
    expect(s.storage.files.has(`drive/${assetIdForDriveFile("v1")}.mov`)).toBe(true);

    const second = await syncDrive({ ...s, now: () => NOW });
    expect(second).toMatchObject({ added: [], unchanged: 2 });
    expect(s.downloads).toHaveLength(2);
  });

  it("re-copies a file edited in Drive, keeping its id", async () => {
    const s = setup([file("f1")]);
    await syncDrive(s);
    const edited = setup([file("f1", { modifiedTime: "2026-11-11T00:00:00Z" })]);
    const res = await syncDrive({ ...edited, store: s.store, storage: s.storage });
    expect(res.updated).toEqual([assetIdForDriveFile("f1")]);
  });

  it("skips what the platforms cannot use or what is too big, and says why", async () => {
    const s = setup([file("h", { mimeType: "image/heic", name: "IMG.heic" }), file("big", { size: String(60 * 1024 * 1024) }), file("ok")]);
    const res = await syncDrive(s);
    expect(res.added).toHaveLength(1);
    expect(res.skipped.map((x) => x.reason).join("|")).toMatch(/export as JPEG.*\|.*50 MB/);
    expect(s.downloads).toEqual(["ok"]);
  });

  it("copies at most maxNew files per run and reports the rest; one failure does not stop the others", async () => {
    const s = setup([file("a"), file("b"), file("c")]);
    const limited = await syncDrive({ ...s, maxNew: 2 });
    expect(limited).toMatchObject({ remaining: 1 });
    expect(describeDriveSync(limited)).toContain("1 left for the next run");

    const failing = setup([file("x"), file("y")]);
    failing.drive.download = async (f) => {
      if (f.id === "x") throw new Error("boom");
      return new Uint8Array([1]);
    };
    const res = await syncDrive(failing);
    expect(res.failed).toEqual([{ name: "x.jpg", reason: "boom" }]);
    expect(res.added).toHaveLength(1);
  });

  it("the same Drive file always gets the same uuid-shaped id", () => {
    expect(assetIdForDriveFile("abc")).toBe(assetIdForDriveFile("abc"));
    expect(assetIdForDriveFile("abc")).not.toBe(assetIdForDriveFile("abd"));
    expect(assetIdForDriveFile("abc")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("secrets", () => {
  it("scrubs the service account key, even inside JSON-escaped output", () => {
    const out = scrubSecrets(`failed with ${privateKey} and ${KEY_JSON}`, { GOOGLE_SERVICE_ACCOUNT_JSON: KEY_JSON });
    expect(out).not.toContain("BEGIN PRIVATE KEY");
    expect(out).not.toContain(privateKey.slice(40, 80));
  });
});
