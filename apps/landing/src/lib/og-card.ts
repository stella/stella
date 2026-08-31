// Renders one Open Graph card: brand gradient, wordmark, and the page's own
// headline set in the display face. Every card on the site comes from here —
// the per-page cards the og-cards integration writes at build time, the
// changelog release cards served from an endpoint, and the committed
// site-wide fallback — so a layout change lands on all of them at once.
import { Resvg } from "@resvg/resvg-js";
import { readFileSync } from "node:fs";

import {
  CARD_FACES,
  type CardDirection,
  resolveLandingPath,
} from "./og-card-path";
import { fitHeadline } from "./og-card-text";

const WIDTH = 1200;
const HEIGHT = 630;
const MARGIN_X = 84;
/** Baseline of the last headline line; earlier lines stack upward from it. */
const HEADLINE_BASELINE = 450;

type OgCardOptions = {
  headline: string;
  /** Small label opposite the wordmark; the changelog's version. */
  badge?: string;
  /** Writing direction, mirroring the page's own <html dir>. Defaults to ltr. */
  direction?: CardDirection;
};

/**
 * Truecolor PNG, ~540 kB at maximum zlib level. The card is mostly a soft
 * gradient, and palette quantization (Bun.Image, 128 or 256 colours)
 * posterizes it into visible contour bands; its dither option smears the
 * headline instead of hiding them. The size is the price of a smooth gradient
 * until a quantizer with a working error-diffusion pass is available.
 */
export const renderOgCard = async (options: OgCardOptions): Promise<Buffer> => {
  const face = CARD_FACES[options.direction ?? "ltr"];
  const rendered = new Resvg(await cardSvg(options), {
    fitTo: { mode: "width", value: WIDTH },
    font: { fontFiles: [face.path], loadSystemFonts: false },
  }).render();

  Bun.Image.backend = "bun";
  return await new Bun.Image(rendered.asPng())
    .png({ compressionLevel: 9 })
    .buffer();
};

const cardSvg = async ({
  headline,
  badge,
  direction = "ltr",
}: OgCardOptions): Promise<string> => {
  const rtl = direction === "rtl";
  // The whole card mirrors, not just the text: an Arabic reader starts at the
  // right edge, so the wordmark and the headline both anchor there.
  const textX = rtl ? WIDTH - MARGIN_X : MARGIN_X;
  const anchor = rtl ? "end" : "start";
  const { fontSize, lines } = fitHeadline(headline);
  // Arabic sets taller than Latin at the same size: its ascenders, descenders
  // and marks collide at the tight leading the display face is drawn for.
  const lineHeight = Math.round(fontSize * (rtl ? 1.2 : 0.9));
  const firstBaseline = HEADLINE_BASELINE - (lines.length - 1) * lineHeight;
  // One <text> per line rather than one <text> of <tspan>s: resvg mis-places
  // tspans that carry their own x under direction="rtl", stacking the Arabic
  // lines on top of each other.
  const headlineMarkup = lines
    .map(
      (line, index) =>
        `<text x="${textX}" y="${firstBaseline + index * lineHeight}" text-anchor="${anchor}" direction="${direction}" class="display" font-size="${fontSize}">${escapeXml(line)}</text>`,
    )
    .join("\n  ");

  const backgroundImage = await cardBackground();
  return String.raw`<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      .display {
        font-family: "${CARD_FACES[direction].family}", sans-serif;
        letter-spacing: -0.02em;
        fill: #111827;
        font-weight: 400;
      }
    </style>
  </defs>

  <image href="data:image/png;base64,${backgroundImage}" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" preserveAspectRatio="xMidYMid slice" />
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#F7FAFF" fill-opacity="0.04" />

  <image
    href="data:image/svg+xml;base64,${wordmark(direction)}"
    x="${rtl ? WIDTH - MARGIN_X - WORDMARK_WIDTH : MARGIN_X}"
    y="72"
    width="${WORDMARK_WIDTH}"
    height="62"
    preserveAspectRatio="${rtl ? "xMaxYMin" : "xMinYMin"} meet"
  />
  ${badge === undefined ? "" : `<text x="${rtl ? MARGIN_X : WIDTH - MARGIN_X}" y="122" text-anchor="${rtl ? "start" : "end"}" class="display" font-size="58">${escapeXml(badge)}</text>`}

  ${headlineMarkup}
</svg>`;
};

const WORDMARK_WIDTH = 236;

let background: Promise<string> | undefined;

/**
 * The hero gradient, pre-scaled to card size once. Re-decoding the full-size
 * source per card dominated render time when every page started getting one.
 */
const cardBackground = async (): Promise<string> => {
  background ??= (async () => {
    Bun.Image.backend = "bun";
    const source = await new Bun.Image(
      readFileSync(
        resolveLandingPath("public", "brand", "stella-gradient-1.webp"),
      ),
    )
      .resize(WIDTH)
      .png({ palette: true, colors: CARD_PALETTE_COLOURS })
      .toBase64();

    return new Resvg(
      String.raw`<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,${source}" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" preserveAspectRatio="xMidYMid slice" /></svg>`,
      { fitTo: { mode: "width", value: WIDTH } },
    )
      .render()
      .asPng()
      .toString("base64");
  })();
  return await background;
};

const logos = new Map<string, string>();

/** The same pair the header and footer switch between (SiteHeader, LandingFooter). */
const wordmark = (direction: "ltr" | "rtl"): string => {
  const file = direction === "rtl" ? "stella-logo-ar.svg" : "stella-logo.svg";
  const cached = logos.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const encoded = readFileSync(
    resolveLandingPath("public", "images", file),
  ).toString("base64");
  logos.set(file, encoded);
  return encoded;
};

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
