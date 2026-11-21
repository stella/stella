#!/usr/bin/env bun
// Renders the committed site-wide Open Graph card:
//
//   public/images/og-card.png
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

const png = await renderOgCard({ headline: "Legal workspace. Open source." });
const pngPath = path.join(IMAGE_DIR, "og-card.png");
writeFileSync(pngPath, png);

console.log(`Rendered ${pngPath}`);
