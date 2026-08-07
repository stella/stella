// Where a page's Open Graph card lives, and whether its title can be drawn on
// one. Split from og-card.ts (the renderer) so Base.astro can resolve the URL
// without pulling the native rendering stack into every page's module graph.
import { panic } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Site-wide card, used where a page's own title cannot be drawn in its
 * direction's face: a locale in a third script would fall back here rather
 * than ship a card of .notdef boxes.
 */
export const OG_CARD_FALLBACK = "/images/og-card.png";

/** Directory the build-time generator owns; nothing else may write into it. */
export const OG_CARD_DIR = "/images/og";

const BRAND = "stella";

/**
 * The card's headline: the page's <title> minus the brand wrapper it carries
 * for search results ("stella | security", "Editing DOCX | stella"). The card
 * already shows the wordmark, so repeating it would spend the largest type on
 * the page on a word the reader can see above it.
 */
export const ogCardHeadline = (title: string): string => {
  const topic = title
    .replace(new RegExp(String.raw`^\s*${BRAND}\s*\|\s*`, "iu"), "")
    .replace(new RegExp(String.raw`\s*\|\s*${BRAND}\s*$`, "iu"), "")
    // Typographic spaces collapse to a plain one: French sets a narrow no-break
    // space before its colons, which the display face has no glyph for, and a
    // card cannot carry the line-breaking guarantee the character exists for
    // anyway — its text is wrapped here, not by a layout engine.
    .replaceAll(/\s+/gu, " ")
    .trim();
  return topic.replace(/^./u, (first) => first.toUpperCase());
};

type OgCardPathOptions = {
  pathname: string;
  title: string;
  direction: CardDirection;
};

/**
 * A page's card URL, derived from the URL it is served at. The card itself is
 * written by the og-cards integration after the build renders the page, from
 * that page's own <title>; deriving the path here and the pixels there keeps
 * the two from stating the headline separately.
 */
export const ogCardPath = ({
  pathname,
  title,
  direction,
}: OgCardPathOptions): string =>
  isDrawableHeadline(ogCardHeadline(title), direction)
    ? `${OG_CARD_DIR}/${ogCardSlug(pathname)}.png`
    : OG_CARD_FALLBACK;

/** Whether a card URL is one this build generates rather than a static asset. */
export const isGeneratedOgCard = (pathname: string): boolean =>
  pathname.startsWith(`${OG_CARD_DIR}/`);

/**
 * Flattens a URL path to one filename: "/cs/product/agent/" -> "cs-product-agent".
 * Two paths could in principle flatten onto one slug; the generator fails the
 * build on a collision rather than letting one page's card overwrite another's.
 */
export const ogCardSlug = (pathname: string): string => {
  const flattened = pathname
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
  return flattened === "" ? "index" : flattened;
};

/** Whether every character in the headline has a glyph in that card's face. */
export const isDrawableHeadline = (
  headline: string,
  direction: CardDirection,
): boolean => {
  const coverage = faceCoverage(direction);
  for (const character of headline) {
    if (!coverage.has(character)) {
      return false;
    }
  }
  return true;
};

export type CardDirection = "ltr" | "rtl";

/**
 * One face per writing direction, each covering its card's whole headline.
 *
 * resvg resolves a single font per <text> element and draws .notdef for
 * anything that font lacks — it has no per-glyph fallback, and it renders
 * nothing at all when tspans within one element disagree on family. So a
 * card cannot pair a Latin face with an Arabic one: an Arabic title carrying
 * a Latin product name ("تحرير مستندات Word") has to come from a single face
 * that covers both, which is why the Arabic card is set in IBM Plex Sans
 * Arabic rather than the Noto Sans Arabic the app's UI uses.
 */
export const CARD_FACES = {
  ltr: {
    family: "Cabinet Grotesk",
    path: resolveLandingPath("public", "fonts", "CabinetGrotesk-Regular.otf"),
  },
  rtl: {
    family: "IBM Plex Sans Arabic",
    path: resolveLandingPath(
      "public",
      "fonts",
      "IBMPlexSansArabic-Regular.ttf",
    ),
  },
} as const satisfies Record<CardDirection, { family: string; path: string }>;

