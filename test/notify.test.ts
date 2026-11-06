import { describe, expect, it } from "vitest";
import { ContentEngine } from "../src/engine.js";
import { WebhookNotifier, detectFormat, excerpt, type Notifier, type NotifyEvent } from "../src/notify.js";
import { MemoryStore } from "../src/store.js";
import { runCli } from "../src/worker/cli.js";
import { runDoctor, scrubSecrets } from "../src/worker/doctor.js";
import { FakeAdapter, FakeGenerator, FakeImageGenerator, FakeVideoGenerator, MemoryStorage, json, mockFetch, permanent, transient } from "./helpers.js";
import { freshDb } from "./pg.js";

const T0 = new Date("2026-11-04T08:00:00Z");
const NTFY = "https://ntfy.sh/david-secret-topic-9x";

describe("WebhookNotifier", () => {
  const send = async (url: string, format?: "ntfy" | "slack" | "discord" | "json", event: Partial<NotifyEvent> = {}) => {
    const { fn, calls } = mockFetch([{ match: () => true, reply: () => new Response("ok") }]);
    await new WebhookNotifier({ url, format, fetch: fn }).notify({ kind: "published", title: "Rubrik", message: "Brödtext åäö", ...event });
    return calls[0]!;
  };

  it("ntfy: publishes JSON to the server root with the topic, so Swedish characters survive", async () => {
    const call = await send(NTFY, undefined, { url: "https://app.example/" });
    expect(call.url).toBe("https://ntfy.sh/");
    expect(JSON.parse(String(call.init!.body))).toEqual({ topic: "david-secret-topic-9x", title: "Rubrik", message: "Brödtext åäö", click: "https://app.example/" });
  });

  it("slack, discord and generic json bodies", async () => {
    expect(JSON.parse(String((await send("https://hooks.slack.com/services/T/B/x", undefined, { url: "https://a.example" })).init!.body)).text).toBe("*Rubrik*\nBrödtext åäö\n<https://a.example|Öppna>");
    expect(JSON.parse(String((await send("https://discord.com/api/webhooks/1/abc")).init!.body)).content).toBe("**Rubrik**\nBrödtext åäö");
    expect(JSON.parse(String((await send("https://hooks.example.com/in")).init!.body))).toEqual({ kind: "published", title: "Rubrik", message: "Brödtext åäö" });
  });

  it("detects the format from the address, and lets you override it", () => {
    expect(detectFormat("https://ntfy.sh/x")).toBe("ntfy");
    expect(detectFormat("https://ntfy.example.org/x")).toBe("ntfy");
    expect(detectFormat("https://hooks.slack.com/services/x")).toBe("slack");
    expect(detectFormat("https://discord.com/api/webhooks/x")).toBe("discord");
    expect(detectFormat("https://anything.example/x")).toBe("json");
    expect(new WebhookNotifier({ url: "https://anything.example/x", format: "ntfy" }).format).toBe("ntfy");
  });

  it("refuses plain http and an ntfy address without a topic", async () => {
    expect(() => new WebhookNotifier({ url: "http://ntfy.sh/x" })).toThrow(/https/);
    await expect(send("https://ntfy.sh/")).rejects.toThrow(/topic/);
  });

  it("truncates long text", async () => {
    const call = await send("https://hooks.example.com/in", undefined, { title: "t".repeat(300), message: "m".repeat(5000) });
    const body = JSON.parse(String(call.init!.body));
    expect(body.title).toHaveLength(100);
    expect(body.message).toHaveLength(1000);
    expect(excerpt("  a \n\n b   c  ")).toBe("a b c");
  });

  it("errors never contain the address or the topic", async () => {
    const down = (async () => { throw new Error(`connect ECONNREFUSED ${NTFY} david-secret-topic-9x`); }) as typeof fetch;
    const err1 = await new WebhookNotifier({ url: NTFY, fetch: down }).notify({ kind: "test", title: "t", message: "m" }).catch((e: Error) => e);
    const { fn } = mockFetch([{ match: () => true, reply: () => new Response("no", { status: 403 }) }]);
    const err2 = await new WebhookNotifier({ url: NTFY, fetch: fn }).notify({ kind: "test", title: "t", message: "m" }).catch((e: Error) => e);
    for (const e of [err1, err2]) {
      expect((e as Error).message).not.toContain("david-secret-topic-9x");
    }
    expect((err2 as Error).message).toContain("HTTP 403");
  });
});

