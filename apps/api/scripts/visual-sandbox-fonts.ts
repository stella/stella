import { panic } from "better-result";
import path from "node:path";

// The sandbox cannot fetch the app's fonts: embed only the checked-in WOFF2
// sources declared by the app stylesheet, preserving its unicode ranges.
const FONT_FACE = /@font-face\s*\{[^}]+\}/giu;
const FONT_FAMILY_DECLARATION =
  /(?:--font-[a-z-]+|font-family)\s*:\s*([^;}]+)/giu;
const QUOTED_FONT_FAMILY = /["']([^"']+)["']/gu;

export const buildVisualFontFaces = async (guestCss: string) => {
  const webRoot = path.resolve(import.meta.dirname, "../../web");
  const stylesheet = await Bun.file(path.join(webRoot, "src/fonts.css")).text();
  const usedFamilies = new Set(
    [...guestCss.matchAll(FONT_FAMILY_DECLARATION)].flatMap((declaration) =>
      [...(declaration.at(1) ?? "").matchAll(QUOTED_FONT_FAMILY)].map(
        (family) => family.at(1) ?? panic("Font family requires a name"),
      ),
    ),
  );
  const selectedFaces = [...stylesheet.matchAll(FONT_FACE)]
    .map((match) => match[0])
    .filter((face) => {
      // Every style of a used family stays: guest markup allows em and i, and
      // a dropped italic face would fall back to a synthesized slant.
      const family = /font-family:\s*["']([^"']+)["']/iu.exec(face)?.at(1);
      return family !== undefined && usedFamilies.has(family);
    })
    .join("\n");
  const urls = [...selectedFaces.matchAll(/url\(["']?([^"')]+)["']?\)/gu)];
  const sources = new Map<string, string>();
  await Promise.all(
    urls.map(async (match) => {
      const url = match.at(1) ?? panic("Font declaration requires a URL");
      const name = /^\/fonts\/([a-z0-9-]+\.woff2)$/u.exec(url)?.at(1);
      if (!name) {
        panic(`Visual font must be a checked-in WOFF2 source: ${url}`);
      }
      const bytes = await Bun.file(
        path.join(webRoot, "public/fonts", name),
      ).arrayBuffer();
      sources.set(
        match[0],
        `url("data:font/woff2;base64,${Buffer.from(bytes).toString("base64")}")`,
      );
    }),
  );
  return selectedFaces.replace(
    /url\(["']?([^"')]+)["']?\)/gu,
    (url) => sources.get(url) ?? panic(`Font URL was not embedded: ${url}`),
  );
};
