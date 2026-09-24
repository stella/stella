import { panic } from "better-result";

import {
  DECISION_DASH_CLASS_SOURCE,
  DECISION_DOCKET_GRAMMARS,
  PL_ADMINISTRATIVE_PRE_REFORM_RESOLUTION_SOURCE,
  PL_ADMINISTRATIVE_SEATED_DOCKET_SOURCE,
  PL_ADMINISTRATIVE_SEATLESS_DOCKET_SOURCE,
  PL_AUTHORITY_FILE_NUMBER_SOURCE,
  PL_UOKIK_CITED_DECISION_NUMBER_SOURCE,
  PL_KIO_DOCKET_SOURCE,
  PL_TK_DISTINCTIVE_DOCKET_SOURCE,
  PL_TK_DOCKET_SOURCE,
  polishAdministrativeDocketOf,
  polishConstitutionalDocketKey,
  polishKioDocketKey,
} from "@stll/api-contract/decision-docket-grammar";
import {
  CZ_FILE_NUMBER_PREFIX_SOURCE,
  stripCitationPrefix,
} from "@stll/legal-ast/citation-prefix";
import {
  DECISION_IDENTIFIER_MAX_COUNT,
  DECISION_IDENTIFIER_TYPES,
  isDecisionIdentifier,
  normalizeStructuredDecisionIdentifier,
} from "@stll/legal-ast/decision-identifier";
import type {
  DecisionIdentifier,
  DecisionIdentifiers,
  DecisionIdentifierType,
} from "@stll/legal-ast/decision-identifier";

import { detectCitationCourtHint } from "@/api/handlers/case-law/citation-court-hint";
import { detectCitationDecisionDate } from "@/api/handlers/case-law/citation-decision-date";
import {
  type CitationDecisionTypeHint,
  detectCitationDecisionTypeHint,
} from "@/api/handlers/case-law/citation-decision-type-hint";
import { detectCitationSheetNumber } from "@/api/handlers/case-law/citation-sheet-number";
import {
  UNPERSISTABLE_DECISION_FIELDS,
  UnpersistableDecisionFieldError,
} from "@/api/lib/errors/tagged-errors";
import { decisionIdentifiersFromPersistedMetadata } from "@/api/lib/legal-search/decision-identifier-metadata";

/**
 * Extracted citation reference found in decision text.
 */
type ExtractedCitation = {
  /** The raw citation text as found in the source. */
  citationText: string;
  /** Section index where the citation was found. */
  sectionIndex: number | null;
  /**
   * The decision-type word the text introduced the number with, when one
   * binds to it; see `citation-decision-type-hint.ts`. Null is "the text did
   * not say", never "unknown type".
   */
  citedDecisionTypeHint: CitationDecisionTypeHint | null;
  identifierType: DecisionIdentifierType;
  /**
   * The spelling the identity is read from, which is `citationText` except
   * where a sentence names one decision twice over — by docket and by
   * collection number. There the entry anchors on the docket the reader sees
   * and takes its identity from the collection number, which names exactly
   * one decision where a docket may name a file's worth.
   */
  identifierValue: string;
  /**
   * The court phrase the text introduced the number with, verbatim, when
   * the sentence takes the standard form; see `citation-court-hint.ts`.
   * Null is "the text did not say", and also what two occurrences naming
   * different courts collapse to.
   */
  citedCourtHint: string | null;
  /**
   * The sheet the text names the decision on, when it prints one; see
   * `citation-sheet-number.ts`. Null is "the text did not say", and also
   * what two occurrences naming different sheets of one file collapse to.
   */
  citedSheetNumber: string | null;
  /**
   * The decision date the sentence names, as `YYYY-MM-DD`; see
   * `citation-decision-date.ts`. Same rule for a conflict: one docket dated
   * two ways in one text names two decisions, and a single hint would pick
   * one of them by occurrence order.
   */
  citedDecisionDate: string | null;
};

/**
 * Patterns for recognizing case law citations in Czech, Slovak, Polish,
 * Hungarian and CJEU decision texts. Covers common reference formats used
 * in judicial practice.
 *
 * Based on analysis of 770K citation instances in the CzCDC corpus
 * (Harasta, Masaryk University), cross-checked against the SAOS public
 * API for Polish case law.
 *
 * Deliberately out of scope (precision trade-offs, revisit with evidence):
 *  - Slovak "Spr"/"Spr." court-administration agenda numbers: these are
 *    docket numbers for the court's own administration, not adjudication,
 *    so they are not case law citations.
 *  - "NNNEX" bailiff/exekútor numbers without a court-registry token:
 *    executor files, not court decisions.
 *  - Bare single-letter Polish Constitutional Tribunal symbols (K, P, U)
 *    with no "sygn." anchor anywhere nearby: too collision-prone against
 *    ordinary prose and ordinary district-court registries; SAOS-quantified.
 *  - Bare, unanchored pre-1989 CJEU numbers (no trailing ECLI suffix):
 *    collide with directive numbers ("65/65/EEC") and report numbers
 *    ("1/96").
 *  - CJEU numbers with no hyphen at all ("C679/18"): collide with the
 *    Czech civil "C" registry ("21 C 1234/2020"). The hyphen may be
 *    spaced ("C- 303/20", "C -679/18") but must be present.
 *  - Slovak "R NN/YYYY" reporter citations: needs proximity anchoring to
 *    the citing court to avoid collisions; future work.
 *  - Hungarian dockets without the document number ("Pfv.20.123/2019."):
 *    the corpus keys a Hungarian decision by the document, so a file-level
 *    reference has nothing to resolve to, and the trailing "/N" is also what
 *    keeps the shape apart from prose.
 *  - Pre-2012 Hungarian collegium statements cited by bare number ("PK 32.",
 *    "GK 34."): no year, so the number names nothing outside its series.
 */

/**
 * Every dash a citation may separate a docket's parts with: the grammars'
 * own class, plus the soft hyphen (U+00AD) a PDF-to-text pass leaves behind
 * at a line-wrap boundary, invisible when rendered.
 *
 * Written once because it appears in three patterns, in the sheet-number
 * reader, and in the dedup key's folding. A hand-copied class is how one dash spelling silently stops
 * matching in one of them: the publications office typesets CJEU numbers
 * with U+2011, and a Czech court typesets the sheet separator in
 * `8 As 287/2020-33` with U+2011 as readily as with an ASCII hyphen.
 */
const CITATION_DASH_CLASS = `${DECISION_DASH_CLASS_SOURCE}\u00AD`;

// Shared body for Czech/Slovak numeric-first case numbers: chamber
// number, registry letters (diacritics included, e.g. Slovak "Sžf"),
// then docket number and year. Real filings mix separator conventions
// inconsistently -- attached ("5Cdo/260/2008"), fully spaced
// ("21 Cdo 1234/2020", "33 Cb/209/2010"), or attached-then-spaced
// ("10C 84/97", two-digit year) all name the same kind of case number.
// Each gap is a bounded whitespace/slash run (not a single optional
// character), so a double space or a CRLF line-wrap ("21\r\nCdo") still
// matches; the bound keeps the pattern resolving in one pass with no
// repeated alternation to backtrack through. `canonicalizeDedupKey`
// collapses the resulting spelling variance to one dedup key.
const CASE_NUMBER_BODY = String.raw`(?<caseNumber>\d{1,3}\s{0,3}\p{L}{1,6}[\s/]{1,3}\d{1,6}\/\d{2,4})(?!\d)`;

// Same shape, but the docket number may join a second consolidated
// docket that shares the trailing year: courts consolidating appeals
// into one ruling cite both numbers together under a single registry,
// e.g. "č. j. 27 Co 116, 119/2007-94" (appeals 116 and 119, both /2007),
// "36 Co 52,53/2023" (no space after the comma), or "36 Co 52/53/2023"
// (slash instead of comma). `canonicalizeDedupKey` folds every join
// spelling to one canonical key.
const CASE_NUMBER_BODY_COMMA = String.raw`(?<caseNumber>\d{1,3}\s{0,3}\p{L}{1,6}[\s/]{1,3}\d{1,6}(?:[,/]\s{0,3}\d{1,6})?\/\d{2,4})(?!\d)`;

// The Constitutional Court's mark, in either Unicode normalization form.
// Publishers serve "Ú" precomposed (U+00DA) and decomposed (U+0055 U+0301)
// alike, and nothing normalizes a decision's text on the way in: the AST's
// raw axis is what reader anchors index, so it stays verbatim, combining
// marks included. A plain `[ÚU]S` class reads the decomposed spelling as a
// bare "U" followed by a mark and matches nothing, dropping every
// Constitutional Court citation in the document. The mark-free "US" spelling
// (a dropped diacritic, likely an encoding fallback) is the same class.
const US_MARK_SOURCE = String.raw`[ÚU]\p{Mn}*S`;

const CZECH_REPORTER_CITATION_SOURCE = String.raw`[čc]\.\s*\d{1,5}\/\d{4}\s+Sb\.\s*(?:rozh\.\s*(?:tr|ob)\.?|NSS|NS)`;

const CZECH_REPORTER_CITATION_RE = new RegExp(
  `^${CZECH_REPORTER_CITATION_SOURCE}$`,
  "iu",
);

/**
 * A Constitutional Court ruling by the number it was published under in the
 * Sbírka zákonů: `234/2002 Sb.`. Acts share the series, so the number alone
 * names an act as readily as a ruling; the extraction pattern below only
 * reads it after the ruling itself is named, and a bare number stored as a
 * citation's text is therefore always a ruling.
 */
const CZ_US_GAZETTE_SOURCE = String.raw`\d{1,4}\/\d{4}\s+Sb\.`;

/**
 * What may introduce a ruling's gazette number: a form of "nález", then only
 * the words that describe that ruling (the court, the plenum, the date, the
 * docket, "vyhlášený pod") before `č.`. Any other word between them, "zákona"
 * above all, ends the context, so `nálezu … ve věci zákona č. 82/1998 Sb.`
 * stays an act.
 */
const CZ_US_GAZETTE_LEAD_SOURCE = String.raw`(?<!\p{L})[Nn]ález(?:u|em|y|ů|ům|ech)?(?:\s+pléna|\s+(?:Ústavního\s+soudu|${US_MARK_SOURCE})|\s+ze\s+dne\s+\d{1,2}\.\s*(?:\d{1,2}\.|\p{L}{3,9})\s*\d{4}|,?\s+sp\.\s*zn\.\s*(?:Pl|[IVX]{1,4})\.?\s*${US_MARK_SOURCE}(?:\s*[${DECISION_DASH_CLASS_SOURCE}]\s*st\.)?\s*\d{1,5}\/\d{2,4}|,?\s+(?:(?:který|jenž)\s+)?(?:byl\s+)?(?:vyhlášen|publikov[aá]n|uveřejněn)\p{L}{0,3}(?:\s+ve\s+Sbírce\s+zákonů)?\s+pod){0,6},?\s+[čc]\.\s*`;

/**
 * The Constitutional Court's own reporter, the Sbírka nálezů a usnesení, in
 * the form the court cites it: `N 53/26 SbNU 73` is nález 53 of volume 26,
 * printed on page 73 (`U` for an usnesení).
 */
const CZ_US_REPORT_SOURCE = String.raw`(?<![\p{L}\p{N}])[NU]\s?\d{1,4}\/\d{1,3}\s+SbNU(?:\s+\d{1,4})?(?![\p{L}\p{N}])`;

/**
 * The same entry in the older spelled-out form, where the kind is written as
 * a word: `Sbírka nálezů a usnesení Ústavního soudu, svazek 7, nález č. 13`.
 * The form that leaves the kind to the reader (`sv. 33, pod č. 67`) is not
 * read: the number alone does not say which of the volume's two series it
 * counts in.
 */
const CZ_US_REPORT_VOLUME_SOURCE = String.raw`(?:Sbír(?:ka|ky|ce|ku)\s+nálezů\s+a\s+usnesení(?:\s+(?:Ústavního\s+soudu|${US_MARK_SOURCE}))?\s*,?\s*)?(?:svaz(?:ek|ku)|sv\.)\s*\d{1,3}\s*,\s*(?:nález|usnesení)\s+[čc]\.\s*\d{1,4}(?!\d)`;