class Recorder implements Notifier {
  events: NotifyEvent[] = [];
  fail = false;
  async notify(e: NotifyEvent) {
    if (this.fail) throw new Error("webhook down");
    this.events.push(e);
  }
}

function setup(over: { cap?: number; appUrl?: string; notifier?: Notifier | null } = {}) {
  const store = new MemoryStore();
  const linkedin = new FakeAdapter("linkedin");
  const instagram = new FakeAdapter("instagram");
  const rec = new Recorder();
  const video = new FakeVideoGenerator();
  const engine = new ContentEngine({
    store, adapters: { linkedin, instagram }, generator: new FakeGenerator(), now: () => T0,
    notifier: over.notifier === null ? undefined : (over.notifier ?? rec), appUrl: over.appUrl,
    videoGenerator: video, imageGenerator: new FakeImageGenerator(), mediaStorage: new MemoryStorage(), mediaMonthlyCapUsd: over.cap,
    fetch: mockFetch([{ match: () => true, reply: () => new Response(new Uint8Array([1])) }]).fn,
    scheduler: { maxAttempts: 3, backoffMs: () => 60_000 },
  });
  return { store, engine, linkedin, instagram, rec, video };
}

async function approved(engine: ContentEngine, channels: Array<"linkedin" | "instagram"> = ["linkedin"]) {
  const brief = await engine.createBrief({ idea: "x" });
  const drafts = await engine.proposeVariants(brief.id, channels);
  for (const d of drafts) await engine.approve(d.id);
  return drafts;
}

describe("engine notifications", () => {
  it("one published post: titled with the channel, carrying its link", async () => {
    const { engine, rec } = setup({ appUrl: "https://app.example/" });
    await approved(engine);
    await engine.tick();
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ kind: "published", title: "Publicerat på LinkedIn", url: "https://example.test/linkedin/1" });
    expect(rec.events[0]!.message).toContain("post for linkedin");
  });

  it("several posts in one run are one notification", async () => {
    const { engine, rec } = setup({ appUrl: "https://app.example/" });
    await approved(engine);
    await approved(engine);
    await engine.tick();
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({ title: "2 inlägg publicerade", url: "https://app.example/" });
  });

  it("a permanent failure is announced with its error; a retryable one is silent", async () => {
    const { engine, linkedin, rec } = setup();
    await approved(engine);
    linkedin.failures = [transient()];
    await engine.tick();
    expect(rec.events).toEqual([]);

    const s2 = setup();
    await approved(s2.engine);
    s2.linkedin.failures = [permanent()];
    await s2.engine.tick();
    expect(s2.rec.events).toHaveLength(1);
    expect(s2.rec.events[0]).toMatchObject({ kind: "failed", title: "Misslyckades på LinkedIn" });
    expect(s2.rec.events[0]!.message).toContain("rejected");
  });

  it("requests: drafts ready counts the drafts, a failed request says why", async () => {
    const { store, engine, rec } = setup();
    await store.putBrief({ id: crypto.randomUUID(), idea: "Tre lärdomar", sourcePostIds: [], assetIds: [], channels: ["linkedin"], status: "requested", createdAt: T0.toISOString() });
    await engine.tick();
    expect(rec.events).toEqual([expect.objectContaining({ kind: "drafts_ready", title: "1 nytt utkast väntar", message: "Idé: Tre lärdomar" })]);

    const failing = new ContentEngine({ store: new MemoryStore(), adapters: {}, now: () => T0, notifier: rec, generator: { generate: async () => { throw new Error("Claude is down"); } } });
    rec.events = [];
    await failing["store"].putBrief({ id: crypto.randomUUID(), idea: "Trasig", sourcePostIds: [], assetIds: [], channels: ["linkedin"], status: "requested", createdAt: T0.toISOString() });
    await failing.tick();
    expect(rec.events).toEqual([expect.objectContaining({ kind: "request_failed", title: "Beställningen misslyckades" })]);
    expect(rec.events[0]!.message).toContain("Claude is down");
  });

  it("finished media is announced once", async () => {
    const { engine, rec } = setup();
    await engine.startVideo({ prompt: "x", sourceImageUri: "https://cdn.test/p.jpg" });
    await engine.tick();
    expect(rec.events).toEqual([expect.objectContaining({ kind: "media", title: "Media klar" })]);
    await engine.tick();
    expect(rec.events).toHaveLength(1);
  });

  it("warns once when media spending crosses 80 % of the cap, and not again", async () => {
    const { engine, rec } = setup({ cap: 1 }); // an image is estimated at 0.04 USD
    for (let i = 0; i < 19; i++) await engine.generateImage({ prompt: `p${i}` }); // 0.76 used
    expect(rec.events).toEqual([]);
    await engine.generateImage({ prompt: "crosses 80 %" }); // 0.80
    expect(rec.events).toEqual([expect.objectContaining({ kind: "budget", title: "Mediataket närmar sig" })]);
    expect(rec.events[0]!.message).toBe("0.80 av 1.00 USD använt denna månad (80 % eller mer).");
    await engine.generateImage({ prompt: "already past it" });
    expect(rec.events).toHaveLength(1);
  });

  it("a failing notifier never stops publishing, and the error is reported in the result", async () => {
    const { engine, rec, linkedin } = setup();
    rec.fail = true;
    await approved(engine);
    const res = await engine.tick();
    expect(res.published).toHaveLength(1);
    expect(linkedin.published).toHaveLength(1);
    expect(res.notifyErrors).toEqual(["webhook down"]);
  });

  it("without a notifier nothing changes", async () => {
    const { engine } = setup({ notifier: null });
    await approved(engine);
    const res = await engine.tick();
    expect(res.published).toHaveLength(1);
    expect(res.notifyErrors).toBeUndefined();
  });
});

