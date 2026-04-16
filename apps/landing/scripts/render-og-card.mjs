import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const LANDING_DIR = join(SCRIPT_DIR, "..");
const PUBLIC_DIR = join(LANDING_DIR, "public");
const IMAGE_DIR = join(PUBLIC_DIR, "images");
const FONT_DIR = join(PUBLIC_DIR, "fonts");

const WIDTH = 1200;
const HEIGHT = 630;

const cabinetFontPath = join(FONT_DIR, "CabinetGrotesk-Regular.otf");
const logoSvg = readFileSync(join(IMAGE_DIR, "stella-logo.svg"), "utf8");
const logoSvgBase64 = Buffer.from(logoSvg).toString("base64");
const gradientPng = readFileSync(join(IMAGE_DIR, "gradient-hero.png")).toString(
  "base64",
);

const sourceSvg = String.raw`<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" fill="none" xmlns="http://www.w3.org/2000/svg">
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
    x="84"
    y="72"
    width="236"
    height="62"
    preserveAspectRatio="xMinYMin meet"
  />

  <text x="84" y="368" class="display" font-size="92">Legal workspace.</text>
  <text x="84" y="450" class="display" font-size="92">Open source.</text>
</svg>`;

const svgPath = join(IMAGE_DIR, "og-card.svg");
const pngPath = join(IMAGE_DIR, "og-card.png");

const png = new Resvg(sourceSvg, {
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

writeFileSync(pngPath, png);

const pngBase64 = png.toString("base64");
const svg = `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" fill="none" xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,${pngBase64}" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" /></svg>`;

writeFileSync(svgPath, svg);

console.log(`Rendered ${svgPath}`);
console.log(`Rendered ${pngPath}`);
