import { US_REPORTER_SPELLINGS } from "./us-reporter-editions.generated";

/**
 * A reporter citation as `volume reporter page`: the one reading of it that
 * ingestion writes identifiers with and that lookup and search resolve by.
 *
 * Identity is the volume, the canonical edition and the first page. A pin
 * (`, 495`, `, at 495`, a range, a footnote) says where to look inside the
 * decision, not which decision, so it is parsed but kept outside identity.
 * Spacing is typography: `U. S.` and `U.S.`, `L. Ed. 2d` and `L.Ed.2d` are one
 * spelling. Letter case is not, because the edition table distinguishes it.
 */

/** A decision's place in one reporter edition. */
export type UsReporterCitation = {
  readonly volume: string;
  /** The canonical edition spelling, e.g. `U.S.` or `L. Ed. 2d`. */
  readonly edition: string;
  readonly page: string;
};

/** Where inside the decision a reference points. */
export type UsReporterPin = {
  /** As written, after the separating comma or `at`. */
  readonly raw: string;
  readonly page: string | null;
  /** The last page of a range, with an abbreviated end written out. */
  readonly endPage: string | null;
  readonly footnote: string | null;
};

type NonEmpty<T> = readonly [T, ...T[]];

export type UsReporterReference =
  | {
      /** A full citation: volume, edition and first page. */
      readonly type: "full";
      /**
       * One citation per edition the reporter spelling can name; more than one
       * only where the edition table leaves the spelling ambiguous.
       */
      readonly candidates: NonEmpty<UsReporterCitation>;
      readonly pin: UsReporterPin | null;
      /** A parallel nominative volume printed inside the citation. */
      readonly nominative: string | null;
      /** A trailing `(court year)` parenthetical. */
      readonly parenthetical: string | null;
    }
  | {
      /** A short form (`347 U.S., at 495`): no first page, so no identity. */
      readonly type: "short";
      readonly volume: string;
      readonly editions: NonEmpty<string>;
      readonly pin: UsReporterPin;
    };

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\/-]/gu, (character) => `\\${character}`);

/**
 * Where a typesetter may put a space inside a spelling the table stores
 * without one: after punctuation, and between a letter and a digit or a
 * lower-case and an upper-case letter (`Cal.3d`, `3dSpec.TribSupp.`).
 */