const coverages = new Map<CardDirection, ReadonlySet<string>>();

/** Lazy: a face is only parsed once a page actually asks for its card. */
const faceCoverage = (direction: CardDirection): ReadonlySet<string> => {
  const cached = coverages.get(direction);
  if (cached !== undefined) {
    return cached;
  }
  const { path: font } = CARD_FACES[direction];
  const covered = readCoverage(font, readFileSync(font));
  coverages.set(direction, covered);
  return covered;
};

/**
 * The characters a face maps to a glyph, read from its `cmap` format 4
 * subtables. resvg silently substitutes .notdef for anything missing, so an
 * unrenderable headline is only detectable before rendering.
 *
 * Format 12 subtables are skipped: they only add code points above the BMP,
 * which no page title uses, and under-reporting coverage is the safe
 * direction — it falls back to the static card rather than drawing boxes.
 */
const readCoverage = (name: string, font: Buffer): ReadonlySet<string> => {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const cmap = tableOffset(name, view, font, "cmap");
  const subtableCount = view.getUint16(cmap + 2);
  const covered = new Set<string>();

  for (let index = 0; index < subtableCount; index += 1) {
    const record = cmap + 4 + index * 8;
    const subtable = cmap + view.getUint32(record + 4);
    if (view.getUint16(subtable) === FORMAT_SEGMENT_MAPPING) {
      addSegmentMapping(view, subtable, covered);
    }
  }

  if (covered.size === 0) {
    panic(
      `${name}: no cmap format ${FORMAT_SEGMENT_MAPPING} subtable; card headlines cannot be coverage-checked`,
    );
  }
  return covered;
};

/** cmap "segment mapping to delta values", the only format the card font uses. */
const FORMAT_SEGMENT_MAPPING = 4;

/** Sentinel segment every format 4 subtable ends with; maps nothing. */
const SEGMENT_TERMINATOR = 0xff_ff;

const addSegmentMapping = (
  view: DataView,
  subtable: number,
  covered: Set<string>,
): void => {
  const segmentCount = view.getUint16(subtable + 6) / 2;
  const endCodes = subtable + 14;
  const startCodes = endCodes + segmentCount * 2 + 2;
  const idDeltas = startCodes + segmentCount * 2;
  const idRangeOffsets = idDeltas + segmentCount * 2;

  for (let segment = 0; segment < segmentCount; segment += 1) {
    const start = view.getUint16(startCodes + segment * 2);
    const end = view.getUint16(endCodes + segment * 2);
    if (start === SEGMENT_TERMINATOR) {
      continue;
    }
    const delta = view.getInt16(idDeltas + segment * 2);
    const rangeOffsetAt = idRangeOffsets + segment * 2;
    const rangeOffset = view.getUint16(rangeOffsetAt);

    for (let code = start; code <= end; code += 1) {
      const glyph =
        rangeOffset === 0
          ? (code + delta) % 0x1_00_00
          : view.getUint16(rangeOffsetAt + rangeOffset + (code - start) * 2);
      if (glyph !== 0) {
        covered.add(String.fromCodePoint(code));
      }
    }
  }
};

const tableOffset = (
  name: string,
  view: DataView,
  font: Buffer,
  tag: string,
): number => {
  const tableCount = view.getUint16(4);
  for (let index = 0; index < tableCount; index += 1) {
    const record = 12 + index * 16;
    if (font.subarray(record, record + 4).toString("latin1") === tag) {
      return view.getUint32(record + 8);
    }
  }
  return panic(`${name}: missing '${tag}' table`);
};

/** Assets resolve against the landing root whether the build runs there or at the repo root. */
export function resolveLandingPath(...segments: string[]): string {
  const fromLanding = path.join(process.cwd(), ...segments);
  if (existsSync(fromLanding)) {
    return fromLanding;
  }
  return path.join(process.cwd(), "apps", "landing", ...segments);
}
