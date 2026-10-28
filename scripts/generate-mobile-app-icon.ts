// The mobile app's icon: the web's favicon, drawn edge to edge.
//
// `apps/web/public/favicon.svg` is the brand mark on its blue tile with the
// tile's corners rounded. iOS rounds an app icon itself and refuses one with
// transparency, so the icon is the same drawing with square corners,
// rasterized to the 1024-pixel opaque PNG that Expo builds every size from.

import { panic } from "better-result";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const FAVICON = path.join(REPO_ROOT, "apps/web/public/favicon.svg");
const OUTPUT = path.join(REPO_ROOT, "apps/mobile/assets/icon.png");
const SIZE = 1024;

/** The favicon with its tile's corners squared and drawn at the icon's size. */
export const appIconSvg = (favicon: string): string => {
  const squared = favicon.replace(/(<rect\b[^>]*?)\s+rx="[\d.]+"/u, "$1");
  if (squared === favicon) {
    return panic("The favicon has no rounded tile to square");
  }
  return squared.replace(
    "<svg ",
    () => `<svg width="${SIZE}" height="${SIZE}" `,
  );
};

/** The tile's colour, which fills the PNG so it carries no alpha channel. */
const tileColour = (favicon: string): string =>
  /<rect\b[^>]*\bfill="(#[\da-f]{6})"/iu.exec(favicon)?.[1] ??
  panic("The favicon's tile has no fill colour");

const main = async () => {
  const favicon = await readFile(FAVICON, "utf-8");
  const png = await sharp(Buffer.from(appIconSvg(favicon)))
    .flatten({ background: tileColour(favicon) })
    .removeAlpha()
    .png()
    .toBuffer();
  await writeFile(OUTPUT, png);
};

if (import.meta.main) {
  await main();
}