const CZ_US_GAZETTE_RE = /^(?<number>\d{1,4})\/(?<year>\d{4}) Sb\.?$/u;
const CZ_US_REPORT_RE =
  /^(?<kind>[NU]) ?(?<number>\d{1,4})\/(?<volume>\d{1,3}) SbNU(?: \d{1,4})?$/u;
const CZ_US_REPORT_VOLUME_RE =
  /^(?:Sbír\p{L}{1,2} nálezů a usnesení(?: \S+(?: soudu)?)? ?,? ?)?(?:svaz\p{L}{2}|sv\.) ?(?<volume>\d{1,3}) ?, ?(?<kind>nález|usnesení) [čc]\. ?(?<number>\d{1,4})$/u;

/**
 * A Constitutional Court ruling in one spelling per publication, for the
 * reporter-citation normalization, or null for text that is neither: the
 * gazette number as `234/2002 Sb.`, the reporter entry as `SbNU sv. 26 N 53`.
 *
 * The reporter entry keeps volume, series and number and drops the page: the
 * three name the entry, the page only locates it, and a citation that leaves
 * the page out still names the same ruling. Letters stand between the numbers
 * because the shared normalization strips punctuation, and `N 5/326` must not
 * meet `N 53/26`.
 */
const czechConstitutionalDesignation = (value: string): string | null => {
  const text = value
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .replace(/ ?\/ ?/gu, "/")
    .trim();
  const gazette = CZ_US_GAZETTE_RE.exec(text)?.groups;
  if (gazette !== undefined) {
    return `${requiredGroup(gazette, "number")}/${requiredGroup(gazette, "year")} Sb.`;
  }
  const report =
    CZ_US_REPORT_RE.exec(text)?.groups ??
    CZ_US_REPORT_VOLUME_RE.exec(text)?.groups;
  if (report === undefined) {
    return null;
  }
  const kind = requiredGroup(report, "kind");
  const series = kind === "U" || kind === "usnesení" ? "U" : "N";
  const volume = Number(requiredGroup(report, "volume"));
  const number = Number(requiredGroup(report, "number"));
  return `SbNU sv. ${String(volume)} ${series} ${String(number)}`;
};

/**
 * Reporter identifiers for a Constitutional Court ruling, read from the
 * parallel citations its publisher lists beside it (`234/2002 Sb.`,
 * `N 53/26 SbNU 73`), one or several to a value. A part that is neither form
 * is left out rather than stored under a type it does not have.
 */
export const czechConstitutionalIdentifiersFromParallelCitations = (
  values: readonly string[],
): DecisionIdentifier[] => {
  const seen = new Set<string>();
  return values
    .flatMap((value) => value.split(/[\n;]|,(?=\s)/u))
    .map((part) => part.trim())
    .flatMap((part) => {
      const designation = czechConstitutionalDesignation(part);
      const identifier = {
        type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        value: part,
      } as const;
      if (
        designation === null ||
        seen.has(designation) ||
        !isDecisionIdentifier(identifier)
      ) {
        return [];
      }
      seen.add(designation);
      return [identifier];
    });
};

/**
 * Where the Constitutional Court adapter stores a ruling's parallel
 * citations: the document page's combined field, and the record card's two
 * cells, each a string or, when the court repeats the cell, a list.
 */
const CZ_US_PARALLEL_CITATION_METADATA_KEYS = [
  "parallelQuotation",
  "parallelCitationLaws",
  "parallelCitationReports",
] as const;

const czechConstitutionalParallelCitations = (
  metadata: Record<string, unknown>,
): string[] =>
  CZ_US_PARALLEL_CITATION_METADATA_KEYS.flatMap((key) => {
    const value: unknown = metadata[key];
    if (typeof value === "string") {
      return [value];
    }
    const values: unknown[] = Array.isArray(value) ? value : [];
    return values.filter((item) => typeof item === "string");
  });

/**
 * A Hungarian court docket as the courts print it: an optional Arabic panel
 * number, the registry letters with their dot, an optional Roman panel
 * numeral, the register number (typeset with a thousands dot by the courts,
 * without it by the publisher's listing), the filing year, and the document
 * number within the file: `Pfv.III.20.123/2019/5`, `5.Gf.40.014/2023/15`,
 * `Pfv. 20.187/2017/12`, `Mfv.10043/2022/5`.
 *
 * The dot after the registry and the `/year/document` tail are what no
 * Czech, Slovak, Polish or CJEU number has: those courts put a space or a
 * slash between registry and number and end on the year or on a dash-joined
 * sheet. The registry is title-case, which keeps out an all-caps agency
 * acronym and the `GK.34` collegium series the listing also carries.
 */
const HU_DOCKET_SOURCE = String.raw`(?:\d{1,3}\.\s?)?\p{Lu}\p{Ll}{0,4}\.\s?(?:[IVXLC]{1,5}\.\s?)?(?:\d{1,3}\.\d{3}|\d{1,6})\/\d{4}\/\d{1,4}`;

/**
 * The same docket read for its parts, over a string that is only a docket.
 * Case-insensitive because it also reads stored case numbers and keys, which
 * are lowercased.
 */
const HU_DOCKET_PARTS_RE =
  /^(?:\d{1,3}\.\s?)?(?<registry>\p{L}{1,5})\.\s?(?:[IVXLC]{1,5}\.\s?)?(?<register>\d{1,3}\.\d{3}|\d{1,6})\/(?<year>\d{4})\/(?<document>\d{1,4})\.?$/iu;

/**
 * The official date a Hungarian designation may carry after its number, the
 * month in Roman numerals: `(V. 30.)`, `(II.27.)`.
 */
const HU_DESIGNATION_DATE_SOURCE = String.raw`(?:\([IVX]{1,4}\.\s?\d{1,2}\.\s?\)\s?)?`;

/**
 * Hungarian published-decision series: Bírósági Határozatok (`BH 2019.123.`),
 * the elvi határozatok and döntések (`EBH 2018.G.3.`, `EBD 2016.M.12.`), the
 * Bírósági Döntések Tára (`BDT 2019.4012.`), the Közigazgatási és Gazdasági
 * Döntvénytár (`KGD 2020.15.`) and Ítélőtáblai Határozatok (`ÍH 2018.45.`).
 * An issue number or a legal-area letter may sit between the year and the
 * entry (`BH 2020.7.201`). The listing stores EBH and EBD entries as case
 * numbers, dotted, with or without a closing dot (`EBH.2018.K.17.`,
 * `EBH.2015.K.38`), and once with a doubled dot (`EBH..2013.K.32.`).
 */
const HU_REPORTER_CITATION_SOURCE = String.raw`(?<![\p{L}\d])(?:EBH|EBD|BDT|KGD|BH|ÍH)[\s.]{0,2}\d{4}\.\s?(?:(?:[A-Z]|\d{1,2})\.\s?)?\d{1,5}(?!\d)`;

/** The same entry read for its parts; case-insensitive so a key reads back. */
const HU_REPORTER_PARTS_RE =
  /^(?<series>EBH|EBD|BDT|KGD|BH|ÍH)[\s.]{0,2}(?<year>\d{4})\.\s?(?:(?<part>[A-Z]|\d{1,2})\.\s?)?(?<entry>\d{1,5})\.?$/iu;

/**
 * The fields a Kúria uniformity decision is issued in, by the word the long
 * form uses and the abbreviation the short form uses. The hyphenated field is
 * keyed on its ASCII-hyphen spelling; the key is read after dashes are folded,
 * with the same class the pattern accepts, so every field the pattern reads
 * has an entry here.
 */
const HU_UNIFORMITY_FIELDS = {
  polgári: "PJE",
  büntető: "BJE",
  közigazgatási: "KJE",
  munkaügyi: "MJE",
  gazdasági: "GJE",
  "közigazgatási-munkaügyi": "KMJE",
} as const satisfies Record<string, string>;

const HU_UNIFORMITY_ABBREVIATION_SOURCE = String.raw`KMPJE|KMJE|KPJE|PJE|BJE|KJE|MJE|GJE`;

/**
 * A uniformity decision (jogegységi határozat), short or long:
 * `1/2019. PJE`, `2/2020. KMPJE`, `4/2021. Polgári jogegységi határozat`.
 * The number is only unique within its field, so a long form that names no
 * field ("a jogegységi határozat") is not a citation.
 */
const HU_UNIFORMITY_SOURCE = String.raw`(?<![\p{L}\d\/.])(?<number>\d{1,3})\/(?<year>\d{4})\.\s?${HU_DESIGNATION_DATE_SOURCE}(?:(?<abbreviation>${HU_UNIFORMITY_ABBREVIATION_SOURCE})(?!\p{L})|(?<field>[Kk]özigazgatási[${DECISION_DASH_CLASS_SOURCE}][Mm]unkaügyi|[Pp]olgári|[Bb]üntető|[Kk]özigazgatási|[Mm]unkaügyi|[Gg]azdasági)\s+jogegységi\s+határozat)`;

/** The same decision with the series first: `PJE 4/2021`. */
const HU_UNIFORMITY_SERIES_FIRST_SOURCE = String.raw`(?<![\p{L}\d])(?<abbreviation>${HU_UNIFORMITY_ABBREVIATION_SOURCE})\s+(?<number>\d{1,3})\/(?<year>\d{4})(?!\d)`;

const HU_OPINION_COLLEGIUM_SOURCE = String.raw`KMK|KJK|PK|GK|BK|MK|KK`;

/** A collegium opinion (kollégiumi vélemény): `1/2014. PK vélemény`. */
const HU_OPINION_SOURCE = String.raw`(?<![\p{L}\d\/.])(?<number>\d{1,3})\/(?<year>\d{4})\.\s?${HU_DESIGNATION_DATE_SOURCE}(?<collegium>${HU_OPINION_COLLEGIUM_SOURCE})\s+vélemény`;

/** The same opinion with the series first: `PK vélemény 1/2014`. */
const HU_OPINION_SERIES_FIRST_SOURCE = String.raw`(?<![\p{L}\d])(?<collegium>${HU_OPINION_COLLEGIUM_SOURCE})\s+vélemény\s+(?<number>\d{1,3})\/(?<year>\d{4})(?!\d)`;

/**
 * A uniformity decision or opinion as the listing stores it: `4.2008.BJE`,
 * `1.2019.KMPJE`, `2.2009.PK`. Case-insensitive, so a key reads back.
 */
const HU_SERIES_STORED_RE = new RegExp(
  String.raw`^(?<number>\d{1,3})\.(?<year>\d{4})\.(?<series>${HU_UNIFORMITY_ABBREVIATION_SOURCE}|${HU_OPINION_COLLEGIUM_SOURCE})\.?$`,
  "iu",
);

/**
 * A Constitutional Court decision or order:
 * `3123/2019. (V. 30.) AB határozat`, `12/2020. AB végzés`. The court numbers
 * both in one yearly sequence, so number and year name the document and the
 * key drops the date and the type word. A ministerial decree shares the
 * number-date shape (`9/2006. (II.27.) IM rendelet`); the `AB` mark is what
 * tells them apart.
 */
const HU_CONSTITUTIONAL_SOURCE = String.raw`(?<![\p{L}\d\/.])(?<number>\d{1,4})\/(?<year>\d{4})\.\s?${HU_DESIGNATION_DATE_SOURCE}AB\s+(?:határozat|végzés)`;

// Read over a whole citation text, which each extraction pattern ends where
// the designation ends.
const HU_UNIFORMITY_RE = new RegExp(`^${HU_UNIFORMITY_SOURCE}$`, "u");
const HU_UNIFORMITY_SERIES_FIRST_RE = new RegExp(
  `^${HU_UNIFORMITY_SERIES_FIRST_SOURCE}$`,
  "u",
);
const HU_OPINION_RE = new RegExp(`^${HU_OPINION_SOURCE}$`, "u");
const HU_OPINION_SERIES_FIRST_RE = new RegExp(
  `^${HU_OPINION_SERIES_FIRST_SOURCE}$`,
  "u",
);
const HU_CONSTITUTIONAL_RE = new RegExp(`^${HU_CONSTITUTIONAL_SOURCE}$`, "u");

