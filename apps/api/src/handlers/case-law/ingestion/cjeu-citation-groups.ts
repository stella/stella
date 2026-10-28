/**
 * How the Court of Justice and every court citing it name several of its
 * cases in one reference, read in all of the Union's languages.
 *
 * The Court cites a judgment by the case numbers it decided, joined or as a
 * range, followed by the judgment's ECLI: "C‑570/07 a C‑571/07,
 * EU:C:2010:300", "C‑159/12 to C‑161/12, EU:C:2013:791". Three things follow
 * from that shape, and the citation patterns, which read one number at a
 * time, see none of them:
 *
 * - A range names every case between its ends. "C‑159/12 až C‑161/12" cites
 *   C‑160/12 as much as the two numbers printed.
 * - Joined numbers are one reference to one decision, not several.
 * - The ECLI printed after them names that decision exactly, where a case
 *   number names a whole file: the judgment, the Advocate General's opinion
 *   and every order in it share the number. The ECLI decides which document
 *   the numbers beside it mean.
 *
 * This module reads those groups and nothing else; `extractCitations` turns
 * them into references. Pure: the same text and language always give the
 * same groups.
 */

import { DECISION_DASH_CLASS_SOURCE } from "@stll/api-contract/decision-docket-grammar";

/** The most cases one printed range may name before it is refused. */
export const CJEU_RANGE_MAX_CASES = 50;

/**
 * Why a printed range was not read as the cases between its ends. Its two
 * ends stay references either way; only the cases in between are withheld.
 */
export const CJEU_RANGE_REFUSALS = {
  /** "C‑1/12 to T‑5/12": the ends belong to two courts' registries. */
  crossesCourt: "range-crosses-court",
  /** "C‑1/12 to C‑5/13": numbering restarts every year. */
  crossesYear: "range-crosses-year",
  /** "C‑5/12 to C‑1/12": no ascending run of numbers. */
  notAscending: "range-not-ascending",
  /** More cases than `CJEU_RANGE_MAX_CASES`: a misprint, not joined cases. */
  exceedsSpan: "range-exceeds-span",
} as const;

type CjeuRangeRefusalReason =
  (typeof CJEU_RANGE_REFUSALS)[keyof typeof CJEU_RANGE_REFUSALS];

type CjeuRangeRefusal = {
  reason: CjeuRangeRefusalReason;
  /** The range as printed, from its first end to its last. */
  printed: string;
  start: number;
  end: number;
};

/** Where in the text a group member's own characters stand. */
type PrintedSpan = { text: string; start: number; end: number };

type CjeuGroupMember = {
  /** The case number as a citation of it is written: `C‑160/12`, `60/81`. */
  caseNumber: string;
  /**
   * The member's own characters, or, for a case only a range names, the
   * range that names it.
   */
  span: PrintedSpan;
  /** Printed itself, or named only as a case between a range's two ends. */
  role: "printed" | "range-interior";
};

type CjeuCitationGroup = {
  members: readonly CjeuGroupMember[];
  /** The ECLI printed after the numbers, which names the cited decision. */
  ecli: PrintedSpan | null;
};

type CjeuCitationGroupReading = {
  groups: readonly CjeuCitationGroup[];
  refusals: readonly CjeuRangeRefusal[];
};

const DASH_CLASS = `${DECISION_DASH_CLASS_SOURCE}­`;

/**
 * One case number: an optional registry letter with its dash, the number
 * and the year. It never starts inside a longer token, and never at the
 * digits after a lettered prefix ("T‑381/15" is not also "381/15"); a dash
 * after a digit is a range's ("C‑159/12–C‑161/12"). The procedure suffixes the Court appends ("P", "PPU",
 * "RENV") are read past, not kept; the citation patterns key the number
 * without them.
 */
const CASE_NUMBER_RE = new RegExp(
  String.raw`(?<![\p{L}\d/.])(?<!\p{L}\s{0,3}[${DASH_CLASS}]\s{0,3})(?:(?<letter>[CTF])\s{0,3}(?<dash>[${DASH_CLASS}])\s{0,3})?(?<ordinal>\d{1,4})\/(?<year>\d{2}(?:\d{2})?)(?![\d/])(?:\s{1,2}(?:PPU|P|RENV|REV|DEP|REC|INT|OP|AJ|TO)(?![\p{L}\d]))?`,
  "gu",
);