const spaceMayFollow = (current: string, next: string): boolean =>
  /[.,'&)]/u.test(current) ||
  /[([]/u.test(next) ||
  (/\p{L}/u.test(current) && /\p{N}/u.test(next)) ||
  (/\p{N}/u.test(current) && /\p{L}/u.test(next)) ||
  (/\p{Ll}/u.test(current) && /\p{Lu}/u.test(next));

const flexibleSpellingSource = (spelling: string): string => {
  const characters = [...spelling];
  return characters
    .map((character, index) => {
      const next = characters[index + 1];
      const escaped = escapeRegExp(character);
      return next !== undefined && spaceMayFollow(character, next)
        ? `${escaped}\\s*`
        : escaped;
    })
    .join("");
};

// Longest first, so an edition is never read as a shorter one it begins with.
const REPORTER_SOURCE = Object.keys(US_REPORTER_SPELLINGS)
  .toSorted((left, right) => right.length - left.length)
  .map(flexibleSpellingSource)
  .join("|");

const DASH = "[-‐‑‒–—―−]";
const PAGE_RANGE_SOURCE = String.raw`\d{1,5}(?:\s*${DASH}\s*\d{1,5})?`;
const FOOTNOTE_SOURCE = String.raw`nn?\.\s*\d{1,4}(?:\s*${DASH}\s*\d{1,4})?`;
const PIN_SOURCE = String.raw`(?:${PAGE_RANGE_SOURCE}(?:\s*,?\s*(?:&\s*|and\s+)?${FOOTNOTE_SOURCE})?|${FOOTNOTE_SOURCE})`;

const VOLUME_SOURCE = String.raw`(?<volume>\d{1,4})`;
const REPORTER_GROUP_SOURCE = `(?<reporter>${REPORTER_SOURCE})`;

const FULL_RE = new RegExp(
  String.raw`^${VOLUME_SOURCE}\s+${REPORTER_GROUP_SOURCE}` +
    String.raw`(?:\s*\((?<nominative>\d{1,3}\s+(?:${REPORTER_SOURCE}))\))?` +
    String.raw`\s+(?<page>\d{1,5})` +
    String.raw`(?:\s*,\s*(?:at\s+)?(?<pin>${PIN_SOURCE}))?` +
    String.raw`(?:\s*\((?<parenthetical>[^()]{0,60}\d{4})\))?$`,
  "u",
);

const SHORT_RE = new RegExp(
  String.raw`^${VOLUME_SOURCE}\s+${REPORTER_GROUP_SOURCE}\s*,?\s+at\s+(?<pin>${PIN_SOURCE})$`,
  "u",
);

const PIN_PARTS_RE = new RegExp(
  String.raw`^(?:(?<page>\d+)(?:\s*${DASH}\s*(?<end>\d+))?)?` +
    String.raw`(?:\s*,?\s*(?:&\s*|and\s+)?nn?\.\s*(?<note>\d+(?:\s*${DASH}\s*\d+)?))?$`,
  "u",
);

const DASH_RE = new RegExp(`\\s*${DASH}\\s*`, "gu");

const withoutLeadingZeros = (digits: string): string =>
  digits.replace(/^0+(?=\d)/u, "");

/** `495-96` ends on 496: an abbreviated end borrows the start's leading digits. */
const expandedEndPage = (start: string, end: string): string =>
  end.length < start.length
    ? `${start.slice(0, start.length - end.length)}${end}`
    : end;

const pinOf = (raw: string): UsReporterPin => {
  const parts = PIN_PARTS_RE.exec(raw)?.groups;
  const page = parts?.["page"];
  const end = parts?.["end"];
  const note = parts?.["note"];
  return {
    raw,
    page: page === undefined ? null : withoutLeadingZeros(page),
    endPage:
      page === undefined || end === undefined
        ? null
        : expandedEndPage(withoutLeadingZeros(page), end),
    footnote: note === undefined ? null : note.replace(DASH_RE, "-"),
  };
};

const editionsOf = (spelling: string): NonEmpty<string> | null =>
  US_REPORTER_SPELLINGS[spelling.replace(/\s+/gu, "")] ?? null;

const foldInput = (raw: string): string =>
  raw.normalize("NFKC").replace(/\s+/gu, " ").trim();

/**
 * Reads a whole entry as one reporter citation, or null. The entry must be
 * the citation and nothing else, so `28 U.S.C. § 1253` is not `U.S.`, and a
 * reporter the table does not carry is not guessed at.
 */
export const parseUsReporterReference = (
  raw: string,
): UsReporterReference | null => {
  const text = foldInput(raw);
  const full = FULL_RE.exec(text)?.groups;
  const fullReporter = full?.["reporter"];
  const fullVolume = full?.["volume"];
  const fullPage = full?.["page"];
  if (
    full !== undefined &&
    fullReporter !== undefined &&
    fullVolume !== undefined &&
    fullPage !== undefined
  ) {
    const editions = editionsOf(fullReporter);
    if (editions === null) {
      return null;
    }
    const volume = withoutLeadingZeros(fullVolume);
    const page = withoutLeadingZeros(fullPage);
    const [first, ...rest] = editions;
    const pin = full["pin"];
    return {
      type: "full",
      candidates: [
        { volume, edition: first, page },
        ...rest.map((edition) => ({ volume, edition, page })),
      ],
      pin: pin === undefined ? null : pinOf(pin),
      nominative: full["nominative"] ?? null,
      parenthetical: full["parenthetical"] ?? null,
    };
  }

  const short = SHORT_RE.exec(text)?.groups;
  const shortReporter = short?.["reporter"];
  const shortVolume = short?.["volume"];
  const shortPin = short?.["pin"];
  if (
    shortReporter === undefined ||
    shortVolume === undefined ||
    shortPin === undefined
  ) {
    return null;
  }
  const editions = editionsOf(shortReporter);
  return editions === null
    ? null
    : {
        type: "short",
        volume: withoutLeadingZeros(shortVolume),
        editions,
        pin: pinOf(shortPin),
      };
};

export const formatUsReporterCitation = ({
  edition,
  page,
  volume,
}: UsReporterCitation): string => `${volume} ${edition} ${page}`;

/**
 * The identity a full citation names, in canonical spelling, or null when the
 * entry is not one, is only a short form, or names an ambiguous reporter.
 */
export const canonicalUsReporterCitation = (raw: string): string | null => {
  const reference = parseUsReporterReference(raw);
  if (reference?.type !== "full") {
    return null;
  }
  const [only, ...others] = reference.candidates;
  return others.length === 0 ? formatUsReporterCitation(only) : null;
};