type RegExpGroups = Partial<Record<string, string>>;

/** A named group the matched pattern cannot have left empty. */
const requiredGroup = (groups: RegExpGroups, name: string): string =>
  groups[name] ?? panic(`Matched citation has no ${name}`);

const isHungarianUniformityField = (
  field: string,
): field is keyof typeof HU_UNIFORMITY_FIELDS =>
  Object.hasOwn(HU_UNIFORMITY_FIELDS, field);

const uniformityAbbreviation = (groups: RegExpGroups): string => {
  const abbreviation = groups["abbreviation"];
  if (abbreviation !== undefined) {
    return abbreviation;
  }
  const field = requiredGroup(groups, "field").toLocaleLowerCase("hu-HU");
  return isHungarianUniformityField(field)
    ? HU_UNIFORMITY_FIELDS[field]
    : panic(`Unmapped Hungarian uniformity field: ${field}`);
};

/**
 * The key of a Hungarian series designation — a uniformity decision, an
 * opinion, or a reporter entry — or null for text that is none of them.
 *
 * One key per document, in the listing's own dotted spelling lowercased,
 * because the listing stores these as case numbers and `citation_key` holds
 * them that way: `4.2021.pje` for `4/2021. PJE`, `PJE 4/2021`,
 * `4/2021. Polgári jogegységi határozat` and the stored `4.2021.PJE`;
 * `1.2014.pk` for `1/2014. PK vélemény`, `PK vélemény 1/2014` and the stored
 * `1.2014.PK`; `ebh.2018.k.17` for `EBH 2018.K.17.`, `EBH2018. K.17.` and the
 * stored `EBH.2018.K.17.` or `EBH.2018.K.17`. The reporter key drops the
 * closing dot, which the listing writes on some rows and not on others, and
 * keeps every part apart with one dot so `BH 2019.19` and `BH 2019.1.9` stay
 * two entries. Every key reads back as itself.
 */
const hungarianSeriesKey = (text: string): string | null => {
  const stored = HU_SERIES_STORED_RE.exec(text)?.groups;
  if (stored !== undefined) {
    return `${requiredGroup(stored, "number")}.${requiredGroup(stored, "year")}.${requiredGroup(stored, "series")}`.toLowerCase();
  }
  const uniformity =
    HU_UNIFORMITY_RE.exec(text)?.groups ??
    HU_UNIFORMITY_SERIES_FIRST_RE.exec(text)?.groups;
  if (uniformity !== undefined) {
    return `${requiredGroup(uniformity, "number")}.${requiredGroup(uniformity, "year")}.${uniformityAbbreviation(uniformity)}`.toLowerCase();
  }
  const opinion =
    HU_OPINION_RE.exec(text)?.groups ??
    HU_OPINION_SERIES_FIRST_RE.exec(text)?.groups;
  if (opinion !== undefined) {
    return `${requiredGroup(opinion, "number")}.${requiredGroup(opinion, "year")}.${requiredGroup(opinion, "collegium")}`.toLowerCase();
  }
  const reporter = HU_REPORTER_PARTS_RE.exec(text)?.groups;
  if (reporter !== undefined) {
    const part = reporter["part"];
    return [
      requiredGroup(reporter, "series"),
      requiredGroup(reporter, "year"),
      ...(part === undefined ? [] : [part]),
      requiredGroup(reporter, "entry"),
    ]
      .join(".")
      .toLowerCase();
  }
  return null;
};

/**
 * A Constitutional Court decision in one spelling, for the reporter-citation
 * normalization, or null for text that is not one. The corpus stores no
 * Constitutional Court decisions, so there is no stored spelling to meet.
 */
const hungarianConstitutionalDesignation = (value: string): string | null => {
  const groups = HU_CONSTITUTIONAL_RE.exec(
    normalizeDashes(value.normalize("NFC")).replace(/\s+/gu, " ").trim(),
  )?.groups;
  return groups === undefined
    ? null
    : `${requiredGroup(groups, "number")}/${requiredGroup(groups, "year")}. AB`;
};

/**
 * What a citation is, read as Hungarian: a court docket and its registry, or
 * a published designation (a reporter entry, a uniformity decision, an
 * opinion, a Constitutional Court decision). Null for text that is neither.
 */
type HungarianCitationForm =
  | { type: "docket"; registry: string }
  | { type: "published" };

export const hungarianCitationForm = (
  citationText: string,
): HungarianCitationForm | null => {
  const text = normalizeDashes(citationText.normalize("NFC"))
    .replace(/\s+/gu, " ")
    .trim();
  if (
    hungarianSeriesKey(text) !== null ||
    hungarianConstitutionalDesignation(text) !== null
  ) {
    return { type: "published" };
  }
  const registry = HU_DOCKET_PARTS_RE.exec(text)?.groups?.["registry"];
  return registry === undefined
    ? null
    : { type: "docket", registry: registry.toLocaleLowerCase("hu-HU") };
};

// Shared "sygn." lead-in, covering every registrar spelling seen in the
// corpus: title-case "Sygn." at the start of a document header vs.
// lowercase "sygn." in body prose; an optional colon directly after the
// period ("sygn.: P. 12/98"); and "akt" itself optionally punctuated with
// a dot ("akt.") or a colon ("akt:"), or omitted entirely ("sygn. II CSK
// 123/20"). Every gap is a bounded whitespace run (not unbounded `\s*`),
// so an OCR whitespace run after "sygn." fails to match rather than
// being swallowed into a phantom Tribunal citation.
const PL_SYGN_PREFIX = String.raw`[Ss]ygn\.\s{0,3}(?::\s{0,3})?(?:[Aa]kt\.?:?\s{0,3})?`;

// Polish prefixed pattern: "sygn. akt II CSK 123/20". The chamber roman
// numeral and division code are frequently glued with no space ("IC
// 171/12", "XP 3615/05", division count up to "XVIII"), and the division
// code itself is sometimes a second, space- or slash-joined token
// ("III A Ua 2389/02" labor-appellate panels, "VI SA/Wa" handled by the
// dedicated NSA/WSA pattern instead), with a bounded whitespace/slash run
// (not a single character) between the two division tokens so a double
// space or a line-wrap still matches ("sygn. akt III  A Ua 2389/02"). The
// gap between the roman numeral and the division code is likewise a
// bounded run (0-3 characters, not unbounded `\s*`): it must match
// PL_TK_PATTERN/PL_TK_BARE_PATTERN's phantom-duplicate lookbehind exactly,
// or a whitespace run this pattern still combines into one citation but
// the lookbehind no longer recognizes lets the Tribunal symbol at the
// tail phantom-duplicate as a second, separate citation. Group
// `caseNumber` captures the bare case number to deduplicate against the
// unprefixed pattern below.
const PL_PREFIXED_PATTERN = new RegExp(
  String.raw`${PL_SYGN_PREFIX}(?<caseNumber>[IVX]{1,6}\s{0,3}[A-Za-z]{1,5}(?:[\s/]{1,3}[A-Za-z]{1,5})?\s*\d{1,6}\/\d{2,4})`,
  "gu",
);

// Polish division + proceeding-type case number: "sygn. akt V GNc upr
// 936/13" (Gospodarczy Nakazowo-upominawczy: commercial writ-of-payment
// proceedings). The lowercase proceeding-type word is a third,
// space-separated token after the ordinary chamber code, which
// PL_PREFIXED_PATTERN's single optional second token cannot capture.
const PL_THREE_TOKEN_PATTERN =
  /[Ss]ygn\.\s*[Aa]kt\.?:?\s*(?<caseNumber>[IVX]{1,4}\s+[A-Za-z]{1,5}\s+[a-z]{1,5}\s+\d{1,6}\/\d{2,4})(?!\d)/gu;

// Polish Constitutional Tribunal (Trybunał Konstytucyjny) and disciplinary
// chambers cite by a short case-type symbol with no Roman-numeral chamber:
// "K" (abstract review), "Kp"/"Kpt" (presidential preventive review /
// competence dispute), "SK" (constitutional complaint), "P" (legal
// question), "U" (competence dispute), "Tw" (citizens' petition), "Pp",
// "Ts" (preliminary examination). Symbols may carry a trailing dot ("K.
// 23/98"), separated from the docket by a bounded whitespace run (0-3
// characters, not unbounded `\s*`) so an OCR whitespace run is rejected
// rather than preserved verbatim in the stored citation text. Longer
// symbols are listed first in the alternation so "Kp"/"Kpt"/"SK"/"Ts" are
// never shadowed by the bare "K". Multi- and single-letter symbols alike
// are cited fully bare in running prose, with no "sygn." anywhere nearby,
// so the "sygn." anchor is optional; the negative lookbehind (unbounded
// roman run, bounded 1-3 whitespace run) stops a single-letter symbol
// from phantom-duplicating the tail of an ordinary Roman-numeral-prefixed
// citation immediately before it ("sygn. akt II K 796/13" is one citation,
// not also a bare "K 796/13"), including after a double space ("II  SK
// 12/20"). The lookbehind's 1-3 bound (not 0-3: an unanchored 0-width
// option here trips scslre's superlinear-suffix-matching check) still
// closes the gap with PL_PREFIXED_PATTERN and the bare Polish pattern,
// both themselves bounded to reject a four-or-more-space roman-to-symbol
// gap as one ambient citation -- a gap too wide for either matcher to
// combine never reaches this guard as an ambient citation to
// phantom-duplicate in the first place, and the roman-numeral-glued case
// this guard need not cover at zero spacing never satisfies the leading
// `\b` on the symbol capture below anyway.
// Single-letter symbols (K, P, U, W, S, T) and `Uw`/`Kw` require a
// Tribunal cue: the "sygn." anchor here, or a nearby mention of the
// Tribunal or a "wyrok ... z dnia" lead-in (PL_TK_CUED_PATTERN). Bare they
// collide with ordinary prose and district-court registries (an
// SAOS-quantified precision trade-off). The distinctive multi-letter
// symbols match bare, still guarded against phantom-duplicating a
// Roman-numeral-prefixed citation's tail. The prefix lists live in the
// shared docket grammar.
const PL_TK_PATTERN = new RegExp(
  String.raw`${PL_SYGN_PREFIX}(?<!\b[IVX]+\s{1,3})\b(?<caseNumber>${PL_TK_DOCKET_SOURCE})(?!\d)`,
  "gu",
);

// Like PL_TK_CUED_PATTERN below, rejects a Roman division across any
// whitespace run: "I SK 12/20" is a Supreme Court docket, and its tail read
// past a wide gap would key it as the Tribunal's.
const PL_TK_BARE_PATTERN = new RegExp(
  String.raw`(?<!\b[IVX]+\s+)\b(?<caseNumber>${PL_TK_DISTINCTIVE_DOCKET_SOURCE})(?!\d)`,
  "gu",
);

// The cue-gated matcher rejects a Roman division before the symbol across
// any whitespace run, not only the 1-3 characters the combining patterns
// accept: past that bound the whole docket goes unread, and its tail
// ("sygn. akt II    K 12/20" -> "K 12/20") would otherwise pass the cue
// gate as a different, Tribunal docket.
const PL_TK_CUED_PATTERN = new RegExp(
  String.raw`(?<!\b[IVX]+\s+)\b(?<caseNumber>${PL_TK_DOCKET_SOURCE})(?!\d)`,
  "gu",
);

/**
 * What marks a nearby bare "K 2/19" as the Tribunal's: its name or
 * abbreviation, a "sygn." label, or a judgment introduced by its date, in
 * any capitalisation ("Sygn.", a sentence-initial "Wyrok").
 */
const PL_TK_CUE_RE =
  /\bTK\b|Trybuna(?:ł|l)\p{L}*\s+Konstytucyjn|sygn\.|\bwyrok\p{L}*[^;]{0,80}?\bz\s+dnia\b/iu;

/** How far before a bare Tribunal docket a cue may sit. */
const PL_TK_CUE_WINDOW = 120;

/** Patterns whose capture only counts next to a Tribunal cue. */
const PL_TK_CUE_GATED_PATTERNS: ReadonlySet<RegExp> = new Set([
  PL_TK_CUED_PATTERN,
]);

