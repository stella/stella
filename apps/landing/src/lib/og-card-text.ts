// Fits a card headline into the box the layout leaves for it. Split from
// og-card.ts so the fitting can be tested against every catalogue title
// without loading the native rendering stack.

/** Horizontal room for the headline, inside the card's margins. */
export const TEXT_MAX_WIDTH = 1000;

const HEADLINE_MAX_LINES = 3;
const HEADLINE_MAX_FONT_SIZE = 104;
const HEADLINE_MIN_FONT_SIZE = 60;
const HEADLINE_FONT_STEP = 8;
const ELLIPSIS = "…";

export type FittedHeadline = { fontSize: number; lines: string[] };

/**
 * The largest size at which the headline fits the box whole, or the smallest
 * size cut to fit if it never does. Every returned line is within
 * TEXT_MAX_WIDTH: the card has no overflow to clip against, so a line that
 * does not fit runs off the image.
 */
export const fitHeadline = (headline: string): FittedHeadline => {
  for (
    let fontSize = HEADLINE_MAX_FONT_SIZE;
    fontSize > HEADLINE_MIN_FONT_SIZE;
    fontSize -= HEADLINE_FONT_STEP
  ) {
    const lines = wrapText(headline, fontSize);
    if (fitsBox(lines, fontSize)) {
      return { fontSize, lines };
    }
  }
  return {
    fontSize: HEADLINE_MIN_FONT_SIZE,
    lines: clampToBox(
      wrapText(headline, HEADLINE_MIN_FONT_SIZE),
      HEADLINE_MIN_FONT_SIZE,
    ),
  };
};

/**
 * Measured rather than inferred from a trailing ellipsis: a single word wider
 * than the box gets a line to itself with nothing to truncate, so "no ellipsis"
 * does not mean "fits" — that read accepted an overrunning line at the largest
 * size. A headline that genuinely ends in an ellipsis fooled it the other way.
 */
const fitsBox = (lines: string[], fontSize: number): boolean =>
  lines.length <= HEADLINE_MAX_LINES &&
  lines.every((line) => measureText(line, fontSize) <= TEXT_MAX_WIDTH);

/** Greedy wrap. Over-wide words get their own line; the caller judges the fit. */
const wrapText = (text: string, fontSize: number): string[] => {
  const lines: string[] = [];
  let current = "";

  for (const word of text.trim().split(/\s+/u)) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (current !== "" && measureText(candidate, fontSize) > TEXT_MAX_WIDTH) {
      lines.push(current);
      current = word;
      continue;
    }
    current = candidate;
  }

  if (current !== "") {
    lines.push(current);
  }
  return lines;
};

/** Last resort at the smallest size: cut to the box rather than overrun it. */
const clampToBox = (lines: string[], fontSize: number): string[] => {
  const kept = lines
    .slice(0, HEADLINE_MAX_LINES)
    .map((line) => truncateToWidth(line, fontSize));
  const last = kept.at(-1);
  if (lines.length <= HEADLINE_MAX_LINES || last === undefined) {
    return kept;
  }
  // Lines were dropped, so the last kept one has to show that it is not the
  // end — unless truncating it for width already did. One marker covers both;
  // appending regardless can leave "……", since the cut can leave enough slack
  // for a second one to fit rather than be trimmed back off.
  if (last.endsWith(ELLIPSIS)) {
    return kept;
  }
  return [
    ...kept.slice(0, -1),
    truncateToWidth(`${last}${ELLIPSIS}`, fontSize),
  ];
};

const truncateToWidth = (line: string, fontSize: number): string => {
  if (measureText(line, fontSize) <= TEXT_MAX_WIDTH) {
    return line;
  }
  let cut = line;
  while (
    cut.length > 0 &&
    measureText(`${cut}${ELLIPSIS}`, fontSize) > TEXT_MAX_WIDTH
  ) {
    cut = cut.slice(0, -1).trimEnd();
  }
  return `${cut}${ELLIPSIS}`;
};

/**
 * Advance-width estimate for the card faces, which resvg does not expose
 * before rendering. Deliberately generous: it ignores the negative tracking
 * the card applies, so a line that measures as fitting always does.
 */
export const measureText = (text: string, fontSize: number): number => {
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
