import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { supabaseSocialApi, toVariant } from "../src/api";

/** Chainable stand-in for the PostgREST query builder: records calls, resolves to `result`. */
function fakeClient(result: { data: unknown; error: { message: string } | null }) {
  const calls: Array<[string, unknown[]]> = [];
  const builder: any = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve(result);
        return (...args: unknown[]) => {
          calls.push([prop, args]);
          return builder;
        };
      },
    },
  );
  return { client: { from: (t: string) => (calls.push(["from", [t]]), builder) } as unknown as SupabaseClient, calls };
}

describe("supabaseSocialApi", () => {
  it("maps snake_case rows to PostVariant", () => {
    const v = toVariant({
      id: "1", brief_id: "b", channel: "x", body: "hej", asset_ids: ["a"], status: "draft", rationale: null,
      scheduled_at: null, attempts: 0, last_error: null, external_id: null, url: null, published_at: null,
      created_at: "2026-11-02T08:00:00+00:00",
    });
    expect(v).toMatchObject({ briefId: "b", text: "hej", assetIds: ["a"], rationale: undefined, scheduledAt: undefined });
    expect(v.createdAt).toBe("2026-11-02T08:00:00.000Z");
  });

  it("approve only touches rows that are still drafts and sends the reviewed values", async () => {
    const { client, calls } = fakeClient({ data: [{ id: "1" }], error: null });
    await supabaseSocialApi(client).approve("1", { text: "ny", scheduledAt: new Date("2026-11-03T09:00:00Z") });
    expect(calls).toContainEqual(["update", [{ body: "ny", scheduled_at: "2026-11-03T09:00:00.000Z", status: "scheduled" }]]);
    expect(calls).toContainEqual(["eq", ["id", "1"]]);
    expect(calls).toContainEqual(["eq", ["status", "draft"]]);
  });

  it("approve fails loudly when nothing was updated (stale draft or no access)", async () => {
    const { client } = fakeClient({ data: [], error: null });
    await expect(supabaseSocialApi(client).approve("1", { text: "x", scheduledAt: new Date() })).rejects.toThrow(/Ladda om/);
  });

  it("reject fails loudly when nothing was updated", async () => {
    const { client } = fakeClient({ data: [], error: null });
    await expect(supabaseSocialApi(client).reject("1")).rejects.toThrow(/Ladda om/);
  });

  it("surfaces database errors", async () => {
    const { client } = fakeClient({ data: null, error: { message: "boom" } });
    await expect(supabaseSocialApi(client).listVariants("draft")).rejects.toThrow("boom");
  });

  it("getAssets skips the query for no ids", async () => {
    const { client, calls } = fakeClient({ data: [], error: null });
    expect(await supabaseSocialApi(client).getAssets([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("retry calls the database function, and explains when the post is no longer failed", async () => {
    const calls: Array<[string, unknown]> = [];
    const client = (error: { code?: string; message: string } | null) =>
      ({ rpc: async (fn: string, args: unknown) => (calls.push([fn, args]), { data: null, error }) }) as unknown as SupabaseClient;
    await supabaseSocialApi(client(null)).retry("v1");
    expect(calls).toEqual([["social_retry_variant", { p_id: "v1" }]]);
    await expect(supabaseSocialApi(client({ code: "P0002", message: "variant v1 is not a failed variant" })).retry("v1")).rejects.toThrow(/Ladda om/);
    await expect(supabaseSocialApi(client({ code: "42501", message: "not allowed" })).retry("v1")).rejects.toThrow("not allowed");
  });
});