// A data protection authority's file number: "znak sprawy DKN.5131.6.2024".
// The shape is also how other bodies number their files, so it is read only
// near its own cue (PL_AUTHORITY_FILE_NUMBER_CUE_RE).
const PL_AUTHORITY_FILE_NUMBER_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\d.\-])(?<caseNumber>${PL_AUTHORITY_FILE_NUMBER_SOURCE})(?![\p{L}\d\-]|\.[\p{L}\d])`,
  "gu",
);

// National Appeal Chamber (KIO) dockets, joined ones included, from the same
// source the search grammar reads: "KIO 1234/24", "KIO/UZP 1188/08",
// "KIO 2845/25, KIO 2846/25". The all-caps mark is distinctive enough to
// read without a cue.
const PL_KIO_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\d])(?<caseNumber>${PL_KIO_DOCKET_SOURCE})(?!\d)`,
  "gu",
);

// A decision number of the competition and consumer protection authority,
// as a court or another decision cites it: "decyzji Prezesa UOKiK nr
// DOK-1/2020", "od decyzji Prezesa Urzędu Ochrony Konkurencji i Konsumentów
// z 29 lutego 2024 r. Nr DOZIK 3/2024". Its shape is shared with other
// bodies' file numbers, so it is read only near its own cue
// (PL_UOKIK_DECISION_CUE_RE).
const PL_UOKIK_DECISION_PATTERN = new RegExp(
  String.raw`(?<![${DECISION_DASH_CLASS_SOURCE}\p{L}\d])(?<caseNumber>${PL_UOKIK_CITED_DECISION_NUMBER_SOURCE})(?![${DECISION_DASH_CLASS_SOURCE}\p{L}\d/])`,
  "gu",
);

/** What marks a nearby decision number as the competition authority's. */
const PL_UOKIK_DECISION_CUE_RE =
  /\bUOKiK\b|Urz[ęe]d\p{L}*\s+Ochrony\s+Konkurencji|Ochrony\s+Konkurencji\s+i\s+Konsument/iu;

/** How far before a decision number its cue may sit. */
const PL_UOKIK_DECISION_CUE_WINDOW = 160;

/** What marks a nearby authority file number as the data protection authority's. */
const PL_AUTHORITY_FILE_NUMBER_CUE_RE =
  /znak\p{L}*\s+sprawy|\bUODO\b|Ochrony\s+Danych\s+Osobowych/iu;

// Polish bare-symbol pattern: other tribunals and disciplinary registries
// cite by a 1-3 letter symbol with no Roman-numeral chamber at all --
// "sygn. T. 20/97", "sygn. SNO 45/06" (Sąd Najwyższy disciplinary
// chamber), separated from the docket by the same bounded whitespace run
// as PL_TK_PATTERN. Anchored on the "sygn." (optionally "akt") prefix,
// unlike PL_TK_PATTERN, since these symbols are not on the closed
// Tribunal list and would otherwise be too collision-prone to match bare.
const PL_BARE_SYMBOL_PATTERN = new RegExp(
  String.raw`${PL_SYGN_PREFIX}(?<caseNumber>[A-Z]{1,3}\.?\s{0,3}\d{1,4}\/\d{2,4})(?!\d)`,
  "gu",
);

// Polish administrative courts (NSA/WSA): the registry carries the
// court's seat joined by a slash, e.g. "II SA/Wa 2016/05" (WSA
// Warszawa), "II SA/Łd 123/20" (WSA Łódź, a non-ASCII seat letter), or
// the older undivided registry from before the 2004 court reform,
// "SA/Po 4584/01" (no Roman division at all). The registry can't just add
// "/" to the generic alternation above without also swallowing the case
// number's own slash, so this is a dedicated pattern over the closed
// register and seat lists of the shared administrative docket grammar. A
// Roman numeral before the register that the grammar does not take as the
// division, a ninth one ("IX SA/Wa") or one past a wide gap ("II      SA/Wa"),
// rejects the match rather than leaving a docket with its division cut off.
const PL_NSA_WSA_PATTERN = new RegExp(
  String.raw`(?:${PL_SYGN_PREFIX})?(?<!\b[IVX]+\s+)\b(?<caseNumber>${PL_ADMINISTRATIVE_SEATED_DOCKET_SOURCE})(?!\d)`,
  "gu",
);

// The pre-2004 seatless Warsaw form, including a joined range of numbers
// the bare Polish pattern does not read ("I SA 1234-1236/98"). The range
// stays one citation keyed with both ends, as a consolidated Czech docket
// does ("36 Co 52,53/2023").
const PL_NSA_SEATLESS_PATTERN = new RegExp(
  String.raw`(?:${PL_SYGN_PREFIX})?\b(?<caseNumber>${PL_ADMINISTRATIVE_SEATLESS_DOCKET_SOURCE})(?!\d)`,
  "gu",
);

// Pre-2004 NSA resolutions cited bare, with no division: "FPS 1/99",
// "OPS 3/98". The lookbehind leaves a divided mark ("I OPS 3/22") to the
// bare Polish pattern, so its tail is not read as a second citation.
const PL_NSA_PRE_REFORM_RESOLUTION_PATTERN = new RegExp(
  String.raw`(?<!\b[IVX]+\s+)\b(?<caseNumber>${PL_ADMINISTRATIVE_PRE_REFORM_RESOLUTION_SOURCE})(?!\d)`,
  "gu",
);

/**
 * Czech registries whose mark stands alone, with no senate number in front:
 * "sp. zn. Nt 408/2023" (criminal auxiliary), "sp. zn. A 9/2003" (pre-2003
 * administrative), "č.j. Nad 224/2014" (delegation/jurisdiction disputes),
 * "č.j. Konf 4/2011-12" (jurisdiction-conflict panel).
 *
 * These two are the only patterns whose capture is a bare letter run with no
 * senate number, which is also the shape of an agency file number under the
 * same label: a ministry writes "č. j. MZDR 6206/2025" exactly as a court
 * writes a docket. The prefix alone therefore does not make a capture a case
 * number, so a capture from either pattern is put to the Czech docket grammar
 * and dropped when it does not parse (`CZE_GATED_PATTERNS` below). The "Spr"
 * exclusion stays in the pattern: the court-administration agenda is a real
 * docket the grammar accepts, and it is not adjudication.
 */
const CZ_SP_ZN_LETTER_FIRST_PATTERN =
  /sp\.\s*zn\.:?\s*(?![Ss][Pp][Rr]\.?\s)(?<caseNumber>\p{L}{1,4}\.?\s+\d{1,6}\/\d{2,4})(?!\d)/gu;

const CZ_FILE_NUMBER_LETTER_FIRST_PATTERN = new RegExp(
  String.raw`${CZ_FILE_NUMBER_PREFIX_SOURCE}(?<caseNumber>\p{L}{1,6}\s+\d{1,6}\/\d{2,4})(?!\d)`,
  "gu",
);

/**
 * Patterns whose capture only counts as a citation when the Czech docket
 * grammar reads it as a docket. Holds the pattern objects themselves, not
 * copies of their sources, so the gate cannot come to name a pattern that no
 * longer exists or miss one that does.
 */
const CZE_GATED_PATTERNS: ReadonlySet<RegExp> = new Set([
  CZ_SP_ZN_LETTER_FIRST_PATTERN,
  CZ_FILE_NUMBER_LETTER_FIRST_PATTERN,
]);

