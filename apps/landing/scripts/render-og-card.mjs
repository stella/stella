// Renders the committed Open Graph cards:
//
//   public/images/og-card.png (+ .svg wrapper)  — site-wide card
//   public/images/og/<slug>.png                 — one card per product page
//
// Manual tool with committed output; regenerate after changing a product's
// metaTitle, the gradient, the logo, or the layout:
//
//   bun run render:og-card    (from apps/landing)
//
// Runs under bun (not node) so it can import the product registry TypeScript
// directly; product card headlines are the topic part of each product's
// metaTitle, so card text cannot drift from the page's <title>.
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { products } from "../src/data/products/registry";

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const LANDING_DIR = path.join(SCRIPT_DIR, "..");
const PUBLIC_DIR = path.join(LANDING_DIR, "public");
const IMAGE_DIR = path.join(PUBLIC_DIR, "images");
const OG_DIR = path.join(IMAGE_DIR, "og");
const FONT_DIR = path.join(PUBLIC_DIR, "fonts");

const WIDTH = 1200;
const HEIGHT = 630;
const MARGIN_X = 84;
const BASELINE_BOTTOM = 450;

const cabinetFontPath = path.join(FONT_DIR, "CabinetGrotesk-Regular.otf");
const logoSvg = readFileSync(path.join(IMAGE_DIR, "stella-logo.svg"), "utf-8");
const logoSvgBase64 = Buffer.from(logoSvg).toString("base64");
const gradientPng = readFileSync(
  path.join(IMAGE_DIR, "gradient-hero.png"),
).toString("base64");

const escapeXml = (text) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// Greedy word wrap; Cabinet Grotesk at the card sizes fits ~24 characters on
// a text line inside the horizontal margins.
const wrapLines = (text, maxChars) => {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (candidate.length > maxChars && line !== "") {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line !== "") {
    lines.push(line);
  }
  return lines;
};

const cardSvg = ({ lines, fontSize, lineHeight }) => {
  const firstY = BASELINE_BOTTOM - (lines.length - 1) * lineHeight;
  const textElements = lines
    .map(
      (line, index) =>
        `<text x="${MARGIN_X}" y="${firstY + index * lineHeight}" class="display" font-size="${fontSize}">${escapeXml(line)}</text>`,
    )
    .join("\n  ");
  return String.raw`<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      .display {
        font-family: "Cabinet Grotesk", sans-serif;
        letter-spacing: -0.04em;
        fill: #111827;
        font-weight: 400;
      }
    </style>
  </defs>

  <image href="data:image/png;base64,${gradientPng}" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" preserveAspectRatio="xMidYMid slice" />
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#F7FAFF" fill-opacity="0.04" />

  <image
    href="data:image/svg+xml;base64,${logoSvgBase64}"
    x="${MARGIN_X}"
    y="72"
    width="236"
    height="62"
    preserveAspectRatio="xMinYMin meet"
  />

  ${textElements}
</svg>`;
};

const renderPng = (sourceSvg) =>
  new Resvg(sourceSvg, {
    fitTo: {
      mode: "width",
      value: WIDTH,
    },
    font: {
      fontFiles: [cabinetFontPath],
      loadSystemFonts: false,
    },
  })
    .render()
    .asPng();

// ——— Site-wide card (PNG plus the PNG-embedding SVG wrapper) ———
const sitePng = renderPng(
  cardSvg({
    lines: ["Legal workspace.", "Open source."],
    fontSize: 92,
    lineHeight: 82,
  }),
);
const svgPath = path.join(IMAGE_DIR, "og-card.svg");
const pngPath = path.join(IMAGE_DIR, "og-card.png");
writeFileSync(pngPath, sitePng);
const sitePngBase64 = sitePng.toString("base64");
writeFileSync(
  svgPath,
  `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" fill="none" xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,${sitePngBase64}" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" /></svg>`,
);
console.log(`Rendered ${svgPath}`);
console.log(`Rendered ${pngPath}`);

// ——— Per-product cards ———
mkdirSync(OG_DIR, { recursive: true });
for (const product of products) {
  const headline = product.metaTitle.replace(/\s*\|\s*stella\s*$/u, "");
  const productPngPath = path.join(OG_DIR, `${product.slug}.png`);
  writeFileSync(
    productPngPath,
    renderPng(
      cardSvg({
        lines: wrapLines(headline, 24),
        fontSize: 84,
        lineHeight: 76,
      }),
    ),
  );
  console.log(`Rendered ${productPngPath}`);
}
