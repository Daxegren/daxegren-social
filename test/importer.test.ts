import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeChannel } from "../src/analyze.js";
import { PostgresStore } from "../src/postgres-store.js";
import { runCli } from "../src/worker/cli.js";
import { MAX_IMPORT_ROWS, parseCsv, parsePosts } from "../src/worker/importer.js";
import { freshDb } from "./pg.js";

const NOW = new Date("2026-11-04T08:00:00Z");
const parse = (text: string, channel: "linkedin" | "instagram" = "linkedin") => parsePosts(text, { channel, now: NOW });

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, newlines inside quotes, CRLF and a BOM", () => {
    const csv = '﻿a,b\r\n"one, two","say ""hi"""\r\n"line1\nline2",x\r\n';
    expect(parseCsv(csv)).toEqual([["a", "b"], ["one, two", 'say "hi"'], ["line1\nline2", "x"]]);
  });

  it("detects semicolons (Swedish Excel) and tabs, and skips blank rows", () => {
    expect(parseCsv("a;b\n1;2\n\n3;4")).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
    expect(parseCsv("a\tb\n1\t2")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("rejects an unclosed quote instead of swallowing the rest of the file", () => {
    expect(() => parseCsv('a,b\n"oops,1')).toThrow(/unclosed quote/);
  });
});

describe("parsePosts: columns", () => {
  it("reads a LinkedIn-style export (Date, ShareLink, ShareCommentary, MediaUrl)", () => {
    const csv = 'Date,ShareLink,ShareCommentary,MediaUrl,Visibility\n2026-10-03 14:30:00,https://www.linkedin.com/feed/update/urn:li:share:1,"Vi bygger öppet.\nTre lärdomar.",https://media/x.jpg,MEMBER_NETWORK\n';
    const { posts, skipped } = parse(csv);
    expect(skipped).toEqual([]);
    expect(posts[0]).toMatchObject({
      channel: "linkedin", text: "Vi bygger öppet.\nTre lärdomar.", publishedAt: "2026-10-03T14:30:00.000Z",
      url: "https://www.linkedin.com/feed/update/urn:li:share:1", mediaKinds: ["image"], metrics: undefined,
    });
  });

  it("reads metrics under common names and numbers with thousands separators", () => {
    const { posts } = parse("date,text,Impressions,Reactions,Comments,Reposts,Clicks\n2026-10-03,Hej,\"12 345\",1.200,7,3,\n");
    expect(posts[0]!.metrics).toEqual({ collectedAt: NOW.toISOString(), impressions: 12345, likes: 1200, comments: 7, shares: 3 });
  });

  it("reads JSON as an array or wrapped in {posts}", () => {
    const item = { date: "2026-10-03T08:00:00Z", caption: "Hej", likes: 5, media: "reel" };
    expect(parse(JSON.stringify([item]), "instagram").posts[0]).toMatchObject({ text: "Hej", mediaKinds: ["video"], metrics: { likes: 5 } });
    expect(parse(JSON.stringify({ posts: [item] }), "instagram").posts).toHaveLength(1);
    expect(() => parse('{"nope": 1}')).toThrow(/array of posts/);
  });

  it("explains which columns it needs when it cannot find them", () => {
    expect(() => parse("foo,bar\n1,2")).toThrow(/need a date column and a text column. Found: foo, bar/);
    expect(() => parse("")).toThrow(/empty/);
  });
});

describe("parsePosts: dates", () => {
  it("reads dates without a time zone as UTC, and respects an explicit offset", () => {
    const at = (d: string) => parse(`date,text\n${d},x`).posts[0]?.publishedAt;
    expect(at("2026-10-03")).toBe("2026-10-03T00:00:00.000Z");
    expect(at("2026-10-03 09:05")).toBe("2026-10-03T09:05:00.000Z");
    expect(at("2026-10-03T09:05:00+02:00")).toBe("2026-10-03T07:05:00.000Z");
  });

  it("skips ambiguous or invalid dates with the row number instead of guessing", () => {
    const { posts, skipped } = parse("date,text\n03/10/2026,a\n2026-13-45,b\n2026-10-03,c");
    expect(posts.map((p) => p.text)).toEqual(["c"]);
    expect(skipped.map((s) => s.reason)).toEqual([
      expect.stringContaining('row 2: unrecognised date "03/10/2026"'),
      expect.stringContaining("row 3: unrecognised date"),
    ]);
  });
});

describe("parsePosts: validation", () => {
  it("reports unreadable numbers, media and empty rows, and imports the rest", () => {
    const csv = "date,text,likes,media\n2026-10-01,ok,5,image\n2026-10-02,bad likes,abc,\n2026-10-03,bad media,1,hologram\n2026-10-04,,,\n";
    const { posts, skipped } = parse(csv);
    expect(posts.map((p) => p.text)).toEqual(["ok"]);
    expect(skipped.map((s) => s.reason)).toEqual([
      expect.stringContaining('row 3: likes is not a whole number ("abc")'),
      expect.stringContaining('row 4: unrecognised media "hologram"'),
      expect.stringContaining("row 5: no text and no media"),
    ]);
  });

  it("skips duplicates within the file, and derives stable ids so a re-import cannot duplicate", () => {
    const csv = "date,text\n2026-10-01,same\n2026-10-01,same\n2026-10-02,same\n";
    const first = parse(csv);
    expect(first.posts).toHaveLength(2);
    expect(first.skipped[0]!.reason).toMatch(/duplicate of row 2/);
    expect(parse(csv).posts.map((p) => p.externalId)).toEqual(first.posts.map((p) => p.externalId)); // stable
    expect(parse(csv, "instagram").posts[0]!.externalId).not.toBe(first.posts[0]!.externalId); // channel is part of the id
  });

  it("an explicit id column wins over the derived one", () => {
    expect(parse("id,date,text\nabc123,2026-10-01,x").posts[0]!.externalId).toBe("abc123");
  });

  it("refuses files with too many rows", () => {
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `2026-10-01,post ${i}`).join("\n");
    expect(() => parse(`date,text\n${rows}`)).toThrow(/too many rows/);
  });
});