const CITATION_PATTERNS: RegExp[] = [
  // Czech/Slovak case number: "sp. zn. 21 Cdo 1234/2020", "sp. zn.
  // 33 Cb/209/2010", "sp.zn.: 38Csp/281/2025", "sp. zn 5Obdo/23/2016" (no
  // period after "zn"). Two-digit years ("2 Cdon 808/97", "8Co/431/97")
  // are the standard form for pre-2000 decisions; the resolver owns
  // century mapping.
  new RegExp(String.raw`sp\.\s*zn\.?:?\s*${CASE_NUMBER_BODY}`, "gu"),

  // Slovak Supreme Court extraordinary-review / grand-chamber panel: "sp.
  // zn. 4 M Cdo 15/2010", "sp. zn. 2 M Obdo 1/2008", where "M"
  // (mimoriadne dovolanie / veľký senát) sits between the chamber digit
  // and the ordinary registry as its own word -- one word more than
  // CASE_NUMBER_BODY allows. The period after "zn" is optional, matching
  // the general sp. zn. pattern above ("sp. zn 4 M Cdo 15/2010").
  /sp\.\s*zn\.?:?\s*(?<caseNumber>\d{1,3}\s+M\s+\p{L}{1,6}\s+\d{1,6}\/\d{2,4})(?!\d)/gu,

  // Slovak Special Court (Špeciálny súd v Pezinku, 2004-2009) case numbers
  // carry a "PK" panel prefix before the ordinary senate/registry/number
  // shape: "sp. zn. PK 1 Tš 24/2006". The period after "zn" is optional,
  // matching the general sp. zn. pattern above.
  /sp\.\s*zn\.?:?\s*(?<caseNumber>PK\s+\d{1,3}\s+\p{L}{1,6}\s+\d{1,6}\/\d{2,4})(?!\d)/gu,

  // Slovak Najvyšší súd hyphenated administrative registry code: "sp. zn.
  // 5 Sž-o-KS 94/2005" (appellate senates chain short letter groups with
  // hyphens; the plain-letter registry in CASE_NUMBER_BODY excludes them).
  // The period after "zn" is optional, matching the general sp. zn.
  // pattern above.
  /sp\.\s*zn\.?:?\s*(?<caseNumber>\d{1,3}\s+\p{L}{1,4}(?:-\p{L}{1,4}){1,3}\s+\d{1,6}\/\d{2,4})(?!\d)/gu,

  // Slovak courthouse workplace-code prefix (post-2023 court reform): "sp.
  // zn. B4-14Cb/13/2021", "sp. zn. K2-17P/72/2022" (Mestský súd) -- a
  // branch letter+digits, hyphen, then the ordinary joined chamber+
  // registry/case/year shape. The period after "zn" is optional, matching
  // the general sp. zn. pattern above.
  /sp\.\s*zn\.?:?\s*(?<caseNumber>[A-Z]\d{1,2}-\d{1,3}\p{L}{1,5}\/\d{1,6}\/\d{2,4})(?!\d)/gu,

  // Czech senate file number: "sen. zn. 29 NSČR 55/2013" (grand panel,
  // insolvency). Same shape as sp. zn. under a different prefix.
  new RegExp(String.raw`sen\.\s*zn\.:?\s*${CASE_NUMBER_BODY}`, "gu"),

  CZ_SP_ZN_LETTER_FIRST_PATTERN,

  // Czech Supreme Court plenary/collegium opinions ("stanoviska"), civil
  // (Cpjn) and criminal (Tpjn), are routinely cited bare after the first
  // mention, without a "sp. zn." prefix: "stanovisko ... Cpjn 203/2010,
  // uveřejněné pod č. 50/2011". Narrowly scoped to these two registries so
  // it does not turn into a generic bare-citation matcher.
  /\b(?<caseNumber>[CT]pjn\s+\d{1,4}\/\d{4})(?!\d)/gu,

  // Constitutional Courts: "IV. ÚS 23/05", "Pl. ÚS 12/94" (Czech, with a
  // dot after the senate numeral), "III ÚS 154/2011" (Slovak, without
  // one), "II.ÚS/251/04" (Slovak case-list shorthand with a slash instead
  // of a space), "III.US 364/2017" (diacritic dropped, likely an encoding
  // fallback), "PL ÚS 11/2016" (Slovak all-caps plenum spelling), and
  // "Pl. ÚS-st. 45/16" / "Pl. ÚS‑st. 45/16" (non-breaking hyphen) /
  // "Pl. ÚS – st. 59/23" (a binding plenary standpoint, not an ordinary
  // ruling, marked with a "-st." infix, dash spelling and spacing both
  // bounded and variable). The senate is a Roman numeral (or Pl./PL for
  // the plenum) directly before it, so ordinary prose about the United
  // States never has this shape; the digit-led pattern above never
  // matches these either way. The bare form also covers the "sp. zn.
  // IV. ÚS 23/05" spelling.
  new RegExp(
    String.raw`\b(?<caseNumber>(?:[IVX]{1,4}|Pl|PL)\.?\s*${US_MARK_SOURCE}(?:\s{0,3}[${CITATION_DASH_CLASS}]\s{0,3}st\.)?[\s/]+\d{1,5}\/\d{2,4})(?!\d)`,
    "gu",
  ),

  // CJEU: "C-283/81", "T-13/99", "F-100/09" (Court of Justice, General
  // Court, Civil Service Tribunal), including the non-breaking hyphen the
  // publications office uses ("C‑283/81"), the en/em dash normalizeDashes
  // already canonicalizes for the dedup key ("C–128/22"), the soft hyphen
  // (U+00AD) a PDF-to-text conversion leaves behind at a line-wrap
  // boundary ("C­472/11", invisible when rendered), and OCR/typo spacing
  // around the separator seen in prod text for the same case ("C- 679/18",
  // "C -679/18"), bounded to a few characters so a stray long whitespace
  // run does not leak into the stored citation text. The separator itself
  // is never dropped: a bare "C679/18" would collide with the Czech civil
  // "C" registry ("21 C 1234/2020"), so it is intentionally out of scope
  // (see the module-level exclusion list). The year is two or four digits:
  // the Court numbers its own cases with a two-digit year ("C-254/18"), but
  // national courts routinely write the year out when citing them ("C-
  // 610/2017", "C-254/2018"), and a two-digit-only year drops those
  // citations entirely rather than truncating them -- the trailing
  // digit guard rejects the whole match once a third digit follows. Three-
  // and five-digit years stay unmatched (the optional block is a pair, not
  // a range), so a longer number cannot match a shortened prefix of itself.
  new RegExp(
    String.raw`\b(?<caseNumber>[CTF]\s{0,3}[${CITATION_DASH_CLASS}]\s{0,3}\d{1,4}\/\d{2}(?:\d{2})?)(?!\d)`,
    "gu",
  ),

  // ECLI: "ECLI:CZ:NS:2020:21.CDO.1234.2020.1". The court code is
  // alphanumeric, not letters-only: Slovak courts that exist several times
  // in one city number the duplicates, and the number is part of the code
  // ("ECLI:SK:OSKE1:2018:7117220342.4" for Okresný súd Košice I). A
  // letters-only class drops the whole numbered-court family silently.
  // Requiring a leading letter keeps a missing code from letting the year
  // stand in for one.
  /ECLI:[A-Z]{2}:[A-Z][A-Z\d]{0,7}:\d{4}:[\w.]+/gu,

  // CJEU judgments cite their own case-law with the ECLI suffix only,
  // dropping the "ECLI:" literal: "C‑156/21, EU:C:2022:97", "60/81,
  // EU:C:1981:264". This is the form the Court's own text actually uses
  // (the literal "ECLI:" prefix above appears in database identifiers,
  // not in judgment prose), so it is captured as its own citation
  // regardless of whether a case number precedes it. The CJEU's own ECLI
  // country code is "EU" ("ECLI:EU:C:2020:123"), so without the negative
  // lookbehind this would also match the tail of a full ECLI already
  // captured by the pattern above, producing two entries for one
  // identifier.
  /(?<!ECLI:)\bEU:[CTF]:\d{4}:\d+\b/gu,

  // Pre-1989 CJEU case numbers carry no C-/T- prefix (the Court introduced
  // it in 1989): "60/81", or joined as "169/83 e 136/84" / "15/76 and
  // 16/76". A bare number/year pair is too collision-prone on its own (it
  // also matches directive numbers like "65/65/EEC" and report numbers
  // like "1/96"), so it is only captured when the ECLI-suffix pattern
  // above follows immediately, which no directive or report number ever
  // has. The negative lookbehind stops this from also re-matching the
  // bare tail of an already-prefixed number ("T‑381/15" must not also
  // yield a phantom "381/15"), including every separator spelling the
  // CJEU C/T/F pattern above tolerates: spaced ("C- 679/18" must not also
  // yield a phantom "679/18"), en/em dash ("C–128/22" must not also yield
  // a phantom "128/22"), and soft hyphen ("C­128/22" must not also yield a
  // phantom "128/22").
  new RegExp(
    String.raw`(?<![CTF]\s{0,4}[${CITATION_DASH_CLASS}]\s{0,4})\b(?<caseNumber>\d{1,4}\/\d{2})(?!\d)(?=[\s,]*(?:(?:and|e)\s+\d{1,4}\/\d{2}(?!\d)[\s,]*)?EU:[CTF]:\d{4}:\d+)`,
    "gu",
  ),

  // Czech collection: "č. 123/2020 Sb. rozh. tr." (Nejvyšší soud, civil or
  // criminal) or "č. 2018/2010 Sb. NSS" (Nejvyšší správní soud, a
  // different court's collection). "NSS" must be tried before "NS", or
  // the alternation matches the "NS" prefix and truncates the extracted
  // text to the wrong court's abbreviation.
  new RegExp(CZECH_REPORTER_CITATION_SOURCE, "gu"),

  // Constitutional Court rulings by their Sbírka zákonů number, read only
  // after the ruling is named: "ve znění nálezu Ústavního soudu č. 234/2002
  // Sb.", "nálezem sp. zn. Pl. ÚS 18/01, vyhlášeným pod č. 234/2002 Sb.". The
  // match is the number alone, so every later mention of it is marked too.
  new RegExp(
    String.raw`(?<=${CZ_US_GAZETTE_LEAD_SOURCE})${CZ_US_GAZETTE_SOURCE}(?!\s*(?:NSS|NS|rozh\.|m\.\s*s\.))`,
    "gu",
  ),

  // Constitutional Court rulings by their Sbírka nálezů a usnesení entry:
  // "N 53/26 SbNU 73", "svazek 7, nález č. 13".
  new RegExp(CZ_US_REPORT_SOURCE, "gu"),
  new RegExp(CZ_US_REPORT_VOLUME_SOURCE, "gu"),

  // Generic: "rozsudek č.j. 5 As 123/2020"; registrars also write "č. j.:
  // 137 Ex 1850/23", administrative senates glue the digit straight to
  // the registry letter ("6A 242/2016", "9Afs 44/2011", "2T 190/2017"),
  // and consolidated proceedings join two case numbers with a comma
  // before the shared year ("36 Co 52,53/2023", "27 Co 116, 119/2007").
  new RegExp(
    String.raw`${CZ_FILE_NUMBER_PREFIX_SOURCE}${CASE_NUMBER_BODY_COMMA}`,
    "gu",
  ),

  CZ_FILE_NUMBER_LETTER_FIRST_PATTERN,

  // Insolvency filings cite another court's case with that court's own
  // registry code before the docket: "č. j. KSCB 26 INS 8270/2018"
  // (Krajský soud v Českých Budějovicích), "č. j. KSHK 33 INS
  // 21809/2019" (Krajský soud v Hradci Králové). The code stays inside
  // the caseNumber capture rather than being a stripped label, because
  // insolvency docket numbers are unique only within the issuing court:
  // dropping the code would fold two different courts' cases into one
  // dedup key whenever they happen to share a senate/registry/docket/
  // year. The code is a bounded 2-5 letter uppercase run so it cannot
  // swallow ordinary prose before an unprefixed case number.
  new RegExp(
    String.raw`${CZ_FILE_NUMBER_PREFIX_SOURCE}(?<caseNumber>[A-Z]{2,5}\s{1,3}\d{1,3}\s{0,3}\p{L}{1,6}[\s/]{1,3}\d{1,6}(?:[,/]\s{0,3}\d{1,6})?\/\d{2,4})(?!\d)`,
    "gu",
  ),

  // Slovak file number: "č. k. 4 Obo 48/02" (číslo konania), the Slovak
  // counterpart to the Czech č. j. above. Lower-court Slovak decisions are
  // sometimes cited only by this file number, with no accompanying sp.
  // zn. form, so without this pattern the citation is dropped entirely.
  new RegExp(String.raw`[čc]\.\s*k\.:?\s*${CASE_NUMBER_BODY}`, "gu"),

  PL_PREFIXED_PATTERN,
  PL_THREE_TOKEN_PATTERN,
  PL_TK_PATTERN,
  PL_TK_BARE_PATTERN,
  PL_TK_CUED_PATTERN,
  PL_AUTHORITY_FILE_NUMBER_PATTERN,
  PL_UOKIK_DECISION_PATTERN,
  PL_KIO_PATTERN,
  PL_BARE_SYMBOL_PATTERN,
  PL_NSA_WSA_PATTERN,
  PL_NSA_SEATLESS_PATTERN,
  PL_NSA_PRE_REFORM_RESOLUTION_PATTERN,

  // Polish case number without prefix: "II CSK 123/20", "II ACa 45/20",
  // "I CSK 379/08" (Supreme Court chambers I-VII are frequently a single
  // Roman digit, and such bare citations -- no "sygn. akt" -- are the
  // normal way one decision cites another in its reasoning), "IIIU
  // 1113/13" (labor/social-insurance division glued to the roman numeral
  // with no space, only ever a single uppercase letter in that glued
  // shape). The spaced division code is an uppercase chamber code (CSK,
  // KK, CSKP) or an uppercase code with an appellate suffix (ACa, ACz,
  // AKa); requiring that shape (and requiring a space before a
  // multi-purpose single letter) stops ordinary mixed-case prose like
  // "Article XV See 12/20" from being captured as a phantom citation. The
  // gap before a multi-letter division is bounded (1-3 characters, not
  // unbounded `\s+`), matching PL_TK_PATTERN/PL_TK_BARE_PATTERN's
  // phantom-duplicate lookbehind exactly: this bare (no "sygn.") form
  // combines a Tribunal-symbol-shaped division ("II SK 12/20") into one
  // citation the same way the prefixed pattern does, so it must stop
  // combining beyond the same gap the lookbehind can still recognize, or
  // the symbol at the tail phantom-duplicates as a second citation.
  /\b[IVX]{1,4}(?:\s{1,3}(?:[A-Z]{2,5}|[A-Z]{1,4}[az])|[A-Z])\s+\d{1,6}\/\d{2,4}\b/gu,

  // Hungarian court docket: "Pfv.III.20.123/2019/5", "5.Gf.40.014/2023/15".
  // No leading letter, digit or dot, so the match starts at the panel number
  // when there is one rather than at the registry after it. Nothing may follow
  // the document number that would make it part of a longer token: a
  // prosecutor's file shares the shape and adds a dashed suffix
  // ("Bf.90/2009/1-I.").
  new RegExp(
    String.raw`(?<![\p{L}\d.])(?<caseNumber>${HU_DOCKET_SOURCE})(?![${CITATION_DASH_CLASS}\d/])`,
    "gu",
  ),

  new RegExp(HU_REPORTER_CITATION_SOURCE, "gu"),
  new RegExp(HU_UNIFORMITY_SOURCE, "gu"),
  new RegExp(HU_UNIFORMITY_SERIES_FIRST_SOURCE, "gu"),
  new RegExp(HU_OPINION_SOURCE, "gu"),
  new RegExp(HU_OPINION_SERIES_FIRST_SOURCE, "gu"),
  new RegExp(HU_CONSTITUTIONAL_SOURCE, "gu"),

  // Neutral citations: bracketed year, one to three court/division tokens,
  // then the decision number (for example "[2024] Example Court 12"). The
  // bracketed year and final number keep this narrower than an ordinary
  // title or parenthetical date.
  /\[\d{4}\]\s+[A-Z][A-Za-z]{1,9}(?:\s+[A-Z][A-Za-z]{1,9}){0,2}\s+\d{1,6}\b/gu,
];

const DASH_RE = new RegExp(`[${DECISION_DASH_CLASS_SOURCE}]`, "gu");

/**
 * The publications office typesets CJEU numbers with U+2011 or an em/en
 * dash; the corpus stores the ASCII form. Comparisons and dedup keys must
 * not treat the different spellings as different citations.
 */
const normalizeDashes = (text: string): string => text.replace(DASH_RE, "-");

/**
 * Matches a Czech/Slovak numeric-first case number after whitespace and
 * dot normalization, splitting it into its three components so the dedup
 * key can rebuild them with one canonical separator.
 */