/**
 * Words that join two case numbers of one reference, in every official
 * language of the Union. "a" is also a range word in Spanish, Italian and
 * Portuguese; it joins here unless the text's language says otherwise.
 */
const JOINERS = [
  "a", // cs, sk
  "agus", // ga
  "and", // en
  "e", // it, pt
  "ed", // it
  "en", // nl
  "et", // fr
  "i", // hr, pl
  "in", // sl
  "ir", // lt
  "ja", // et, fi
  "og", // da
  "och", // sv
  "u", // mt
  "un", // lv
  "und", // de
  "y", // es
  "és", // hu
  "și", // ro
  "şi", // ro, cedilla spelling
  "και", // el
  "и", // bg
] as const;

/** Words that name every case from one number to the other. */
const RANGE_WORDS = [
  "až", // cs, sk
  "bis", // de
  "do", // hr, pl, sl
  "go", // ga
  "iki", // lt
  "kuni", // et
  "la", // ro
  "līdz", // lv
  "sa", // mt
  "til", // da
  "till", // sv
  "to", // en
  "tot en met", // nl
  "tot", // nl
  "à", // fr
  "έως", // el
  "до", // bg
] as const;

/** Languages whose texts write a range with "a" ("C‑159/12 a C‑161/12"). */
const A_RANGE_LANGUAGES: ReadonlySet<string> = new Set(["es", "it", "pt"]);

const wordAlternation = (words: readonly string[]): string =>
  words
    .toSorted((left, right) => right.length - left.length)
    .map((word) => word.replaceAll(" ", () => String.raw`\s+`))
    .join("|");

const separatorRes = (
  language: string | undefined,
): { join: RegExp; range: RegExp } => {
  const aIsRange =
    language !== undefined && A_RANGE_LANGUAGES.has(language.toLowerCase());
  const joiners = aIsRange
    ? JOINERS.filter((word) => word !== "a")
    : [...JOINERS];
  const ranges: string[] = aIsRange ? [...RANGE_WORDS, "a"] : [...RANGE_WORDS];
  return {
    // A comma, a joining word, or both ("C‑1/12, C‑2/12 and C‑3/12").
    join: new RegExp(
      String.raw`^(?:\s*,\s*|\s*,?\s+(?:${wordAlternation(joiners)})\s+)$`,
      "iu",
    ),
    // A range word, or an en or em dash ("C‑159/12–C‑161/12").
    range: new RegExp(
      String.raw`^(?:\s*[–—]\s*|\s+(?:${wordAlternation(ranges)})\s+)$`,
      "iu",
    ),
  };
};

/** The ECLI the Court prints after a reference's numbers. */
const ECLI_TAIL_RE =
  /^\s*,\s*(?<ecli>(?:ECLI:)?EU:[CTF]:\d{4}:\d+)(?![\p{L}\d])/u;

/** How far apart two numbers of one reference may be printed. */
const SEPARATOR_MAX_LENGTH = 24;

type CaseNumberToken = PrintedSpan & {
  letter: string | null;
  dash: string;
  ordinal: number;
  /** The number's digits as printed. */
  digits: string;
  year: string;
};

const caseNumberTokens = (text: string): CaseNumberToken[] =>
  [...text.matchAll(CASE_NUMBER_RE)].map((match) => {
    const letter = match.groups?.["letter"] ?? null;
    const dash = match.groups?.["dash"] ?? "-";
    const digits = match.groups?.["ordinal"] ?? "";
    const year = match.groups?.["year"] ?? "";
    return {
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
      letter,
      dash,
      ordinal: Number(digits),
      digits,
      year,
    };
  });

/**
 * A case number as a citation of it is written. A printed one keeps its own
 * digits, so it keys exactly as the citation patterns keyed it.
 */
const caseNumberOf = (
  { letter, dash, year }: Pick<CaseNumberToken, "letter" | "dash" | "year">,
  digits: string,
): string =>
  letter === null ? `${digits}/${year}` : `${letter}${dash}${digits}/${year}`;

type Link = "join" | "range";