describe("cli import", () => {
  const file = (name: string, content: string) => {
    const dir = mkdtempSync(join(tmpdir(), "import-"));
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };

  it("loads posts into the database, is idempotent, and gives the engine something to learn from", async () => {
    const { sql } = await freshDb();
    const csv = [
      "date,text,impressions,likes",
      "2026-10-01 09:00,Morgontips,1000,90",
      "2026-10-08 09:00,Veckans lärdom,1000,80",
      "2026-10-02 15:00,Lunchtanke,1000,5",
      "2026-10-09 15:00,Eftermiddag,1000,3",
    ].join("\n");
    const path = file("posts.csv", csv);
    const deps = { env: {}, sql, now: () => NOW };

    expect(await runCli(["import", "linkedin", path], deps)).toBe("imported 4 post(s) into linkedin (4 with metrics)");
    await runCli(["import", "linkedin", path], deps); // again
    const store = new PostgresStore(sql);
    const posts = await store.listPosts({ channel: "linkedin" });
    expect(posts).toHaveLength(4);

    const insights = analyzeChannel("linkedin", posts);
    expect(insights.bestHoursUtc[0]).toBe(9);
    expect(insights.topPosts[0]!.engagementRate).toBeCloseTo(0.09);
  });

  it("--dry-run writes nothing, and the summary lists what was skipped", async () => {
    const { sql } = await freshDb();
    const path = file("p.csv", "date,text\n2026-10-01,ok\nnot a date,bad\n");
    const out = await runCli(["import", "linkedin", path, "--dry-run"], { env: {}, sql, now: () => NOW });
    expect(out).toMatch(/^would import 1 post\(s\) into linkedin \(0 with metrics\); skipped 1:\n  row 3: unrecognised date/);
    expect(await new PostgresStore(sql).listPosts()).toHaveLength(0);
  });

  it("explains bad usage", async () => {
    const { sql } = await freshDb();
    await expect(runCli(["import", "linkedin"], { env: {}, sql })).rejects.toThrow(/usage/);
    await expect(runCli(["import", "myspace", "x.csv"], { env: {}, sql })).rejects.toThrow(/expected a channel/);
  });
});