const SEPARATOR_NORMALIZE_RE =
  /^(?<number>\d{1,3})\s?(?<registry>\p{L}{1,6})[\s/](?<docket>\d{1,6}\/\d{2,4})$/u;

/**
 * Matches a Czech/Slovak numeric-first case number whose docket joins a
 * second consolidated docket, comma- or slash-separated, sharing the
 * trailing year ("52,53/2023" or "52/53/2023"), after whitespace/comma
 * normalization. The dedup key always rebuilds the join with a comma,
 * regardless of the source separator, so "36 Co 52,53/2023" and
 * "36 Co 52/53/2023" resolve to one key.
 */
const CONSOLIDATED_DOCKET_NORMALIZE_RE =
  /^(?<number>\d{1,3})\s?(?<registry>\p{L}{1,6})[\s/](?<docket1>\d{1,6})[,/](?<docket2>\d{1,6})\/(?<year>\d{2,4})$/u;

/**
 * Matches a court-code-prefixed Czech numeric-first case number (the
 * insolvency "KSCB 26 INS 8270/2018" shape) after whitespace and dot
 * normalization, splitting off the issuing court's registry code so the
 * dedup key can rebuild the numeric body with one canonical separator
 * while keeping the code itself: it is what makes the docket unique to
 * begin with (rule 17), not a label to strip. "KSCB 26 INS 8270/2018"
 * and "KSCB 26INS/8270/2018" must resolve to the same key. Case-
 * insensitive: this normalizer also runs on a decision's own stored
 * `caseNumber` (via `isSelfCitation`), which is publisher text, not
 * extractor output, so it is never guaranteed to carry the extractor's
 * all-uppercase code spelling ("Msph" vs "MSPH"). The final
 * `.toLowerCase()` on the assembled key already folds the casing, so
 * matching case-insensitively here is enough -- no need to normalize
 * the captured code itself. The registry-to-docket gap accepts a 1-3
 * character run of the extraction pattern's own `[\s/]{1,3}` class, not
 * a single character: the generic whitespace-around-a-slash cleanup
 * above strips space adjacent to each slash but never merges adjacent
 * slashes themselves, so a repeated-slash OCR artifact ("INS//8270")
 * survives as literal "//" into this regex.
 */
const COURT_CODE_NORMALIZE_RE =
  /^(?<code>[A-Z]{2,5})\s(?<number>\d{1,3})\s?(?<registry>\p{L}{1,6})[\s/]{1,3}(?<docket>\d{1,6}\/\d{2,4})$/iu;

/**
 * Matches a court-code-prefixed case number whose docket joins a second
 * consolidated docket, comma- or slash-separated, sharing the trailing
 * year -- the same join the court-code-prefixed extraction pattern
 * accepts (mirroring CASE_NUMBER_BODY_COMMA), now with the issuing
 * court's registry code in front: "KSCB 26 INS 8270,8271/2018" and
 * "KSCB 26 INS 8270/8271/2018" resolve to one key. Same 1-3 character
 * registry-to-docket gap as `COURT_CODE_NORMALIZE_RE`, for the same
 * repeated-slash reason.
 */
const COURT_CODE_CONSOLIDATED_NORMALIZE_RE =
  /^(?<code>[A-Z]{2,5})\s(?<number>\d{1,3})\s?(?<registry>\p{L}{1,6})[\s/]{1,3}(?<docket1>\d{1,6})[,/](?<docket2>\d{1,6})\/(?<year>\d{2,4})$/iu;

/**
 * Matches a Czech/Slovak Constitutional Court case number (chamber,
 * "ÚS" or the diacritic-dropped "US", optional plenary "-st." infix,
 * then the docket) after whitespace/dot normalization, so the dedup key
 * can rebuild it with one canonical (glued, diacritic-restored) spelling:
 * "II.ÚS/251/04", "II.ÚS 251/04", and "II. ÚS 251/04" (the dot before
 * a space is already stripped upstream) all resolve to the same key, and
 * the diacritic-dropped "III.US 364/2017" folds to the same key as
 * "III. ÚS 364/2017". Stored citationText is never touched by this --
 * only the dedup key folds the diacritic.
 *
 * The infix's own trailing dot is optional ("-st\.?", not "-st\."): the
 * upstream trailing-dot-strip step (below) also fires on "t." when it is
 * itself followed by whitespace or a slash (as it always is here, right
 * before the docket), so the dot is already gone by the time this regex
 * runs for most spellings. Requiring it literally would make the infix
 * fail to match and silently fall through to the plain (non-standpoint)
 * reconstruction, colliding a plenary standpoint with an ordinary nález
 * sharing the same digits.
 */
const US_CASE_RE =
  /^(?<chamber>[IVX]{1,4}|Pl|PL)\.?\s?[ÚU]S(?<infix>-st\.?)?[\s/](?<docket>\d{1,5}\/\d{2,4})$/u;

/**
 * Matches a Polish roman-numeral-chamber case number after whitespace
 * normalization, splitting off the chamber from the division code so the
 * dedup key can rebuild the boundary with one canonical (glued) spelling:
 * "IC 1523/96" (glued) and "I C 1523/96" (spaced) must share one key. The
 * space before the division's own docket is likewise optional, so a
 * division glued directly to the docket ("IV P648/03") still matches,
 * alongside the spaced form ("IV P 648/03").
 */
const POLISH_ROMAN_DIVISION_RE =
  /^(?<roman>[IVX]{1,6})\s?(?<division>[A-Za-z]{1,5}\s?.*)$/u;

/**
 * Some Polish division codes are themselves two tokens separated by a
 * space or a slash (an appellate/labor qualifier plus the base code, e.g.
 * "A Ua" or "A/Ua"), which courts also glue together ("AUa"). Applied to
 * the `division` group of `POLISH_ROMAN_DIVISION_RE`, this collapses the
 * first two-token gap to the same glued spelling so "III A Ua 2389/02",
 * "III A/Ua 2389/02", and "III AUa 2389/02" all resolve to one dedup key.
 * The second token is a letter run, never digits, so this never matches
 * an ordinary single-token division directly followed by the docket
 * number ("CSK 123/20"). The second token is any letter run, so an
 * administrative court's non-ASCII seat folds the same way ("II SA/Łd
 * 123/20" keys as "iisałd 123/20", like "II SA/Wa" as "iisawa").
 */
const POLISH_TWO_WORD_DIVISION_RE =
  /^(?<div1>[A-Za-z]{1,4})[\s/](?<div2>\p{L}{1,5})(?<rest>\s\d.*)$/u;

/**
 * Matches a single-token Polish division code directly followed by the
 * docket, glued or separated by a space ("P648/03" vs "P 648/03"),
 * within the `division` group of `POLISH_ROMAN_DIVISION_RE`. Only tried
 * once the two-token check above has failed. Reconstructs with one space
 * regardless of the source spacing, so "sygn. akt: IV P648/03" and
 * "sygn. akt IV P 648/03" resolve to one dedup key.
 */
const POLISH_LETTERS_DOCKET_RE =
  /^(?<letters>[A-Za-z]{1,5})\s?(?<docket>\d.*)$/u;

/**
 * A Hungarian docket's key: registry, register number, year and document,
 * in the spelling the publisher's listing stores as the case number
 * (`Gfv.30091/2025/4`).
 *
 * The panel number, the panel numeral and the thousands dot are how the
 * courts print the same number (`Gfv.VI.30.091/2025/4`): the listing drops
 * them, so they are not part of the file's identity, and a key that kept them
 * would miss every decision whose citation spells the docket the way the
 * courts do. The key of a listed case number is the lowercased case number
 * itself, which is what `citation_key` and the case-number identifier rows
 * already hold. The document number stays: the listing keys each decision by
 * it, and it is what tells the decisions of one file apart.
 */
const hungarianDocketKey = (parts: RegExpGroups): string =>
  `${requiredGroup(parts, "registry")}.${requiredGroup(parts, "register").replace(".", "")}/${requiredGroup(parts, "year")}/${requiredGroup(parts, "document")}`.toLowerCase();

/**
 * Collapse spelling variants that would otherwise fracture one real
 * citation into several dedup keys:
 *  - soft hyphens (U+00AD) and NBSP (U+00A0), both seen in the corpus
 *    from PDF text extraction, never load-bearing;
 *  - whitespace runs, including a line-wrap newline landing inside a
 *    matched span ("21\nCdo 1234/2020" vs "21 Cdo 1234/2020");
 *  - whitespace around a hyphen ("C - 679/18", "C- 679/18" -> "C-679/18",
 *    "ÚS – st." -> "ÚS-st.");
 *  - whitespace around a slash ("U 1 /86" -> "U 1/86");
 *  - whitespace after a comma in a consolidated docket ("52, 53/2023" ->
 *    "52,53/2023");
 *  - a trailing dot on a registry abbreviation ("Spr." vs "Spr", "K." vs
 *    "K");
 *  - letter-case differences between an all-caps header and body text;
 *  - the separator between a case's registry code and its docket number,
 *    which filings write as a space or a slash interchangeably ("5 Cdo
 *    260/2008" vs "5Cdo/260/2008", "10C 84/97" vs "10C/84/97", "6CoE
 *    14/2007" vs "6 CoE 14/2007" vs "6CoE/14/2007"), including when a
 *    court registry code leads the number ("KSCB 26 INS 8270/2018" vs
 *    "KSCB 26INS/8270/2018"), including a court-code-prefixed
 *    consolidated docket join ("KSCB 26 INS 8270,8271/2018" vs "KSCB 26
 *    INS 8270/8271/2018");
 *  - the boundary between a Polish roman-numeral chamber and its division
 *    code, glued or spaced ("IC 1523/96" vs "I C 1523/96"), including a
 *    two-token division code ("III A Ua 2389/02" vs "III AUa 2389/02") and
 *    the division-to-docket join ("IV P648/03" vs "IV P 648/03");
 *  - the dot/space/slash boundary and diacritic in a Constitutional Court
 *    citation ("II.ÚS/251/04", "II.ÚS 251/04", "II. ÚS 251/04", and the
 *    diacritic-dropped "III.US 364/2017" all fold to one key);
 *  - the join between two consolidated docket numbers, comma- or
 *    slash-separated ("36 Co 52,53/2023" vs "36 Co 52/53/2023");
 *  - a Hungarian docket's panel number, panel numeral and thousands dot
 *    ("5.Pf.III.20.123/2019/4" vs "Pf.20123/2019/4"); see
 *    `hungarianDocketKey`;
 *  - the spellings of one Hungarian uniformity decision, opinion or reporter
 *    entry ("4/2021. PJE" vs "4.2021.PJE", "EBH 2018.K.17." vs
 *    "EBH.2018.K.17"); see `hungarianSeriesKey`.
 */
