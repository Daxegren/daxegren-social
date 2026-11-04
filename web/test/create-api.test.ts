import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { MAX_UPLOAD_BYTES, supabaseCreateApi, validateUpload } from "../src/api";

type Result = { data: unknown; error: { message: string } | null };

/** Records every call; each table operation resolves to the next queued result. */
function fakeClient(opts: { results?: Result[]; user?: { id: string } | null; uploadError?: string } = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const results = [...(opts.results ?? [])];
  const builder: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(results.shift() ?? { data: [], error: null });
      return (...args: unknown[]) => (calls.push([prop, ...args]), builder);
    },
  });
  const bucket = {
    upload: vi.fn(async (...a: unknown[]) => (calls.push(["upload", ...a]), { data: {}, error: opts.uploadError ? { message: opts.uploadError } : null })),
    getPublicUrl: vi.fn((path: string) => ({ data: { publicUrl: `https://abc.supabase.co/storage/v1/object/public/social-media/${path}` } })),
    remove: vi.fn(async (...a: unknown[]) => (calls.push(["remove", ...a]), { data: [], error: null })),
  };
  const client = {
    from: (t: string) => (calls.push(["from", t]), builder),
    auth: { getUser: async () => ({ data: { user: opts.user === undefined ? { id: "user-1" } : opts.user }, error: null }) },
    storage: { from: (b: string) => (calls.push(["bucket", b]), bucket) },
  } as unknown as SupabaseClient;
  return { client, calls, bucket };
}

const jpeg = (name = "me.jpg") => Object.assign(new File(["x"], name, { type: "image/jpeg" }), {});
const row = { id: "a1", kind: "image", origin: "captured", uri: "https://x", created_at: "2026-11-02T08:00:00Z", meta: null };

describe("validateUpload", () => {
  it("accepts the formats the platforms take, and explains the rest", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime"]) expect(validateUpload({ name: "f", type, size: 1 })).toBeUndefined();
    expect(validateUpload({ name: "a.HEIC", type: "", size: 1 })).toMatch(/HEIC/);
    expect(validateUpload({ name: "a.jpg", type: "image/heif", size: 1 })).toMatch(/HEIC/);
    expect(validateUpload({ name: "a.gif", type: "image/gif", size: 1 })).toMatch(/filtypen/);
    expect(validateUpload({ name: "a.mp4", type: "video/mp4", size: MAX_UPLOAD_BYTES })).toBeUndefined();
    expect(validateUpload({ name: "a.mp4", type: "video/mp4", size: MAX_UPLOAD_BYTES + 1 })).toMatch(/50 MB/);
  });
});

describe("supabaseCreateApi.uploadAsset", () => {
  it("uploads into uploads/<user id>/, then registers it as a captured asset with the public URL", async () => {
    const { client, calls, bucket } = fakeClient({ results: [{ data: row, error: null }] });
    const asset = await supabaseCreateApi(client).uploadAsset(jpeg());

    const path = vi.mocked(bucket.upload).mock.calls[0]![0] as string;
    expect(path).toMatch(/^uploads\/user-1\/[0-9a-f-]{36}\.jpg$/);
    expect(vi.mocked(bucket.upload).mock.calls[0]![2]).toEqual({ contentType: "image/jpeg", upsert: false });
    const insert = calls.find((c) => c[0] === "insert")![1] as Record<string, unknown>;
    expect(insert).toMatchObject({ kind: "image", origin: "captured", uri: `https://abc.supabase.co/storage/v1/object/public/social-media/${path}` });
    expect(asset.id).toBe("a1");
  });

  it("removes the stored file when registering it fails, so nothing is orphaned", async () => {
    const { client, bucket } = fakeClient({ results: [{ data: null, error: { message: "row-level security" } }] });
    await expect(supabaseCreateApi(client).uploadAsset(jpeg())).rejects.toThrow("row-level security");
    expect(bucket.remove).toHaveBeenCalledTimes(1);
  });

  it("does not touch the network for an invalid file, or when logged out, and surfaces storage errors", async () => {
    const a = fakeClient();
    await expect(supabaseCreateApi(a.client).uploadAsset(new File(["x"], "x.gif", { type: "image/gif" }))).rejects.toThrow(/filtypen/);
    expect(a.bucket.upload).not.toHaveBeenCalled();
    await expect(supabaseCreateApi(fakeClient({ user: null }).client).uploadAsset(jpeg())).rejects.toThrow(/inte inloggad/);
    // a response without a usable id must not produce an "uploads/undefined/…" path
    await expect(supabaseCreateApi(fakeClient({ user: {} as { id: string } }).client).uploadAsset(jpeg())).rejects.toThrow(/inte inloggad/);
    await expect(supabaseCreateApi(fakeClient({ uploadError: "Bucket not found" }).client).uploadAsset(jpeg())).rejects.toThrow("Bucket not found");
  });

  it("uses a safe extension even for odd file names", async () => {
    const { client, bucket } = fakeClient({ results: [{ data: row, error: null }] });
    await supabaseCreateApi(client).uploadAsset(new File(["x"], "weird name.JPG?x=1", { type: "image/jpeg" }));
    expect(vi.mocked(bucket.upload).mock.calls[0]![0]).toMatch(/\.jpgx1$/);
  });
});

describe("supabaseCreateApi: requests", () => {
  it("requestDrafts inserts a 'requested' brief with the chosen channels and assets", async () => {
    const { client, calls } = fakeClient();
    await supabaseCreateApi(client).requestDrafts({ idea: "idé", channels: ["linkedin"], assetIds: ["a1"], goal: "" });
    expect(calls).toContainEqual(["from", "social_briefs"]);
    expect(calls).toContainEqual(["insert", { idea: "idé", angle: null, goal: null, channels: ["linkedin"], asset_ids: ["a1"], status: "requested" }]);
  });

  it("requestDrafts and listRequests surface database errors", async () => {
    await expect(supabaseCreateApi(fakeClient({ results: [{ data: null, error: { message: "denied" } }] }).client).requestDrafts({ idea: "x", channels: ["x"], assetIds: [] })).rejects.toThrow("denied");
    await expect(supabaseCreateApi(fakeClient({ results: [{ data: null, error: { message: "boom" } }] }).client).listRequests()).rejects.toThrow("boom");
  });

  it("listRequests maps rows and only returns briefs that came from the app (have channels)", async () => {
    const { client, calls } = fakeClient({ results: [{ data: [{ id: "b1", idea: "i", channels: ["x"], status: "failed", error: "e", asset_ids: null, created_at: "2026-11-02T08:00:00Z" }], error: null }] });
    const [b] = await supabaseCreateApi(client).listRequests();
    expect(b).toMatchObject({ id: "b1", status: "failed", error: "e", assetIds: [], channels: ["x"] });
    expect(calls).toContainEqual(["not", "channels", "is", null]);
  });
});
