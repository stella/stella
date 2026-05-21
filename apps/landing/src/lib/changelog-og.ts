import { Resvg } from "@resvg/resvg-js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ChangelogRelease } from "./changelog";

const WIDTH = 1200;
const HEIGHT = 630;
const TEXT_X = 84;
const TEXT_MAX_WIDTH = 980;
const HEADING_MAX_LINES = 3;
const HEADING_PREFERRED_FONT_SIZE = 116;
const HEADING_MIN_FONT_SIZE = 76;

const fontPath = resolveLandingPath(
  "public",
  "fonts",
  "CabinetGrotesk-Regular.otf",
);
const logoSvg = readFileSync(
  resolveLandingPath("public", "images", "stella-logo.svg"),
  "utf-8",
);
const logoSvgBase64 = Buffer.from(logoSvg).toString("base64");
const gradientPngBase64 = readFileSync(
  resolveLandingPath("public", "images", "gradient-hero.png"),
).toString("base64");

export const renderChangelogOgImage = (release: ChangelogRelease) => {
  const versionLabel = release.tagName.startsWith("v")
    ? release.tagName.slice(1)
    : release.tagName;
  if (!release.heading) {
    return renderVersionOnlyOgImage(versionLabel);
  }

  const heading = fitLines(
    release.heading,
    HEADING_PREFERRED_FONT_SIZE,
    HEADING_MAX_LINES,
  );
  const headingLineHeight = Math.round(heading.fontSize * 0.9);
  const firstHeadingY =
    380 -
    Math.max(0, heading.lines.length - 1) * Math.round(headingLineHeight / 2);
  const headingMarkup = renderTextLines({
    className: "display",
    fontSize: heading.fontSize,
    lineHeight: headingLineHeight,
    lines: heading.lines,
    x: TEXT_X,
    y: firstHeadingY,
  });

  const sourceSvg = String.raw`<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      .display {
        font-family: "Cabinet Grotesk", sans-serif;
        fill: #111827;
        font-weight: 400;
      }

    </style>
  </defs>

  <image href="data:image/png;base64,${gradientPngBase64}" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" preserveAspectRatio="xMidYMid slice" />
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#F7FAFF" fill-opacity="0.04" />

  <image
    href="data:image/svg+xml;base64,${logoSvgBase64}"
    x="84"
    y="72"
    width="236"
    height="62"
    preserveAspectRatio="xMinYMin meet"
  />

  <text x="1116" y="122" text-anchor="end" class="display" font-size="58">${escapeXml(versionLabel)}</text>
  ${headingMarkup}
</svg>`;

  return new Resvg(sourceSvg, {
    fitTo: {
      mode: "width",
      value: WIDTH,
    },
    font: {
      fontFiles: [fontPath],
      loadSystemFonts: false,
    },
  })
    .render()
    .asPng();
};

const renderVersionOnlyOgImage = (versionLabel: string) => {
  const sourceSvg = String.raw`<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      .display {
        font-family: "Cabinet Grotesk", sans-serif;
        fill: #111827;
        font-weight: 400;
      }
    </style>
  </defs>

  <image href="data:image/png;base64,${gradientPngBase64}" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" preserveAspectRatio="xMidYMid slice" />
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#F7FAFF" fill-opacity="0.04" />

  <image
    href="data:image/svg+xml;base64,${logoSvgBase64}"
    x="84"
    y="72"
    width="236"
    height="62"
    preserveAspectRatio="xMinYMin meet"
  />

  <text x="${TEXT_X}" y="392" class="display" font-size="164">${escapeXml(versionLabel)}</text>
</svg>`;

  return new Resvg(sourceSvg, {
    fitTo: {
      mode: "width",
      value: WIDTH,
    },
    font: {
      fontFiles: [fontPath],
      loadSystemFonts: false,
    },
  })
    .render()
    .asPng();
};

type TextLinesInput = {
  className: string;
  fontSize: number;
  lineHeight: number;
  lines: string[];
  x: number;
  y: number;
};

const renderTextLines = ({
  className,
  fontSize,
  lineHeight,
  lines,
  x,
  y,
}: TextLinesInput) =>
  `<text x="${x}" y="${y}" class="${className}" font-size="${fontSize}">${lines
    .map((line, index) => {
      const dy = index === 0 ? 0 : lineHeight;
      return `<tspan x="${x}" dy="${dy}">${escapeXml(line)}</tspan>`;
    })
    .join("")}</text>`;

const fitLines = (
  text: string,
  preferredFontSize: number,
  maxLines: number,
) => {
  for (
    let fontSize = preferredFontSize;
    fontSize >= HEADING_MIN_FONT_SIZE;
    fontSize -= 8
  ) {
    const lines = wrapText(text, TEXT_MAX_WIDTH, fontSize, maxLines);
    const didFit = lines.length <= maxLines && !lastLineWasTruncated(lines);
    if (didFit || fontSize === HEADING_MIN_FONT_SIZE) {
      return { fontSize, lines };
    }
  }

  return {
    fontSize: HEADING_MIN_FONT_SIZE,
    lines: wrapText(text, TEXT_MAX_WIDTH, HEADING_MIN_FONT_SIZE, maxLines),
  };
};

const wrapText = (
  text: string,
  maxWidth: number,
  fontSize: number,
  maxLines: number,
) => {
  const words = text.trim().split(/\s+/u);
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (measureText(candidate, fontSize) <= maxWidth) {
      currentLine = candidate;
      continue;
    }

    if (currentLine) {
      lines.push(currentLine);
    }
    currentLine = word;

    if (lines.length === maxLines) {
      return truncateLastLine(lines, maxWidth, fontSize);
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  if (lines.length <= maxLines) {
    return lines;
  }

  return truncateLastLine(lines.slice(0, maxLines), maxWidth, fontSize);
};

const truncateLastLine = (
  lines: string[],
  maxWidth: number,
  fontSize: number,
) => {
  const truncatedLines = [...lines];
  let lastLine = truncatedLines.at(-1) ?? "";

  while (
    lastLine.length > 0 &&
    measureText(`${lastLine}...`, fontSize) > maxWidth
  ) {
    lastLine = lastLine.slice(0, -1).trimEnd();
  }

  truncatedLines[truncatedLines.length - 1] = `${lastLine}...`;
  return truncatedLines;
};

const lastLineWasTruncated = (lines: string[]) =>
  lines.at(-1)?.endsWith("...") ?? false;

const measureText = (text: string, fontSize: number) => {
  let width = 0;

  for (const character of text) {
    width += fontSize * characterWidthRatio(character);
  }

  return width;
};

const characterWidthRatio = (character: string) => {
  if (character === " ") {
    return 0.28;
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
  if (/[A-Z]/u.test(character)) {
    return 0.62;
  }
  return 0.52;
};

const escapeXml = (value: string) =>
  value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");

function resolveLandingPath(...segments: string[]) {
  const fromLanding = join(process.cwd(), ...segments);
  if (existsSync(fromLanding)) {
    return fromLanding;
  }

  return join(process.cwd(), "apps", "landing", ...segments);
}