describe("notify-test and doctor", () => {
  it("notify-test sends a message, and says what is missing otherwise", async () => {
    const { sql } = await freshDb();
    const { fn, calls } = mockFetch([{ match: (u) => u === "https://ntfy.sh/", reply: () => new Response("ok") }]);
    expect(await runCli(["notify-test"], { env: { NOTIFY_URL: NTFY, APP_URL: "https://app.example/" }, sql, fetch: fn })).toBe("test notification sent (ntfy)");
    expect(JSON.parse(String(calls[0]!.init!.body))).toMatchObject({ topic: "david-secret-topic-9x", title: "Testnotis", click: "https://app.example/" });
    await expect(runCli(["notify-test"], { env: {}, sql })).rejects.toThrow(/NOTIFY_URL is not set/);
  });

  it("an invalid NOTIFY_FORMAT or an http address is rejected by configuration", async () => {
    const { sql } = await freshDb();
    await expect(runCli(["notify-test"], { env: { NOTIFY_URL: NTFY, NOTIFY_FORMAT: "pigeon" }, sql })).rejects.toThrow(/NOTIFY_FORMAT/);
    await expect(runCli(["notify-test"], { env: { NOTIFY_URL: "http://ntfy.sh/x" }, sql })).rejects.toThrow(/https/);
  });

  it("doctor reports notifications without sending anything, and never prints the topic", async () => {
    const { sql } = await freshDb();
    const { fn, calls } = mockFetch([]);
    const checks = await runDoctor({ env: { NOTIFY_URL: NTFY }, sql, fetch: fn });
    const c = checks.find((x) => x.name === "notifications")!;
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("ntfy");
    expect(c.detail).toContain("APP_URL");
    expect(JSON.stringify(checks)).not.toContain("david-secret-topic-9x");
    expect(calls).toHaveLength(0);
    expect((await runDoctor({ env: {}, sql, fetch: fn })).find((x) => x.name === "notifications")!.status).toBe("skip");
  });

  it("scrubSecrets removes a webhook address and its topic", () => {
    expect(scrubSecrets(`failed at ${NTFY} (topic david-secret-topic-9x)`, { NOTIFY_URL: NTFY })).toBe("failed at [redacted] (topic [redacted])");
  });
});
