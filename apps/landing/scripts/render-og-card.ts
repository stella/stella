#!/usr/bin/env bun
// Renders the committed site-wide Open Graph card:
//
//   public/images/og-card.png (+ .svg wrapper)
//
// This is the fallback card, used where a page's title cannot be drawn in the
// Latin-only display face (Arabic) and as the blog's structured-data image.
// Every other card is generated per page at build time from that page's own
// <title> — see src/integrations/og-cards.ts.
//
// Manual tool with committed output; regenerate after changing the gradient,
// the wordmark, or the card layout:
//
//   bun run render:og-card    (from apps/landing)
import { writeFileSync } from "node:fs";
import path from "node:path";

import { renderOgCard } from "../src/lib/og-card";
import { resolveLandingPath } from "../src/lib/og-card-path";

const IMAGE_DIR = resolveLandingPath("public", "images");
const WIDTH = 1200;
const HEIGHT = 630;

const png = await renderOgCard({ headline: "Legal workspace. Open source." });
const pngPath = path.join(IMAGE_DIR, "og-card.png");
writeFileSync(pngPath, png);

// The .svg wrapper embeds the same pixels for consumers that ask for an SVG.
const svgPath = path.join(IMAGE_DIR, "og-card.svg");
writeFileSync(
  svgPath,
  `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" fill="none" xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,${png.toString("base64")}" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" /></svg>`,
);

console.log(`Rendered ${pngPath}`);
console.log(`Rendered ${svgPath}`);
