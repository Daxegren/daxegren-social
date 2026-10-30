import { describe, expect, it } from "vitest";
import { validateVariant } from "../src/channels.js";
import { ClaudeContentGenerator, parseVariants } from "../src/generate.js";
import type { Asset, ContentBrief } from "../src/domain.js";
import { json, mockFetch } from "./helpers.js";

const brief: ContentBrief = { id: "b", idea: "i", sourcePostIds: [], assetIds: [], createdAt: "2026-11-02T00:00:00Z" };
const img: Asset = { id: "a1", kind: "image", origin: "captured", uri: "https://cdn.test/a.jpg", createdAt: "" };
const input = { brief, channels: ["linkedin" as const, "x" as const], insights: {}, examples: [], assets: [img] };

describe("parseVariants", () => {
  it("extracts JSON surrounded by prose or code fences", () => {
    const raw = 'Here you go:\n```json\n{"variants":[{"channel":"linkedin","text":"hi","assetIds":["a1"],"rationale":"r"}]}\n```';
    expect(parseVariants(raw, input)).toEqual([{ channel: "linkedin", text: "hi", assetIds: ["a1"], rationale: "r" }]);
  });

  it("drops unknown channels and hallucinated asset ids", () => {
    const raw = JSON.stringify({
      variants: [
        { channel: "linkedin", text: "ok", assetIds: ["a1", "ghost"] },
        { channel: "tiktok", text: "not requested", assetIds: [] },
      ],
    });
    const out = parseVariants(raw, input);
    expect(out).toHaveLength(1);
    expect(out[0]!.assetIds).toEqual(["a1"]);
  });

  it("throws when there is no JSON", () => {
    expect(() => parseVariants("sorry", input)).toThrow(/no JSON/);
  });
});

describe("ClaudeContentGenerator", () => {
  it("calls the Messages API and returns parsed variants", async () => {
    const { fn, calls } = mockFetch([
      {
        match: (u) => u === "https://api.anthropic.com/v1/messages",
        reply: () => json({ content: [{ type: "text", text: '{"variants":[{"channel":"x","text":"short"}]}' }] }),
      },
    ]);
    const gen = new ClaudeContentGenerator({ apiKey: "k", fetch: fn });

    const out = await gen.generate(input);

    expect(out).toEqual([{ channel: "x", text: "short", assetIds: [], rationale: undefined }]);
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("k");
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.messages[0].content).toContain("Channels and hard limits");
  });

  it("surfaces API errors", async () => {
    const { fn } = mockFetch([{ match: () => true, reply: () => new Response("overloaded", { status: 529 }) }]);
    await expect(new ClaudeContentGenerator({ apiKey: "k", fetch: fn }).generate(input)).rejects.toThrow(/529/);
  });
});

describe("validateVariant", () => {
  it("flags over-long text, missing media, wrong media kind and non-https uris", () => {
    expect(validateVariant({ channel: "x", text: "a".repeat(281), assetIds: [] }, [])[0]).toMatch(/280/);
    expect(validateVariant({ channel: "tiktok", text: "t", assetIds: [] }, [])).toContain("tiktok requires media");
    expect(validateVariant({ channel: "tiktok", text: "t", assetIds: ["a1"] }, [img])).toContain("tiktok does not accept image");
    const http = { ...img, uri: "http://insecure.test/a.jpg" };
    expect(validateVariant({ channel: "linkedin", text: "t", assetIds: ["a1"] }, [http]).join()).toMatch(/https/);
  });

  it("accepts a valid variant", () => {
    expect(validateVariant({ channel: "linkedin", text: "fine", assetIds: [] }, [])).toEqual([]);
  });
});