const canonicalizeDedupKey = (text: string): string => {
  const normalized = normalizeDashes(text)
    // One key per case, whatever normalization form the publisher served:
    // a decomposed "Ú" is the same letter as a precomposed one, and only
    // the key folds it -- `citationText` stays verbatim so the reader can
    // still find it in the document's own characters.
    .normalize("NFC")
    .replace(/­/gu, "") // soft hyphen: invisible, never load-bearing
    .replace(/\u00A0/gu, " ") // NBSP -> space
    .replace(/\s+/gu, " ") // collapse line-wraps and repeated spaces
    .replace(/\s{0,4}-\s{0,4}/gu, "-") // collapse whitespace around a hyphen
    .replace(/\s{0,4}\/\s{0,4}/gu, "/") // collapse whitespace around a slash
    .replace(/,\s{0,3}/gu, ",") // "52, 53/2023" -> "52,53/2023"
    .trim();
  // A leading `N/` some registers print ahead of an administrative docket
  // ("12/II SA/Po 1234/99") is not part of it.
  const spaced = polishAdministrativeDocketOf(normalized) ?? normalized;

  // Read before the registry dot is stripped below: in a Hungarian docket
  // that dot is the separator ("Pfv. 20.187/2017/12").
  const hungarian = HU_DOCKET_PARTS_RE.exec(spaced)?.groups;
  if (hungarian !== undefined) {
    return hungarianDocketKey(hungarian);
  }
  const hungarianSeries = hungarianSeriesKey(spaced);
  if (hungarianSeries !== null) {
    return hungarianSeries;
  }
  // A Tribunal docket's dot is not part of it, glued ("K.2/19") or spaced.
  // `KIO/UZP` and `KIO UZP` are one register, as the search grammar keys it.
  const kio = polishKioDocketKey(spaced);
  if (kio !== null) {
    return kio;
  }
  const constitutional = polishConstitutionalDocketKey(spaced);
  if (constitutional !== null) {
    return constitutional;
  }

  const cleaned = spaced
    .replace(/(\p{L})\.(?=[\s/]|$)/gu, "$1") // "Spr." / "K." -> "Spr" / "K"
    .trim();

  const numeric = SEPARATOR_NORMALIZE_RE.exec(cleaned);
  if (numeric?.groups) {
    const canonical = `${requiredGroup(numeric.groups, "number")}${requiredGroup(numeric.groups, "registry")}/${requiredGroup(numeric.groups, "docket")}`;
    return canonical.toLowerCase();
  }

  const consolidated = CONSOLIDATED_DOCKET_NORMALIZE_RE.exec(cleaned);
  if (consolidated?.groups) {
    const canonical = `${requiredGroup(consolidated.groups, "number")}${requiredGroup(consolidated.groups, "registry")}/${requiredGroup(consolidated.groups, "docket1")},${requiredGroup(consolidated.groups, "docket2")}/${requiredGroup(consolidated.groups, "year")}`;
    return canonical.toLowerCase();
  }

  const courtCode = COURT_CODE_NORMALIZE_RE.exec(cleaned);
  if (courtCode?.groups) {
    const canonical = `${requiredGroup(courtCode.groups, "code")} ${requiredGroup(courtCode.groups, "number")}${requiredGroup(courtCode.groups, "registry")}/${requiredGroup(courtCode.groups, "docket")}`;
    return canonical.toLowerCase();
  }

  const courtCodeConsolidated =
    COURT_CODE_CONSOLIDATED_NORMALIZE_RE.exec(cleaned);
  if (courtCodeConsolidated?.groups) {
    const canonical = `${requiredGroup(courtCodeConsolidated.groups, "code")} ${requiredGroup(courtCodeConsolidated.groups, "number")}${requiredGroup(courtCodeConsolidated.groups, "registry")}/${requiredGroup(courtCodeConsolidated.groups, "docket1")},${requiredGroup(courtCodeConsolidated.groups, "docket2")}/${requiredGroup(courtCodeConsolidated.groups, "year")}`;
    return canonical.toLowerCase();
  }

  const usCase = US_CASE_RE.exec(cleaned);
  if (usCase?.groups) {
    const canonical = `${requiredGroup(usCase.groups, "chamber")}ÚS${usCase.groups["infix"] ?? ""}${requiredGroup(usCase.groups, "docket")}`;
    return canonical.toLowerCase();
  }

  const romanDivision = POLISH_ROMAN_DIVISION_RE.exec(cleaned);
  const roman = romanDivision?.groups?.["roman"];
  const divisionRaw = romanDivision?.groups?.["division"];
  if (roman !== undefined && divisionRaw !== undefined) {
    const twoWord = POLISH_TWO_WORD_DIVISION_RE.exec(divisionRaw)?.groups;
    if (
      twoWord?.["div1"] !== undefined &&
      twoWord["div2"] !== undefined &&
      twoWord["rest"] !== undefined
    ) {
      const division = `${twoWord["div1"]}${twoWord["div2"]}${twoWord["rest"]}`;
      return `${roman}${division}`.toLowerCase();
    }

    const lettersDocket = POLISH_LETTERS_DOCKET_RE.exec(divisionRaw)?.groups;
    const division =
      lettersDocket?.["letters"] !== undefined &&
      lettersDocket["docket"] !== undefined
        ? `${lettersDocket["letters"]} ${lettersDocket["docket"]}`
        : divisionRaw;
    return `${roman}${division}`.toLowerCase();
  }

  const canonical = cleaned;

  return canonical.toLowerCase();
};

type DecisionMetadata = {
  caseNumber: string;
  ecli?: string | null;
  identifiers?: DecisionIdentifiers | undefined;
};

type StoredDecisionMetadata = {
  caseNumber: string;
  ecli: string | null;
  metadata: Record<string, unknown>;
};

const PUBLISHER_CASE_NUMBER_ALIASES_METADATA_KEY = "additionalCaseNumbers";

