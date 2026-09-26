import type { DecisionReporterGrammar } from "./decision-query-intent";
import {
  US_REPORTER_EDITIONS,
  US_REPORTER_FOREIGN_FOLDED_SPELLINGS,
  US_REPORTER_SPELLINGS,
} from "./us-reporter-editions.generated";
import type { UsReporterSpellingCandidate } from "./us-reporter-editions.generated";

/**
 * A reporter citation as `volume reporter page`: the one reading of it that
 * ingestion writes identifiers with and that lookup and search resolve by.
 *
 * Identity is the volume, the reporter and the first page. A pin (`, 495`,
 * `, at 495`, `at 495`, a list, a range, a footnote) says where to look inside
 * the decision, not which decision, so it is parsed but kept outside identity.
 * Spacing is typography: `U. S.` and `U.S.`, `L. Ed. 2d` and `L.Ed.2d` are one
 * spelling. A spelling the table does not hold in the case it was typed in is
 * read case-folded, unless a reporter outside the table answers to it too.
 */

/**
 * The jurisdiction whose reporter citations these editions are. Reporter
 * grammar applies there only: elsewhere the same characters keep the reading
 * they always had.
 */
export const US_REPORTER_JURISDICTION = "USA";

export const readsUsReporterCitations = (
  jurisdiction: string | null | undefined,
): boolean => jurisdiction === US_REPORTER_JURISDICTION;

/** A decision's place in one reporter edition. */
export type UsReporterCitation = {
  readonly volume: string;
  /** The canonical edition spelling, e.g. `U.S.` or `L. Ed. 2d`. */
  readonly edition: string;
  readonly page: string;
  /** The reporter publishing under that edition, null when outside the table. */
  readonly reporter: string | null;
};

/** Where inside the decision a reference points. */
export type UsReporterPin = {
  /** As written. */
  readonly raw: string;
  readonly page: string | null;
  /**
   * The last page of an ascending range, with an abbreviated end written out;
   * null for a range that does not ascend, whose raw text is all it says.
   */
  readonly endPage: string | null;
  readonly footnote: string | null;
};

type NonEmpty<T> = readonly [T, ...T[]];

