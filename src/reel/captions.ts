import { cleanText, fit, h, treeToPng, type Brand } from "../carousel/render.js";

export const REEL_WIDTH = 1080;
export const REEL_HEIGHT = 1920;
export const CAPTION_HEIGHT = 520;
export const CAPTION_Y = 1060;
export const HOOK_HEIGHT = 420;
export const HOOK_Y = 130;

/** The one word of a caption that gets the accent colour: the longest, if it is long enough to matter. */
export function highlightIndex(words: string[]): number {
  let best = -1;
  let length = 4;
  words.forEach((w, i) => {
    const n = w.replace(/[^\p{L}\p{N}]/gu, "").length;
    if (n > length) {
      best = i;
      length = n;
    }
  });
  return best;
}

/** A caption: a few big bold words, one of them in the accent colour, on a transparent background. */
export async function renderCaption(text: string, brand: Brand): Promise<Uint8Array> {
  const clean = cleanText(text);
  const words = clean.split(" ").filter(Boolean);
  const size = fit(clean, [[12, 124], [20, 108], [30, 92]]);
  const highlight = highlightIndex(words);
  const tree = h(
    "div",
    { width: REEL_WIDTH, height: CAPTION_HEIGHT, alignItems: "center", justifyContent: "center", padding: "0 56px", fontFamily: "Inter" },
    [
      h(
        "div",
        { flexWrap: "wrap", justifyContent: "center", alignItems: "center", textAlign: "center" },
        words.map((w, i) =>
          h("div", { fontSize: size, fontWeight: 800, color: i === highlight ? brand.accent : "#FFFFFF", margin: "0 14px", lineHeight: 1.12, letterSpacing: -2, textShadow: "0 6px 24px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.9)" }, w),
        ),
      ),
    ],
  );
  return treeToPng(tree, REEL_WIDTH, CAPTION_HEIGHT);
}

/** The headline across the top of the Reel, like the one that frames a clip in the examples people share. */
export async function renderHook(text: string, brand: Brand): Promise<Uint8Array> {
  const clean = cleanText(text);
  const tree = h(
    "div",
    { width: REEL_WIDTH, height: HOOK_HEIGHT, flexDirection: "column", alignItems: "center", justifyContent: "flex-start", padding: "0 64px", fontFamily: "Inter" },
    [
      h("div", { background: "rgba(8,11,16,0.72)", borderRadius: 28, padding: "30px 40px", borderLeft: `10px solid ${brand.accent}` }, [
        h("div", { fontSize: fit(clean, [[34, 62], [60, 54], [90, 46]]), fontWeight: 800, color: "#FFFFFF", lineHeight: 1.14, letterSpacing: -1 }, clean),
      ]),
      ...(brand.handle ? [h("div", { fontSize: 30, fontWeight: 700, color: "rgba(255,255,255,0.85)", marginTop: 22, textShadow: "0 2px 10px rgba(0,0,0,0.8)" }, cleanText(brand.handle))] : []),
    ],
  );
  return treeToPng(tree, REEL_WIDTH, HOOK_HEIGHT);
}

export const CARD_WIDTH = 1000;
export const CARD_HEIGHT = 520;
export const CARD_X = 40;
export const CARD_Y = 520;

/** A key-point card (like the boxes in an explainer): a few big words on a light panel, with an accent edge. */
export async function renderCard(title: string, body: string | undefined, brand: Brand): Promise<Uint8Array> {
  const t = cleanText(title);
  const b = body ? cleanText(body) : "";
  const tree = h("div", { width: CARD_WIDTH, height: CARD_HEIGHT, padding: 10, fontFamily: "Inter" }, [
    h(
      "div",
      { flex: 1, flexDirection: "column", justifyContent: "center", background: "rgba(250,251,253,0.97)", borderRadius: 36, borderLeft: `18px solid ${brand.accent}`, padding: "30px 48px" },
      [
        h("div", { fontSize: fit(t, [[22, 88], [40, 72], [70, 58]]), fontWeight: 800, color: "#0B0F14", lineHeight: 1.08, letterSpacing: -2 }, t),
        ...(b ? [h("div", { fontSize: fit(b, [[60, 42], [120, 36]]), color: "#4B5563", marginTop: 24, lineHeight: 1.3 }, b)] : []),
      ],
    ),
  ]);
  return treeToPng(tree, CARD_WIDTH, CARD_HEIGHT);
}

/** A fully transparent image of the card's size, shown between cards. */
export async function renderBlankCard(): Promise<Uint8Array> {
  return treeToPng(h("div", { width: CARD_WIDTH, height: CARD_HEIGHT }), CARD_WIDTH, CARD_HEIGHT);
}

/** A fully transparent caption-sized image, shown between captions. */
export async function renderBlank(): Promise<Uint8Array> {
  return treeToPng(h("div", { width: REEL_WIDTH, height: CAPTION_HEIGHT }), REEL_WIDTH, CAPTION_HEIGHT);
}