export const decisionIdentifiersFromMetadata = ({
  caseNumber,
  ecli,
  identifiers,
}: DecisionMetadata): DecisionIdentifiers => {
  const caseNumberIdentifier = {
    type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
    value: caseNumber,
  } as const;

  const candidates: DecisionIdentifier[] = [
    caseNumberIdentifier,
    ...(ecli
      ? [{ type: DECISION_IDENTIFIER_TYPES.ECLI, value: ecli } as const]
      : []),
  ];
  if (identifiers !== undefined) {
    candidates.push(...identifiers);
  }
  const normalizedCaseNumber =
    normalizeDecisionIdentifier(caseNumberIdentifier);
  if (!normalizedCaseNumber) {
    throw new UnpersistableDecisionFieldError({
      message: "Decision case number has no searchable content",
      field: UNPERSISTABLE_DECISION_FIELDS.IDENTIFIER,
    });
  }
  const seen = new Set([
    `${caseNumberIdentifier.type}:${normalizedCaseNumber}`,
  ]);
  const additional = candidates.slice(1).filter((identifier) => {
    const normalized = normalizeDecisionIdentifier(identifier);
    if (!normalized) {
      return false;
    }
    const key = `${identifier.type}:${normalized}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  if (additional.length >= DECISION_IDENTIFIER_MAX_COUNT) {
    throw new UnpersistableDecisionFieldError({
      message: "Decision has too many identifiers",
      field: UNPERSISTABLE_DECISION_FIELDS.IDENTIFIER_COUNT,
    });
  }
  return [caseNumberIdentifier, ...additional];
};

/** Every independently citable Czech reporter reference in a composite label. */
export const czechReporterIdentifiersFromCitationLabel = (
  citation: string,
): DecisionIdentifiers | null => {
  const values = citation.match(
    new RegExp(CZECH_REPORTER_CITATION_SOURCE, "giu"),
  );
  if (values === null) {
    return null;
  }
  const [first, ...rest] = values;
  return [
    {
      type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
      value: first,
    },
    ...rest.map((value) => ({
      type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
      value,
    })),
  ];
};

const expandCompositeReporterIdentifier = (
  identifier: DecisionIdentifier,
): readonly DecisionIdentifier[] => {
  if (identifier.type !== DECISION_IDENTIFIER_TYPES.REPORTER_CITATION) {
    return [identifier];
  }
  return (
    czechReporterIdentifiersFromCitationLabel(identifier.value) ?? [identifier]
  );
};

export const decisionIdentifiersFromStoredMetadata = ({
  caseNumber,
  ecli,
  metadata,
}: StoredDecisionMetadata): DecisionIdentifiers => {
  const persistedIdentifiers =
    decisionIdentifiersFromPersistedMetadata(metadata);
  if (persistedIdentifiers !== null) {
    const expandedIdentifiers = persistedIdentifiers.flatMap(
      expandCompositeReporterIdentifier,
    );
    const [firstIdentifier, ...otherIdentifiers] = expandedIdentifiers;
    return decisionIdentifiersFromMetadata({
      caseNumber,
      ecli,
      identifiers:
        firstIdentifier === undefined
          ? undefined
          : [firstIdentifier, ...otherIdentifiers],
    });
  }
  const storedAliasesValue =
    metadata[PUBLISHER_CASE_NUMBER_ALIASES_METADATA_KEY];
  const legacyReporterCitation = metadata["citation"];
  // Array.isArray narrows to any[]; keep publisher-owned JSON unknown until
  // each candidate passes the shared identifier schema.
  const storedAliases: unknown[] = Array.isArray(storedAliasesValue)
    ? storedAliasesValue
    : [];

  const reporterIdentifierCandidate = {
    type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
    value: legacyReporterCitation,
  };
  const reporterIdentifiers = [
    ...(isDecisionIdentifier(reporterIdentifierCandidate)
      ? expandCompositeReporterIdentifier(reporterIdentifierCandidate)
      : []),
    ...czechConstitutionalIdentifiersFromParallelCitations(
      czechConstitutionalParallelCitations(metadata),
    ),
  ];
  const capacity =
    DECISION_IDENTIFIER_MAX_COUNT - (ecli ? 2 : 1) - reporterIdentifiers.length;
  const seen = new Set([
    normalizeDecisionIdentifier({
      type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      value: caseNumber,
    }),
  ]);
  const aliases: DecisionIdentifier[] = [];
  for (const value of storedAliases) {
    const candidate = {
      type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      value,
    };
    if (!isDecisionIdentifier(candidate)) {
      continue;
    }
    const normalized = normalizeDecisionIdentifier(candidate);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    aliases.push(candidate);
    if (aliases.length === capacity) {
      break;
    }
  }
  const legacyIdentifiers: DecisionIdentifier[] = aliases;
  legacyIdentifiers.push(...reporterIdentifiers);
  const [firstIdentifier, ...otherIdentifiers] = legacyIdentifiers;
  return decisionIdentifiersFromMetadata({
    caseNumber,
    ecli,
    identifiers:
      firstIdentifier === undefined
        ? undefined
        : [firstIdentifier, ...otherIdentifiers],
  });
};

/**
 * Canonical comparison key for a citation or case number: prefix
 * stripped, then run through `canonicalizeDedupKey`. Exported so callers
 * needing the bare case number for display or comparison share the exact
 * same normalization as the extractor's own dedup key.
 */
export const bareCitationKey = (text: string): string =>
  canonicalizeDedupKey(stripCitationPrefix(text));

/**
 * The value that goes in a `citation_key` column, for every writer of one.
 *
 * Null, never the empty string, when the text does not canonicalize. The two
 * spellings are not interchangeable: null keeps a row out of the resolver's
 * equality join, while '' matches every other row that also failed to
 * canonicalize, drawing edges between unrelated cases. Two writers once
 * disagreed about which to use, so the choice lives here rather than at each
 * call site, and the database refuses the loser (`citation_key <> ''`).
 */
export const citationKeyOf = (text: string): string | null =>
  bareCitationKey(text) || null;

export const normalizeDecisionIdentifier = (
  identifier: DecisionIdentifier,
): string => {
  switch (identifier.type) {
    case DECISION_IDENTIFIER_TYPES.CASE_NUMBER:
      return bareCitationKey(identifier.value);
    case DECISION_IDENTIFIER_TYPES.ECLI:
    case DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION:
      return normalizeStructuredDecisionIdentifier(identifier);
    case DECISION_IDENTIFIER_TYPES.REPORTER_CITATION:
      return normalizeStructuredDecisionIdentifier({
        type: identifier.type,
        value:
          hungarianConstitutionalDesignation(identifier.value) ??
          czechConstitutionalDesignation(identifier.value) ??
          identifier.value,
      });
    default: {
      identifier satisfies never;
      return panic(`Unhandled decision identifier: ${String(identifier)}`);
    }
  }
};

export const normalizeDecisionIdentifierValue = (
  type: DecisionIdentifierType,
  value: string,
): string => {
  switch (type) {
    case DECISION_IDENTIFIER_TYPES.CASE_NUMBER:
      return normalizeDecisionIdentifier({ type, value });
    case DECISION_IDENTIFIER_TYPES.ECLI:
      return normalizeDecisionIdentifier({ type, value });
    case DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION:
      return normalizeDecisionIdentifier({ type, value });
    case DECISION_IDENTIFIER_TYPES.REPORTER_CITATION:
      return normalizeDecisionIdentifier({ type, value });
    default: {
      (type) satisfies never;
      return panic(`Unhandled decision identifier type: ${String(type)}`);
    }
  }
};

/**
 * Check whether a citation text refers to the same decision that
 * contains it (self-citation).
 */
export const isSelfCitation = (
  citationText: string,
  identifiers: DecisionIdentifiers,
): boolean =>
  identifiers.some(
    (identifier) =>
      normalizeDecisionIdentifierValue(identifier.type, citationText) ===
      normalizeDecisionIdentifier(identifier),
  );

export const decisionIdentifierTypeOfCitation = (
  citationText: string,
): DecisionIdentifierType => {
  if (/^(?:ECLI:|EU:[CTF]:)/u.test(citationText)) {
    return DECISION_IDENTIFIER_TYPES.ECLI;
  }
  if (/^\[\d{4}\]/u.test(citationText)) {
    return DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION;
  }
  if (/\bSb\.\s*(?:rozh\.|NSS|NS)/iu.test(citationText)) {
    return DECISION_IDENTIFIER_TYPES.REPORTER_CITATION;
  }
  // Hungarian uniformity decisions, opinions and reporter entries stay case
  // numbers: the listing stores them as case numbers, and that is the
  // identifier type a citation of one has to join.
  if (hungarianConstitutionalDesignation(citationText) !== null) {
    return DECISION_IDENTIFIER_TYPES.REPORTER_CITATION;
  }
  // A bare gazette number is only ever extracted as a ruling's; see
  // `CZ_US_GAZETTE_SOURCE`.
  if (czechConstitutionalDesignation(citationText) !== null) {
    return DECISION_IDENTIFIER_TYPES.REPORTER_CITATION;
  }
  return DECISION_IDENTIFIER_TYPES.CASE_NUMBER;
};

/**
 * Hints that must agree across every occurrence of one key.
 *
 * A docket attributed to two courts, printed on two sheets, or dated two ways
 * in one text names two decisions. A single value would pick one of them by
 * occurrence order, so a disagreement leaves the key carrying none. Listed
 * rather than settled per field, so a hint added later cannot be the one that
 * quietly keeps whichever spelling it saw first.
 */
const AGREEING_HINTS = [
  "citedCourtHint",
  "citedSheetNumber",
  "citedDecisionDate",
] as const satisfies readonly (keyof ExtractedCitation)[];

type AgreeingHint = (typeof AGREEING_HINTS)[number];

/** Where one key's recorded occurrence sits, for the merge pass below. */
type CitationPosition = {
  sectionIndex: number;
  start: number;
  end: number;
};

/**
 * What may sit between a docket and the collection number naming the same
 * decision: the docket's own sheet suffix, then the comma that joins them.
 * "č.j. 3 Ads 110/2009-49, č. 2018/2010 Sb. NSS" is one citation written
 * twice over; a collection number further away in the sentence is not.
 */
const COLLECTION_AFTER_DOCKET = new RegExp(
  String.raw`^(?: ?[${CITATION_DASH_CLASS}] ?\d{1,4})?\s*[,;]\s*$`,
  "u",
);

/**
 * The same join after a Constitutional Court docket, which the court and
 * those citing it write in more ways: the reporter entry in parentheses,
 * "Pl. ÚS 18/01 (N 53/26 SbNU 73; 234/2002 Sb.)", and the gazette number
 * after the words that say where it was published, "Pl. ÚS 18/01, vyhlášený
 * pod č. 234/2002 Sb.".
 */
const CZ_US_COLLECTION_AFTER_DOCKET =
  /^\s*(?:[,;(]\s*)?(?:(?:(?:který|jenž)\s+)?(?:byl\s+)?(?:vyhlášen|publikov[aá]n|uveřejněn)\p{L}{0,3}(?:\s+ve\s+Sbírce\s+zákonů)?\s+pod\s+[čc]\.\s*)?$/u;

const US_MARK_RE = new RegExp(US_MARK_SOURCE, "u");

/** The join a collection citation may stand in after a docket, if any. */
const collectionJoinAfterDocket = (
  reporter: ExtractedCitation,
): RegExp | null => {
  if (reporter.identifierType !== DECISION_IDENTIFIER_TYPES.REPORTER_CITATION) {
    return null;
  }
  if (CZECH_REPORTER_CITATION_RE.test(reporter.identifierValue)) {
    return COLLECTION_AFTER_DOCKET;
  }
  return czechConstitutionalDesignation(reporter.identifierValue) === null
    ? null
    : CZ_US_COLLECTION_AFTER_DOCKET;
};

/**
 * Fold a collection citation into the docket citation that names the same
 * decision beside it.
 *
 * Both spellings resolve to that decision, so leaving them as two rows puts
 * two edges in the citation graph for one endorsement — and the graph is read
 * for how often a decision is endorsed. The docket keeps the text, because
 * that is the span the reader sees and what the passage anchors on; the
 * collection number becomes the identity, because it names exactly one
 * decision where a docket names a whole file.
 *
 * A Constitutional Court docket is the exception: the collection mention
 * beside it is absorbed into the docket's citation, which keeps the docket's
 * identity.
 *
 * Czech collections only. A Hungarian docket already names one decision (its
 * document number), and the only Hungarian reporter-type citation, a
 * Constitutional Court decision, is never the same decision as a court docket
 * beside it.
 */
const mergeCollectionCitations = ({
  byKey,
  positions,
  sectionText,
}: {
  byKey: Map<string, ExtractedCitation>;
  positions: Map<string, CitationPosition>;
  sectionText: Map<number, string>;
}): void => {
  for (const [reporterKey, reporter] of byKey) {
    const join = collectionJoinAfterDocket(reporter);
    if (join === null) {
      continue;
    }
    const reporterAt = positions.get(reporterKey);
    const text =
      reporterAt === undefined
        ? undefined
        : sectionText.get(reporterAt.sectionIndex);
    if (reporterAt === undefined || text === undefined) {
      continue;
    }
    for (const [docketKey, docket] of byKey) {
      const docketAt = positions.get(docketKey);
      if (
        docket.identifierType !== DECISION_IDENTIFIER_TYPES.CASE_NUMBER ||
        docketAt === undefined ||
        docketAt.sectionIndex !== reporterAt.sectionIndex ||
        docketAt.end > reporterAt.start ||
        (join === CZ_US_COLLECTION_AFTER_DOCKET &&
          !US_MARK_RE.test(docket.identifierValue)) ||
        !join.test(text.slice(docketAt.end, reporterAt.start))
      ) {
        continue;
      }
      // A Constitutional Court docket keeps resolving by itself: the
      // collection numbers reach a ruling only once its row carries them, and
      // the docket reaches it either way.
      if (join !== CZ_US_COLLECTION_AFTER_DOCKET) {
        docket.identifierType = reporter.identifierType;
        docket.identifierValue = reporter.identifierValue;
      }
      byKey.delete(reporterKey);
      break;
    }
  }
};

/**
 * Extract citation references from decision text.
 *
 * Scans each section of the decision for patterns matching known
 * citation formats. Returns deduplicated citations with their source
 * section index.
 */
export const extractCitations = (
  sections: { index: number; text: string }[],
): ExtractedCitation[] => {
  const byKey = new Map<string, ExtractedCitation>();
  const positions = new Map<string, CitationPosition>();
  const sectionText = new Map(
    sections.map((section) => [section.index, section.text] as const),
  );
  // Keys whose occurrences named two different types. One text calling the
  // same docket both a nález and an usnesení is naming two documents, and a
  // single hint would pick one of them by occurrence order.
  const conflictingHints = new Set<string>();
  // The same rule for every hint that must agree with itself, keyed by hint
  // and dedup key so one field's disagreement never silences another's.
  const conflictingAgreeingHints = new Set<string>();

  for (const section of sections) {
    for (const pattern of CITATION_PATTERNS) {
      pattern.lastIndex = 0;

      for (
        let match = pattern.exec(section.text);
        match !== null;
        match = pattern.exec(section.text)
      ) {
        // citationText is stored verbatim (only edge-trimmed), never
        // whitespace-normalized: exact-passage anchoring must be able to
        // find this exact string in the source document, including an
        // embedded line-wrap newline. Only the dedup key below is
        // canonicalized.
        const citationText = match[0].trim();
        const caseNumber = match.groups?.["caseNumber"]?.trim();
        // A bare letter run under a court's label is also how a ministry
        // writes a file number, so the docket grammar decides whether this
        // capture is a case number at all.
        if (
          CZE_GATED_PATTERNS.has(pattern) &&
          (caseNumber === undefined ||
            DECISION_DOCKET_GRAMMARS.CZE.parse(caseNumber) === null)
        ) {
          continue;
        }
        if (
          PL_TK_CUE_GATED_PATTERNS.has(pattern) &&
          !PL_TK_CUE_RE.test(
            section.text.slice(
              Math.max(0, match.index - PL_TK_CUE_WINDOW),
              match.index,
            ),
          )
        ) {
          continue;
        }
        if (
          pattern === PL_AUTHORITY_FILE_NUMBER_PATTERN &&
          !PL_AUTHORITY_FILE_NUMBER_CUE_RE.test(
            section.text.slice(
              Math.max(0, match.index - PL_TK_CUE_WINDOW),
              match.index,
            ),
          )
        ) {
          continue;
        }
        if (
          pattern === PL_UOKIK_DECISION_PATTERN &&
          !PL_UOKIK_DECISION_CUE_RE.test(
            section.text.slice(
              Math.max(0, match.index - PL_UOKIK_DECISION_CUE_WINDOW),
              match.index,
            ),
          )
        ) {
          continue;
        }
        const identifierType = decisionIdentifierTypeOfCitation(citationText);
        // For patterns with a capture group (e.g. the Polish prefixed
        // pattern), use the bare case number as the canonical dedup key
        // so both "sygn. akt II CSK 123/20" and "II CSK 123/20" resolve
        // to the same key regardless of which fires first.
        // canonicalizeDedupKey further folds whitespace/separator/case
        // spelling variance so the same real case number never fractures
        // into two keys.
        const dedupValue = caseNumber ?? citationText;
        const dedupKey = `${identifierType}:${normalizeDecisionIdentifierValue(identifierType, dedupValue)}`;

        const citedDecisionTypeHint = detectCitationDecisionTypeHint(
          section.text,
          match.index,
        );
        const observed: Record<AgreeingHint, string | null> = {
          citedCourtHint: detectCitationCourtHint(section.text, match.index),
          citedSheetNumber: detectCitationSheetNumber(
            section.text,
            match.index + match[0].length,
          ),
          citedDecisionDate: detectCitationDecisionDate(
            section.text,
            match.index,
          ),
        };
        const position: CitationPosition = {
          sectionIndex: section.index,
          start: match.index,
          end: match.index + match[0].length,
        };

        const existing = byKey.get(dedupKey);
        if (!existing) {
          byKey.set(dedupKey, {
            citationText,
            sectionIndex: section.index,
            citedDecisionTypeHint,
            identifierType,
            identifierValue: citationText,
            ...observed,
          });
          positions.set(dedupKey, position);
          continue;
        }
        for (const hint of AGREEING_HINTS) {
          const value = observed[hint];
          const conflictKey = `${hint}:${dedupKey}`;
          if (value === null || conflictingAgreeingHints.has(conflictKey)) {
            continue;
          }
          if (existing[hint] !== null && existing[hint] !== value) {
            conflictingAgreeingHints.add(conflictKey);
            existing[hint] = null;
            continue;
          }
          existing[hint] = value;
        }
        // Prefer a later occurrence over an earlier one: a case is often
        // listed bare in the header (low section index) and then discussed
        // in the reasoning. The discussion carries the polarity signal, so
        // record the later section's context, not the header's. The type
        // hint is the exception: any occurrence that names the type is
        // better than one that does not, so a hint, once seen, stays;
        // unless a later occurrence names a different type, which leaves
        // the key without a hint for the resolver to treat as ambiguous.
        if (
          existing.sectionIndex === null ||
          section.index > existing.sectionIndex
        ) {
          existing.citationText = citationText;
          existing.identifierValue = citationText;
          existing.sectionIndex = section.index;
          positions.set(dedupKey, position);
        }
        if (citedDecisionTypeHint === null || conflictingHints.has(dedupKey)) {
          continue;
        }
        if (
          existing.citedDecisionTypeHint !== null &&
          existing.citedDecisionTypeHint !== citedDecisionTypeHint
        ) {
          conflictingHints.add(dedupKey);
          existing.citedDecisionTypeHint = null;
          continue;
        }
        existing.citedDecisionTypeHint = citedDecisionTypeHint;
      }
    }
  }

  mergeCollectionCitations({ byKey, positions, sectionText });

  return [...byKey.values()];
};
