import { panic } from "better-result";
import path from "node:path";

// The sandbox cannot fetch the app's fonts: embed only the checked-in WOFF2
// sources declared by the app stylesheet, preserving its unicode ranges.
export const buildVisualFontFaces = async () => {
  const webRoot = path.resolve(import.meta.dirname, "../../web");
  const stylesheet = await Bun.file(path.join(webRoot, "src/fonts.css")).text();
  const urls = [...stylesheet.matchAll(/url\(["']?([^"')]+)["']?\)/gu)];
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
  return stylesheet.replace(
    /url\(["']?([^"')]+)["']?\)/gu,
    (url) => sources.get(url) ?? panic(`Font URL was not embedded: ${url}`),
  );
};