type Chain = { tokens: CaseNumberToken[]; links: Link[] };

const chainsOf = (
  text: string,
  tokens: readonly CaseNumberToken[],
  separators: { join: RegExp; range: RegExp },
): Chain[] => {
  const chains: Chain[] = [];
  let current: Chain | null = null;
  for (const token of tokens) {
    const previous = current?.tokens.at(-1);
    const between =
      previous === undefined ? null : text.slice(previous.end, token.start);
    let link: Link | null = null;
    if (between !== null && between.length <= SEPARATOR_MAX_LENGTH) {
      if (separators.range.test(between)) {
        link = "range";
      } else if (separators.join.test(between)) {
        link = "join";
      }
    }
    if (current !== null && link !== null) {
      current.tokens.push(token);
      current.links.push(link);
      continue;
    }
    current = { tokens: [token], links: [] };
    chains.push(current);
  }
  return chains;
};

const refusalOf = (
  from: CaseNumberToken,
  to: CaseNumberToken,
): CjeuRangeRefusalReason | null => {
  if (from.letter !== to.letter) {
    return CJEU_RANGE_REFUSALS.crossesCourt;
  }
  if (from.year !== to.year) {
    return CJEU_RANGE_REFUSALS.crossesYear;
  }
  if (to.ordinal <= from.ordinal) {
    return CJEU_RANGE_REFUSALS.notAscending;
  }
  if (to.ordinal - from.ordinal + 1 > CJEU_RANGE_MAX_CASES) {
    return CJEU_RANGE_REFUSALS.exceedsSpan;
  }
  return null;
};

/**
 * Every reference in `text` that names CJEU cases by number: each chain of
 * joined or ranged numbers, with the ECLI printed after it when there is
 * one, and the ranges refused as ranges.
 *
 * A number without its registry letter ("60/81") is the Court's own pre-1989
 * numbering, and the same shape as a directive's or a report's; it is only
 * read inside a reference whose ECLI follows.
 */
export const readCjeuCitationGroups = (
  text: string,
  language?: string,
): CjeuCitationGroupReading => {
  const separators = separatorRes(language);
  const groups: CjeuCitationGroup[] = [];
  const refusals: CjeuRangeRefusal[] = [];
  for (const { tokens, links } of chainsOf(
    text,
    caseNumberTokens(text),
    separators,
  )) {
    const last = tokens.at(-1);
    if (last === undefined) {
      continue;
    }
    const tail = ECLI_TAIL_RE.exec(text.slice(last.end));
    const ecliText = tail?.groups?.["ecli"];
    const ecli: PrintedSpan | null =
      tail === null || ecliText === undefined
        ? null
        : {
            text: ecliText,
            start: last.end + tail[0].length - ecliText.length,
            end: last.end + tail[0].length,
          };
    // A bare number reads only in a reference of bare numbers that prints
    // its ECLI: beside a lettered one it is more likely a directive's.
    const lettered = tokens.some((token) => token.letter !== null);
    const readable = (token: CaseNumberToken): boolean =>
      token.letter !== null || (ecli !== null && !lettered);
    const members: CjeuGroupMember[] = [];
    for (const [index, token] of tokens.entries()) {
      if (!readable(token)) {
        continue;
      }
      members.push({
        caseNumber: caseNumberOf(token, token.digits),
        span: { text: token.text, start: token.start, end: token.end },
        role: "printed",
      });
      const next = tokens[index + 1];
      if (links[index] !== "range" || next === undefined || !readable(next)) {
        continue;
      }
      const range: PrintedSpan = {
        text: text.slice(token.start, next.end),
        start: token.start,
        end: next.end,
      };
      const refused = refusalOf(token, next);
      if (refused !== null) {
        refusals.push({ reason: refused, printed: range.text, ...range });
        continue;
      }
      for (
        let ordinal = token.ordinal + 1;
        ordinal < next.ordinal;
        ordinal += 1
      ) {
        members.push({
          caseNumber: caseNumberOf(token, String(ordinal)),
          span: range,
          role: "range-interior",
        });
      }
    }
    if (members.length > 0) {
      groups.push({ members, ecli });
    }
  }
  return { groups, refusals };
};
