import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import jpeg from "jpeg-js";

/** One page of a carousel. Only the fields a kind uses are read. */
export interface Slide {
  kind: "cover" | "point" | "list" | "statement" | "cta";
  title: string;
  /** Supporting sentence(s). */
  body?: string;
  /** `list` only: short numbered rows. */
  items?: string[];
  /** `cta` only: the word people are asked to comment. */
  keyword?: string;
  /** `cover` only: a photo shown behind the title (public https URL, JPEG or PNG). */
  photoUri?: string;
}

export interface Brand {
  /** Shown top left on every page, e.g. `@david`. */
  handle?: string;
  /** Accent colour, `#rrggbb`. */
  accent: string;
  theme: "dark" | "light";
}

export const DEFAULT_BRAND: Brand = { accent: "#4F8CFF", theme: "dark" };
export const SLIDE_WIDTH = 1080;
export const SLIDE_HEIGHT = 1350; // 4:5, the tallest ratio Instagram shows in full

const require_ = createRequire(import.meta.url);
let fonts: Array<{ name: string; data: Buffer; weight: 400 | 700 | 800; style: "normal" }> | undefined;
function loadFonts() {
  if (!fonts) {
    const dir = join(dirname(require_.resolve("@fontsource/inter/package.json")), "files");
    const read = (weight: 400 | 700 | 800) => ({ name: "Inter", data: readFileSync(join(dir, `inter-latin-${weight}-normal.woff`)), weight, style: "normal" as const });
    fonts = [read(400), read(700), read(800)];
  }
  return fonts;
}

