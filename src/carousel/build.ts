import { DEFAULT_BRAND, parseAccent, renderSlide, type Brand, type Slide } from "./render.js";
import type { CarouselInput, CarouselWriter, WrittenCarousel } from "./write.js";
import type { FetchLike } from "../adapters/types.js";
import type { Asset } from "../domain.js";

export interface BuiltCarousel extends WrittenCarousel {
  /** One JPEG per page, in order. */
  images: Uint8Array[];
  /** Things that did not go as planned but did not stop the carousel (e.g. the cover photo could not be used). */
  notes: string[];
}

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

/** The first of the creator's own photos that can be drawn behind the cover. */
export function coverPhoto(assets: Asset[]): Asset | undefined {
  return assets.find((a) => {
    if (a.kind !== "image" || !a.uri.startsWith("https://")) return false;
    const ext = /\.([A-Za-z0-9]+)$/.exec(a.uri.split(/[?#]/)[0] ?? "")?.[1]?.toLowerCase();
    return !ext || ["jpg", "jpeg", "png"].includes(ext);
  });
}

async function photoDataUri(asset: Asset, fetchFn: FetchLike): Promise<string> {
  const res = await fetchFn(asset.uri);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_PHOTO_BYTES) throw new Error("larger than 8 MB");
  // The bytes decide, not the header: a wrong content-type must not produce a broken image.
  const mime = bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : bytes[0] === 0x89 && bytes[1] === 0x50 ? "image/png" : undefined;
  if (!mime) throw new Error(`not a JPEG or PNG file${type ? ` (${type})` : ""}`);
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** Writes the carousel with the writer and draws every page. Pure: nothing is stored here. */
export async function buildCarousel(opts: {
  writer: CarouselWriter;
  input: CarouselInput;
  brand?: Brand;
  fetch?: FetchLike;
}): Promise<BuiltCarousel> {
  const brand = opts.brand ?? DEFAULT_BRAND;
  const written = await opts.writer.write(opts.input);
  const notes: string[] = [];

  let photo: string | undefined;
  const photoAsset = coverPhoto(opts.input.assets);
  if (photoAsset) {
    try {
      photo = await photoDataUri(photoAsset, opts.fetch ?? fetch);
    } catch (err) {
      notes.push(`the cover photo could not be used (${(err as Error).message}); the cover has no photo`);
    }
  }

  const total = written.slides.length;
  const images: Uint8Array[] = [];
  for (let i = 0; i < total; i++) images.push(await renderSlide(written.slides[i] as Slide, i, total, brand, i === 0 ? photo : undefined));
  return { ...written, images, notes };
}

/** Brand settings from the environment: CAROUSEL_HANDLE, CAROUSEL_ACCENT (#rrggbb), CAROUSEL_THEME (dark|light). */
export function brandFromEnv(env: Record<string, string | undefined>): Brand {
  if (env.CAROUSEL_THEME && env.CAROUSEL_THEME !== "dark" && env.CAROUSEL_THEME !== "light") throw new Error(`CAROUSEL_THEME must be dark or light, got "${env.CAROUSEL_THEME}"`);
  if (env.CAROUSEL_ACCENT && !parseAccent(env.CAROUSEL_ACCENT)) throw new Error(`CAROUSEL_ACCENT must look like #4F8CFF, got "${env.CAROUSEL_ACCENT}"`);
  return {
    handle: env.CAROUSEL_HANDLE?.trim() || undefined,
    accent: parseAccent(env.CAROUSEL_ACCENT) ?? DEFAULT_BRAND.accent,
    theme: (env.CAROUSEL_THEME as Brand["theme"] | undefined) ?? DEFAULT_BRAND.theme,
  };
}
