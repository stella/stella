// Renders one Open Graph card: brand gradient, wordmark, and the page's own
// headline set in the display face. Every card on the site comes from here —
// the per-page cards the og-cards integration writes at build time, the
// changelog release cards served from an endpoint, and the committed
// site-wide fallback — so a layout change lands on all of them at once.
import { Resvg } from "@resvg/resvg-js";
import { readFileSync } from "node:fs";
import sharp from "sharp";

import {
  CARD_FACES,
  type CardDirection,
  resolveLandingPath,
} from "./og-card-path";

const WIDTH = 1200;
const HEIGHT = 630;
const MARGIN_X = 84;
const TEXT_MAX_WIDTH = 1000;
/** Baseline of the last headline line; earlier lines stack upward from it. */
const HEADLINE_BASELINE = 450;
const HEADLINE_MAX_LINES = 3;
const HEADLINE_MAX_FONT_SIZE = 104;
const HEADLINE_MIN_FONT_SIZE = 60;
const HEADLINE_FONT_STEP = 8;

/**
 * Colour count for the palette encoding below. resvg emits 24-bit PNG, which
 * is ~700 kB for an image that is mostly gradient; 128 colours reduces that to
 * ~90 kB with no banding visible at card size. Cards are fetched by every
 * crawler that sees a link, so the difference is worth the quantization pass.
 */
const CARD_PALETTE_COLOURS = 128;

type OgCardOptions = {
  headline: string;
  /** Small label opposite the wordmark; the changelog's version. */
  badge?: string;
  /** Writing direction, mirroring the page's own <html dir>. Defaults to ltr. */
  direction?: CardDirection;
};

export const renderOgCard = async (options: OgCardOptions): Promise<Buffer> => {
  const face = CARD_FACES[options.direction ?? "ltr"];
  const rendered = new Resvg(cardSvg(options), {
    fitTo: { mode: "width", value: WIDTH },
    font: { fontFiles: [face.path], loadSystemFonts: false },
  }).render();

  return sharp(Buffer.from(rendered.pixels), {
    raw: { width: WIDTH, height: HEIGHT, channels: 4 },
  })
    .png({ palette: true, colours: CARD_PALETTE_COLOURS })
    .toBuffer();
};

const cardSvg = ({
  headline,
  badge,
  direction = "ltr",
}: OgCardOptions): string => {
  const rtl = direction === "rtl";
  // The whole card mirrors, not just the text: an Arabic reader starts at the
  // right edge, so the wordmark and the headline both anchor there.
  const textX = rtl ? WIDTH - MARGIN_X : MARGIN_X;
  const anchor = rtl ? "end" : "start";
  const { fontSize, lines } = fitLines(headline);
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

  <image href="data:image/png;base64,${cardBackground()}" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" preserveAspectRatio="xMidYMid slice" />
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

type FittedHeadline = { fontSize: number; lines: string[] };

/** Largest size at which the headline fits the box without being cut short. */
const fitLines = (headline: string): FittedHeadline => {
  for (
    let fontSize = HEADLINE_MAX_FONT_SIZE;
    fontSize > HEADLINE_MIN_FONT_SIZE;
    fontSize -= HEADLINE_FONT_STEP
  ) {
    const lines = wrapText(headline, fontSize);
    if (!lines.some((line) => line.endsWith(ELLIPSIS))) {
      return { fontSize, lines };
    }
  }
  return {
    fontSize: HEADLINE_MIN_FONT_SIZE,
    lines: wrapText(headline, HEADLINE_MIN_FONT_SIZE),
  };
};

const ELLIPSIS = "…";

const wrapText = (text: string, fontSize: number): string[] => {
  const lines: string[] = [];
  let current = "";

  for (const word of text.trim().split(/\s+/u)) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (measureText(candidate, fontSize) <= TEXT_MAX_WIDTH) {
      current = candidate;
      continue;
    }
    if (current !== "") {
      lines.push(current);
    }
    current = word;
    if (lines.length === HEADLINE_MAX_LINES) {
      return truncateLastLine(lines, fontSize);
    }
  }

  if (current !== "") {
    lines.push(current);
  }
  return lines.length <= HEADLINE_MAX_LINES
    ? lines
    : truncateLastLine(lines.slice(0, HEADLINE_MAX_LINES), fontSize);
};

const truncateLastLine = (lines: string[], fontSize: number): string[] => {
  let last = lines.at(-1) ?? "";
  while (
    last.length > 0 &&
    measureText(`${last}${ELLIPSIS}`, fontSize) > TEXT_MAX_WIDTH
  ) {
    last = last.slice(0, -1).trimEnd();
  }
  return [...lines.slice(0, -1), `${last}${ELLIPSIS}`];
};

/**
 * Advance-width estimate for Cabinet Grotesk, which resvg does not expose
 * before rendering. Deliberately generous: it ignores the negative tracking
 * the card applies, so a line that measures as fitting always does.
 */
const measureText = (text: string, fontSize: number): number => {
  let width = 0;
  for (const character of text) {
    width += fontSize * characterWidthRatio(character);
  }
  return width;
};

const characterWidthRatio = (character: string): number => {
  if (character === " ") {
    return 0.28;
  }
  // Arabic joins, so a run is far narrower than its character count suggests;
  // the marks above and below add no advance at all.
  if (/\p{Mn}/u.test(character)) {
    return 0;
  }
  if (/\p{Script=Arabic}/u.test(character)) {
    return 0.42;
  }
  if (/[,.:;|!]/u.test(character)) {
    return 0.22;
  }
  if (/[ijlI]/u.test(character)) {
    return 0.28;
  }
  if (/[mwMW]/u.test(character)) {
    return 0.78;
  }
  if (/\p{Lu}/u.test(character)) {
    return 0.62;
  }
  return 0.52;
};

let background: string | undefined;

/**
 * The hero gradient, pre-scaled to card size once. The source is a 3.4 MB
 * print-resolution PNG; re-decoding it per card dominated render time when
 * every page started getting one.
 */
const cardBackground = (): string => {
  background ??= new Resvg(
    String.raw`<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,${readFileSync(
      resolveLandingPath("public", "images", "gradient-hero.png"),
    ).toString(
      "base64",
    )}" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" preserveAspectRatio="xMidYMid slice" /></svg>`,
    { fitTo: { mode: "width", value: WIDTH } },
  )
    .render()
    .asPng()
    .toString("base64");
  return background;
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