export type UsReporterReference =
  | {
      /** A full citation: volume, edition and first page. */
      readonly type: "full";
      /**
       * One citation per reporter record the spelling can name; more than one
       * only where the edition table leaves the spelling ambiguous.
       */
      readonly candidates: NonEmpty<UsReporterCitation>;
      readonly pins: readonly UsReporterPin[];
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
      readonly pins: NonEmpty<UsReporterPin>;
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
/** A bounded list of pins: `495`, `495, 497`, `495-96, 498 n. 3`. */
const PIN_LIST_SOURCE = String.raw`${PIN_SOURCE}(?:\s*,\s*${PIN_SOURCE}){0,9}`;

const VOLUME_SOURCE = String.raw`(?<volume>\d{1,4})`;
const REPORTER_GROUP_SOURCE = `(?<reporter>${REPORTER_SOURCE})`;

const FULL_RE = new RegExp(
  String.raw`^${VOLUME_SOURCE}\s+${REPORTER_GROUP_SOURCE}` +
    String.raw`(?:\s*\((?<nominative>\d{1,3}\s+(?:${REPORTER_SOURCE}))\))?` +
    String.raw`\s+(?<page>\d{1,5})` +
    String.raw`(?:(?:\s*,\s*(?:at\s+)?|\s+at\s+)(?<pins>${PIN_LIST_SOURCE}))?` +
    String.raw`(?:\s*\((?<parenthetical>[^()]{0,60}\d{4})\))?$`,
  "iu",
);

const SHORT_RE = new RegExp(
  String.raw`^${VOLUME_SOURCE}\s+${REPORTER_GROUP_SOURCE}\s*,?\s+at\s+(?<pins>${PIN_LIST_SOURCE})$`,
  "iu",
);

const PIN_RE = new RegExp(PIN_SOURCE, "giu");

const PIN_PARTS_RE = new RegExp(
  String.raw`^(?:(?<page>\d+)(?:\s*${DASH}\s*(?<end>\d+))?)?` +
    String.raw`(?:\s*,?\s*(?:&\s*|and\s+)?nn?\.\s*(?<note>\d+(?:\s*${DASH}\s*\d+)?))?$`,
  "iu",
);

const DASH_RE = new RegExp(`\\s*${DASH}\\s*`, "gu");

const withoutLeadingZeros = (digits: string): string =>
  digits.replace(/^0+(?=\d)/u, "");

/**
 * `495-96` ends on 496: an abbreviated end borrows the start's leading digits.
 * A range that does not then ascend (`199-02`) has no end this can vouch for.
 */
const ascendingEndPage = (start: string, end: string): string | null => {
  const expanded =
    end.length < start.length
      ? `${start.slice(0, start.length - end.length)}${end}`
      : withoutLeadingZeros(end);
  return Number(expanded) >= Number(start) ? expanded : null;
};

const pinOf = (raw: string): UsReporterPin => {
  const parts = PIN_PARTS_RE.exec(raw)?.groups;
  const page = parts?.["page"];
  const end = parts?.["end"];
  const note = parts?.["note"];
  const start = page === undefined ? null : withoutLeadingZeros(page);
  return {
    raw,
    page: start,
    endPage:
      start === null || end === undefined ? null : ascendingEndPage(start, end),
    footnote: note === undefined ? null : note.replace(DASH_RE, "-"),
  };
};

const pinsOf = (list: string | undefined): UsReporterPin[] =>
  list === undefined
    ? []
    : [...list.matchAll(PIN_RE)].map(([raw]) => pinOf(raw));

type Candidates = NonEmpty<UsReporterSpellingCandidate>;

const spellingKey = (spelling: string): string => spelling.replace(/\s+/gu, "");

/** Must match the generator's folding, which wrote the foreign list. */
const foldedKey = (key: string): string => key.toLocaleLowerCase("und");

const FOREIGN_FOLDS = new Set(US_REPORTER_FOREIGN_FOLDED_SPELLINGS);

/**
 * Case-folded spelling to every record any spelling in that fold names.
 * Collisions merge, so a folded spelling two reporters answer to stays
 * ambiguous rather than picking one.
 */
const FOLDED_SPELLINGS: ReadonlyMap<string, Candidates> = (() => {
  const folded = new Map<string, Map<string, UsReporterSpellingCandidate>>();
  for (const [key, candidates] of Object.entries(US_REPORTER_SPELLINGS)) {
    const fold = foldedKey(key);
    if (FOREIGN_FOLDS.has(fold)) {
      continue;
    }
    const merged = folded.get(fold) ?? new Map();
    for (const candidate of candidates) {
      merged.set(`${candidate[0]}\u0000${String(candidate[1])}`, candidate);
    }
    folded.set(fold, merged);
  }
  return new Map(
    [...folded].flatMap(([fold, merged]): [string, Candidates][] => {
      const [first, ...rest] = merged.values();
      return first === undefined ? [] : [[fold, [first, ...rest]]];
    }),
  );
})();

const candidatesOf = (spelling: string): Candidates | null => {
  const key = spellingKey(spelling);
  return (
    US_REPORTER_SPELLINGS[key] ?? FOLDED_SPELLINGS.get(foldedKey(key)) ?? null
  );
};

const citationOf =
  (volume: string, page: string) =>
  ([edition, record]: UsReporterSpellingCandidate): UsReporterCitation => ({
    volume,
    edition,
    page,
    reporter:
      record === null
        ? null
        : (US_REPORTER_EDITIONS[edition]?.[record]?.name ?? null),
  });

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
    const candidates = candidatesOf(fullReporter);
    if (candidates === null) {
      return null;
    }
    const toCitation = citationOf(
      withoutLeadingZeros(fullVolume),
      withoutLeadingZeros(fullPage),
    );
    const [first, ...rest] = candidates;
    return {
      type: "full",
      candidates: [toCitation(first), ...rest.map(toCitation)],
      pins: pinsOf(full["pins"]),
      nominative: full["nominative"] ?? null,
      parenthetical: full["parenthetical"] ?? null,
    };
  }

  const short = SHORT_RE.exec(text)?.groups;
  const shortReporter = short?.["reporter"];
  const shortVolume = short?.["volume"];
  const [firstPin, ...otherPins] = pinsOf(short?.["pins"]);
  const candidates =
    shortReporter === undefined ? null : candidatesOf(shortReporter);
  if (
    shortVolume === undefined ||
    firstPin === undefined ||
    candidates === null
  ) {
    return null;
  }
  const [firstEdition, ...otherEditions] = [
    ...new Set(candidates.map(([edition]) => edition)),
  ];
  return firstEdition === undefined
    ? null
    : {
        type: "short",
        volume: withoutLeadingZeros(shortVolume),
        editions: [firstEdition, ...otherEditions],
        pins: [firstPin, ...otherPins],
      };
};

export const formatUsReporterCitation = ({
  edition,
  page,
  volume,
}: Pick<UsReporterCitation, "edition" | "page" | "volume">): string =>
  `${volume} ${edition} ${page}`;

/**
 * The identity a full citation names, in canonical spelling, or null when the
 * entry is not one, is only a short form, or does not settle on one reporter:
 * a spelling several records answer to, or an edition spelling more than one
 * reporter publishes under, which the canonical spelling could not tell apart.
 */
export const canonicalUsReporterCitation = (raw: string): string | null => {
  const reference = parseUsReporterReference(raw);
  if (reference?.type !== "full") {
    return null;
  }
  const [only, ...others] = reference.candidates;
  const publishers = US_REPORTER_EDITIONS[only.edition]?.length ?? 0;
  return others.length === 0 && only.reporter !== null && publishers === 1
    ? formatUsReporterCitation(only)
    : null;
};

const US_REPORTER_GRAMMAR: DecisionReporterGrammar = {
  canonicalCitation: canonicalUsReporterCitation,
};

/**
 * The reporter grammar a query entry is read with in `jurisdiction`, or null
 * where reporter citations are not read.
 */
export const decisionReporterGrammarForJurisdiction = (
  jurisdiction: string | null | undefined,
): DecisionReporterGrammar | null =>
  readsUsReporterCitations(jurisdiction) ? US_REPORTER_GRAMMAR : null;