/** The bundled font covers Latin text (including å, ä, ö). Anything else would print as an empty box, so drop it. */
export function cleanText(text: string): string {
  return text
    .replace(/[‘’]/g, "’")
    .replace(/→/g, "-")
    .replace(/[^\n -~ -ÿŒœ–—‘-„•…€™−]/gu, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Picks a font size from the text length; satori does not shrink text to fit. */
export function fit(text: string, steps: Array<[maxChars: number, size: number]>): number {
  for (const [max, size] of steps) if (text.length <= max) return size;
  return steps[steps.length - 1]![1];
}

export type Node = { type: string; props: Record<string, unknown> };
export const h = (type: string, style: Record<string, unknown>, children?: unknown, extra: Record<string, unknown> = {}): Node => ({
  type,
  props: { style: { display: "flex", boxSizing: "border-box", ...style }, ...extra, ...(children === undefined ? {} : { children }) },
});

const palette = (brand: Brand) =>
  brand.theme === "dark"
    ? { bg: "#0B0F14", text: "#F5F7FA", muted: "#9AA4B2", faint: "#232B36", onAccent: "#0B0F14" }
    : { bg: "#F7F5F0", text: "#10151C", muted: "#5B6573", faint: "#DDD9D0", onAccent: "#FFFFFF" };

export function slideTree(slide: Slide, index: number, total: number, brand: Brand, photo?: string): Node {
  const c = palette(brand);
  const title = cleanText(slide.title);
  const body = slide.body ? cleanText(slide.body) : "";
  const pad = 88;
  const onPhoto = slide.kind === "cover" && photo !== undefined;
  const text = onPhoto ? "#FFFFFF" : c.text;
  const muted = onPhoto ? "#D6DBE3" : c.muted;

  const top = h("div", { justifyContent: "space-between", alignItems: "center", width: "100%" }, [
    h("div", { fontSize: 30, fontWeight: 700, color: muted }, cleanText(brand.handle ?? "")),
    h("div", { fontSize: 30, fontWeight: 700, color: muted }, `${index + 1}/${total}`),
  ]);

  const chevron = (color: string) =>
    h("div", { width: 22, height: 22, borderTop: `6px solid ${color}`, borderRight: `6px solid ${color}`, transform: "rotate(45deg)", marginLeft: 8 });
  const bottom = h("div", { flexDirection: "column", width: "100%" }, [
    h("div", { width: "100%", height: 6, background: onPhoto ? "rgba(255,255,255,0.25)" : c.faint, borderRadius: 3, marginBottom: 28 }, [
      h("div", { width: `${((index + 1) / total) * 100}%`, height: 6, background: brand.accent, borderRadius: 3 }),
    ]),
    h("div", { justifyContent: "flex-end", alignItems: "center", height: 34 }, index < total - 1 ? [h("div", { fontSize: 30, fontWeight: 700, color: muted }, "Svep"), chevron(muted)] : ""),
  ]);

  let middle: Node;
  switch (slide.kind) {
    case "cover":
      middle = h("div", { flexDirection: "column", justifyContent: "center", flex: 1 }, [
        h("div", { width: 120, height: 12, background: brand.accent, borderRadius: 6, marginBottom: 48 }),
        h("div", { fontSize: fit(title, [[28, 128], [48, 108], [72, 92], [110, 78], [160, 66]]), fontWeight: 800, color: text, lineHeight: 1.06, letterSpacing: -2 }, title),
        ...(body ? [h("div", { fontSize: 42, color: muted, marginTop: 44, lineHeight: 1.3 }, body)] : []),
      ]);
      break;
    case "point":
      middle = h("div", { flexDirection: "column", justifyContent: "center", flex: 1 }, [
        h("div", { fontSize: 120, fontWeight: 800, color: brand.accent, lineHeight: 1, marginBottom: 28 }, String(index).padStart(2, "0")),
        h("div", { fontSize: fit(title, [[30, 84], [60, 70], [100, 58]]), fontWeight: 800, color: text, lineHeight: 1.1, letterSpacing: -1 }, title),
        ...(body ? [h("div", { fontSize: fit(body, [[140, 46], [260, 40], [400, 35]]), color: muted, marginTop: 36, lineHeight: 1.35 }, body)] : []),
      ]);
      break;
    case "list": {
      const items = (slide.items ?? []).map(cleanText).filter(Boolean).slice(0, 8);
      const size = fit(items.join(" "), [[120, 52], [200, 46], [320, 40]]);
      middle = h("div", { flexDirection: "column", justifyContent: "center", flex: 1 }, [
        h("div", { fontSize: fit(title, [[30, 68], [60, 58]]), fontWeight: 800, color: text, lineHeight: 1.1, marginBottom: 44, letterSpacing: -1 }, title),
        ...items.map((it, i) =>
          h("div", { alignItems: "flex-start", marginBottom: 22 }, [
            h("div", { fontSize: size, fontWeight: 800, color: brand.accent, width: size * 1.7 }, `${i + 1}.`),
            h("div", { fontSize: size, color: text, lineHeight: 1.2, flex: 1 }, it),
          ]),
        ),
      ]);
      break;
    }
    case "statement":
      middle = h("div", { flexDirection: "column", justifyContent: "center", flex: 1 }, [
        h("div", { fontSize: fit(title, [[40, 112], [80, 92], [140, 74], [220, 60]]), fontWeight: 800, color: text, lineHeight: 1.1, letterSpacing: -2 }, title),
        ...(body ? [h("div", { fontSize: 40, color: muted, marginTop: 40, lineHeight: 1.35 }, body)] : []),
      ]);
      break;
    case "cta": {
      const keyword = cleanText(slide.keyword ?? "").toUpperCase();
      middle = h("div", { flexDirection: "column", justifyContent: "center", flex: 1 }, [
        h("div", { fontSize: fit(title, [[40, 96], [80, 80], [140, 66]]), fontWeight: 800, color: text, lineHeight: 1.08, letterSpacing: -1.5 }, title),
        ...(body ? [h("div", { fontSize: 42, color: muted, marginTop: 36, lineHeight: 1.3 }, body)] : []),
        ...(keyword
          ? [
              h("div", { marginTop: 64 }, [
                h("div", { background: brand.accent, color: c.onAccent, fontSize: 56, fontWeight: 800, padding: "26px 52px", borderRadius: 24 }, `Kommentera ${keyword}`),
              ]),
            ]
          : []),
      ]);
      break;
    }
  }

  const layers: Node[] = [];
  if (onPhoto) {
    layers.push(
      h("div", { position: "absolute", top: 0, left: 0, width: SLIDE_WIDTH, height: SLIDE_HEIGHT }, [
        { type: "img", props: { src: photo, width: SLIDE_WIDTH, height: SLIDE_HEIGHT, style: { width: SLIDE_WIDTH, height: SLIDE_HEIGHT, objectFit: "cover" } } },
      ]),
      h("div", { position: "absolute", top: 0, left: 0, width: SLIDE_WIDTH, height: SLIDE_HEIGHT, backgroundImage: "linear-gradient(180deg, rgba(5,8,12,0.62) 0%, rgba(5,8,12,0.8) 50%, rgba(5,8,12,0.94) 100%)" }),
    );
  }
  return h(
    "div",
    { position: "relative", width: SLIDE_WIDTH, height: SLIDE_HEIGHT, background: c.bg, fontFamily: "Inter", color: text },
    [
      ...layers,
      h("div", { position: "relative", flexDirection: "column", width: SLIDE_WIDTH, height: SLIDE_HEIGHT, padding: pad, justifyContent: "space-between" }, [top, middle, bottom]),
    ],
  );
}

/** Renders one slide to a JPEG (Instagram accepts only JPEG; every other channel takes it too). */
export async function renderSlide(slide: Slide, index: number, total: number, brand: Brand = DEFAULT_BRAND, photo?: string): Promise<Uint8Array> {
  const svg = await satori(slideTree(slide, index, total, brand, photo) as never, { width: SLIDE_WIDTH, height: SLIDE_HEIGHT, fonts: loadFonts() });
  const image = new Resvg(svg, { fitTo: { mode: "width", value: SLIDE_WIDTH } }).render();
  return new Uint8Array(jpeg.encode({ data: image.pixels, width: image.width, height: image.height }, 90).data);
}

/** Draws any element tree to a PNG, keeping transparency where the tree paints nothing. */
export async function treeToPng(tree: Node, width: number, height: number): Promise<Uint8Array> {
  const svg = await satori(tree as never, { width, height, fonts: loadFonts() });
  return new Uint8Array(new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng());
}

/** `#rrggbb` only: the value ends up inside a drawing instruction, so nothing else is let through. */
export function parseAccent(value: string | undefined): string | undefined {
  return value && /^#[0-9a-fA-F]{6}$/.test(value.trim()) ? value.trim() : undefined;
}
