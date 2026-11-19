import { panic } from "better-result";

import { foldToAscii, normalizeUnicode, slugify } from "@stll/text-normalize";

/**
 * Hungarian acts as the Magyar Közlöny designates them, and the Work
 * identifier stella stores each under.
 *
 * The gazette states no identifier but the act's designation, fixed in form
 * and numbering by 5/2019. (III. 13.) IM rendelet: a law by its year and a
 * Roman numeral (`2013. évi V. törvény`), every other act by its number in
 * its issuer's and kind's yearly series, the day it was signed and the
 * issuer (`493/2026. (XI. 18.) Korm. rendelet`). The Work is that printed
 * designation folded to a slug under `urn:hu:magyar-kozlony:`, so a citation
 * printed the same way names the same Work. This module is the one owner of
 * that folding: the ingestion that mints the identifier and every reader
 * that turns a citation into one fold through `magyarKozlonyWorkEli`.
 */

export const MAGYAR_KOZLONY_WORK_URN_PREFIX = "urn:hu:magyar-kozlony:";

const WORK_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** The Work identifier of a printed designation, or null when it folds to nothing. */
export const magyarKozlonyWorkEli = (designation: string): string | null => {
  const slug = slugify(designation, {
    charset: "ascii",
    separator: "-",
    maxLength: 200,
    fallback: "",
  });
  return slug === "" ? null : `${MAGYAR_KOZLONY_WORK_URN_PREFIX}${slug}`;
};

/** Whether a stored identifier names a Magyar Közlöny Work. */
export const isMagyarKozlonyWorkEli = (eli: string): boolean =>
  eli.startsWith(MAGYAR_KOZLONY_WORK_URN_PREFIX) &&
  WORK_SLUG_RE.test(eli.slice(MAGYAR_KOZLONY_WORK_URN_PREFIX.length));

const ROMAN_DIGITS = [
  [1000, "M"],
  [900, "CM"],
  [500, "D"],
  [400, "CD"],
  [100, "C"],
  [90, "XC"],
  [50, "L"],
  [40, "XL"],
  [10, "X"],
  [9, "IX"],
  [5, "V"],
  [4, "IV"],
  [1, "I"],
] as const;

const ROMAN_MAX = 3999;

/** `5` as `V`; null outside 1..3999, which Roman numerals do not write. */
export const romanNumeral = (value: number): string | null => {
  if (!Number.isSafeInteger(value) || value < 1 || value > ROMAN_MAX) {
    return null;
  }
  let rest = value;
  let written = "";
  for (const [amount, digits] of ROMAN_DIGITS) {
    while (rest >= amount) {
      written += digits;
      rest -= amount;
    }
  }
  return written;
};

/**
 * `cxxx` or `CXXX` as 130. Only the canonical spelling is read: `IIII` and
 * `VX` name no number, so they are not taken for one.
 */
export const parseRomanNumeral = (text: string): number | null => {
  const upper = text.toUpperCase();
  let value = 0;
  let index = 0;
  for (const [amount, digits] of ROMAN_DIGITS) {
    while (upper.startsWith(digits, index)) {
      value += amount;
      index += digits.length;
    }
  }
  return index === upper.length && value > 0 && romanNumeral(value) === upper
    ? value
    : null;
};

/** The words an act's own designation ends in, folded to ASCII. */
export const HUNGARIAN_NUMBERED_ACT_FORMS = [
  "rendelet",
  "hatarozat",
  "vegzes",
] as const;

type HungarianNumberedActForm = (typeof HUNGARIAN_NUMBERED_ACT_FORMS)[number];

const FORM_SPELLING = {
  rendelet: "rendelet",
  hatarozat: "határozat",
  vegzes: "végzés",
} as const satisfies Record<HungarianNumberedActForm, string>;

/**
 * One act a Hungarian citation names.
 *
 * - `law`: `2013. évi V. törvény`.
 * - `numbered`: `493/2026. (XI. 18.) Korm. rendelet`. The issuer is kept as
 *   written (`Korm.`, `IM`, `MNB`); the Work identifier folds its case and
 *   dots away. `signed` is null when the citation leaves the date out, and
 *   then the citation names an act without naming its Work identifier.
 */
export type HungarianActDesignation =
  | { kind: "law"; year: number; number: number }
  | {
      kind: "numbered";
      number: number;
      year: number;
      signed: { month: number; day: number } | null;
      issuer: string;
      form: HungarianNumberedActForm;
    };

/** The designation as the gazette prints it, or null without a signing date. */
export const printHungarianDesignation = (
  act: HungarianActDesignation,
): string | null => {
  switch (act.kind) {
    case "law": {
      const roman = romanNumeral(act.number);
      return roman === null
        ? null
        : `${String(act.year)}. évi ${roman}. törvény`;
    }
    case "numbered": {
      if (act.signed === null) {
        return null;
      }
      const month = romanNumeral(act.signed.month);
      return month === null
        ? null
        : `${String(act.number)}/${String(act.year)}. (${month}. ${String(act.signed.day)}.) ${act.issuer} ${FORM_SPELLING[act.form]}`;
    }
    default:
      act satisfies never;
      return panic("Unknown Hungarian act designation kind");
  }
};

/** The Work identifier a designation names, or null when it names none. */
export const hungarianDesignationWorkEli = (
  act: HungarianActDesignation,
): string | null => {
  const printed = printHungarianDesignation(act);
  return printed === null ? null : magyarKozlonyWorkEli(printed);
};

/**
 * The comparison form: compatibility-normalised, diacritics folded, runs of
 * whitespace one space. `törvény`, `törvénnyel` and `torveny` read alike.
 */
const foldCitation = (text: string): string =>
  foldToAscii(normalizeUnicode(text, "NFKC")).replace(/\s+/gu, " ").trim();

// The patterns run on folded text, where whitespace is one space, so they
// spell it literally: two adjacent unbounded quantifiers backtrack.
const LAW_RE =
  /(?<![\p{L}\p{N}])(?<year>\d{4}) ?\. ?evi (?<roman>[ivxlcdm]{1,12}) ?\. ?(?:torven|tv\.)/giu;

const NUMBERED_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}/])(?<number>\d{1,5}) ?\/ ?(?<year>\d{4}) ?\.?(?: ?\( ?(?<month>[ivx]{1,4}) ?\. ?(?<day>\d{1,2}) ?\.? ?\))? ?(?<issuer>[a-z]{1,8}\.?(?:[ -][a-z]{1,8}\.?)?) (?<form>${HUNGARIAN_NUMBERED_ACT_FORMS.join("|")})`,
  "giu",
);

const EARLIEST_YEAR = 1800;
const LATEST_YEAR = 9999;

const isActYear = (year: number) =>
  Number.isSafeInteger(year) && year >= EARLIEST_YEAR && year <= LATEST_YEAR;

const isNumberedForm = (form: string): form is HungarianNumberedActForm =>
  HUNGARIAN_NUMBERED_ACT_FORMS.some((candidate) => candidate === form);

const readLaw = (groups: Record<string, string | undefined>) => {
  const year = Number(groups["year"]);
  const number = parseRomanNumeral(groups["roman"] ?? "");
  return isActYear(year) && number !== null
    ? ({ kind: "law", year, number } as const)
    : null;
};

const readNumbered = (
  groups: Record<string, string | undefined>,
): HungarianActDesignation | null => {
  const number = Number(groups["number"]);
  const year = Number(groups["year"]);
  const form = groups["form"]?.toLowerCase() ?? "";
  const issuer = groups["issuer"] ?? "";
  if (
    !Number.isSafeInteger(number) ||
    number < 1 ||
    !isActYear(year) ||
    !isNumberedForm(form)
  ) {
    return null;
  }
  const monthText = groups["month"];
  const dayText = groups["day"];
  let signed: { month: number; day: number } | null = null;
  if (monthText !== undefined && dayText !== undefined) {
    const month = parseRomanNumeral(monthText);
    const day = Number(dayText);
    if (month === null || month > 12 || day < 1 || day > 31) {
      return null;
    }
    signed = { month, day };
  }
  return { kind: "numbered", number, year, signed, issuer, form };
};

/** A designation found in a citation, with where it starts in folded text. */
type DesignationMention = { offset: number; act: HungarianActDesignation };

const designationMentions = (folded: string): DesignationMention[] => [
  ...[...folded.matchAll(LAW_RE)].flatMap((match) => {
    const act = readLaw(match.groups ?? {});
    return act === null ? [] : [{ offset: match.index, act }];
  }),
  ...[...folded.matchAll(NUMBERED_RE)].flatMap((match) => {
    const act = readNumbered(match.groups ?? {});
    return act === null ? [] : [{ offset: match.index, act }];
  }),
];

/**
 * A code's abbreviation and the law it named over time. Each reading holds
 * from the day the law took effect until the next one's; a citation dated
 * before the earliest bounded reading names the oldest law.
 */
type HungarianCodeAlias = {
  spellings: readonly string[];
  readings: readonly { from?: string; law: { year: number; number: number } }[];
};

/**
 * Codes courts cite by abbreviation. A recodification reused the
 * abbreviation, so the citing date picks the law: `Ptk.` is the 1959 code
 * before 15 March 2014 and the 2013 code from then.
 */
export const HUNGARIAN_CODE_ALIASES = [
  {
    spellings: ["Ptk."],
    readings: [
      { law: { year: 1959, number: 4 } },
      { from: "2014-03-15", law: { year: 2013, number: 5 } },
    ],
  },
  {
    spellings: ["Mt."],
    readings: [
      { law: { year: 1992, number: 22 } },
      { from: "2012-07-01", law: { year: 2012, number: 1 } },
    ],
  },
  {
    spellings: ["Btk."],
    readings: [
      { law: { year: 1978, number: 4 } },
      { from: "2013-07-01", law: { year: 2012, number: 100 } },
    ],
  },
  {
    spellings: ["Pp."],
    readings: [
      { law: { year: 1952, number: 3 } },
      { from: "2018-01-01", law: { year: 2016, number: 130 } },
    ],
  },
  {
    spellings: ["Be."],
    readings: [
      { law: { year: 1998, number: 19 } },
      { from: "2018-07-01", law: { year: 2017, number: 90 } },
    ],
  },
  {
    spellings: ["Ákr."],
    readings: [{ law: { year: 2016, number: 150 } }],
  },
  {
    spellings: ["Kp."],
    readings: [{ law: { year: 2017, number: 1 } }],
  },
  {
    spellings: ["Vht."],
    readings: [{ law: { year: 1994, number: 53 } }],
  },
  {
    spellings: ["Infotv."],
    readings: [{ law: { year: 2011, number: 112 } }],
  },
] as const satisfies readonly HungarianCodeAlias[];

const aliasReading = (
  alias: HungarianCodeAlias,
  citedOn: string,
): HungarianActDesignation | null => {
  const reading = alias.readings.findLast(
    ({ from }) => from === undefined || from <= citedOn,
  );
  return reading === undefined ? null : { kind: "law", ...reading.law };
};

const WORD_CHARACTER = /[\p{L}\p{N}]/u;

const aliasMentions = (folded: string, citedOn: string): DesignationMention[] =>
  HUNGARIAN_CODE_ALIASES.flatMap((alias) =>
    alias.spellings.flatMap((spelling) => {
      // Abbreviations are matched as courts print them, case included:
      // `Be.` is a code, `be.` is a word.
      const key = foldCitation(spelling);
      const mentions: DesignationMention[] = [];
      let offset = folded.indexOf(key);
      while (offset !== -1) {
        const end = offset + key.length;
        if (
          !WORD_CHARACTER.test(folded.charAt(offset - 1)) &&
          !WORD_CHARACTER.test(folded.charAt(end))
        ) {
          const act = aliasReading(alias, citedOn);
          if (act !== null) {
            mentions.push({ offset, act });
          }
        }
        offset = folded.indexOf(key, end);
      }
      return mentions;
    }),
  );

const designationKey = (act: HungarianActDesignation): string =>
  act.kind === "law"
    ? `law:${String(act.year)}:${String(act.number)}`
    : `${foldCitation(act.issuer)
        .replace(/[.\s-]/gu, "")
        .toLowerCase()}:${act.form}:${String(act.year)}:${String(act.number)}`;

/**
 * Every act a Hungarian citation names, once each, in the order it names
 * them: designations as printed, and code abbreviations read for the citing
 * date. Two spellings of one act (`Ptk.` and `2013. évi V. törvény`) are one.
 */
export const readHungarianActCitations = (
  text: string,
  citedOn: string,
): HungarianActDesignation[] => {
  const folded = foldCitation(text);
  const seen = new Set<string>();
  return [...designationMentions(folded), ...aliasMentions(folded, citedOn)]
    .toSorted((left, right) => left.offset - right.offset)
    .flatMap(({ act }) => {
      const key = designationKey(act);
      if (seen.has(key)) {
        return [];
      }
      seen.add(key);
      return [act];
    });
};

const LAW_KIND_RE = /^(?:torveny|tv\.?)$/u;
const ARABIC_RE = /^\d{1,4}$/u;
const YEAR_RE = /^\d{4}$/u;

/**
 * A law named by its parts, as a structured identity gives them: the kind
 * (`törvény`, `tv.`), the year, and the number in Arabic or Roman numerals.
 * Null for anything else: every other act is designated with the day it was
 * signed, which parts without a date do not name.
 */
export const readHungarianLawParts = ({
  kind,
  year,
  number,
}: {
  kind: string;
  year: string;
  number: string;
}): HungarianActDesignation | null => {
  if (!LAW_KIND_RE.test(foldCitation(kind).toLowerCase())) {
    return null;
  }
  const writtenYear = year.trim();
  const writtenNumber = number.trim().replace(/\.$/u, "");
  const parsedYear = YEAR_RE.test(writtenYear) ? Number(writtenYear) : null;
  const parsedNumber = ARABIC_RE.test(writtenNumber)
    ? Number(writtenNumber)
    : parseRomanNumeral(writtenNumber);
  return parsedYear !== null &&
    isActYear(parsedYear) &&
    parsedNumber !== null &&
    romanNumeral(parsedNumber) !== null
    ? { kind: "law", year: parsedYear, number: parsedNumber }
    : null;
};

/** What a Hungarian provision number names: a section (`§`) or an article (`cikk`). */
export type HungarianProvision = {
  unit: "section" | "article";
  /** As the Magyar Közlöny anchors write it: `6:519`, `25/G`, `IV`. */
  designator: string;
};

// `6:519. §`, `§ 6:519`, `25/G. §-a`, `10`: a section number, which a code
// prefixes with its book (`6:`) and an inserted section suffixes with a
// capital letter (`/G`).
const SECTION_RE =
  /^(?<marker>§ ?)?(?<number>(?:\d{1,2}:)?\d{1,4})(?: ?\/ ?(?<letter>[a-z]))? ?\.?(?<sign> ?§(?:-[a-z]{1,8})?)?$/iu;
// `IV. cikk`, `1. cikk`, `cikk IV`.
const ARTICLE_RE =
  /^(?:(?<before>[ivxlc]{1,8}|\d{1,4}) ?\. ?cikk(?:[a-z]{1,4})?|cikk (?<after>[ivxlc]{1,8}|\d{1,4})\.?)$/iu;

/**
 * The provisions a cited number may name, most likely first. A `§` names a
 * section and `cikk` an article; a bare Arabic number is a section, else the
 * article of that number, and a bare Roman numeral only an article.
 */
export const readHungarianProvision = (
  written: string,
): readonly HungarianProvision[] => {
  const folded = foldCitation(written);
  const article = ARTICLE_RE.exec(folded)?.groups;
  if (article !== undefined) {
    const designator = (
      article["before"] ??
      article["after"] ??
      ""
    ).toUpperCase();
    return designator === "" ? [] : [{ unit: "article", designator }];
  }
  const section = SECTION_RE.exec(folded)?.groups;
  const number = section?.["number"];
  if (section === undefined || number === undefined) {
    const roman = /^(?<roman>[ivxlc]{1,8}) ?\.?$/iu.exec(folded)?.groups?.[
      "roman"
    ];
    return roman !== undefined && parseRomanNumeral(roman) !== null
      ? [{ unit: "article", designator: roman.toUpperCase() }]
      : [];
  }
  const letter = section["letter"];
  const designator =
    letter === undefined ? number : `${number}/${letter.toUpperCase()}`;
  const marked =
    section["marker"] !== undefined || section["sign"] !== undefined;
  if (marked || designator.includes(":") || letter !== undefined) {
    return [{ unit: "section", designator }];
  }
  return [
    { unit: "section", designator },
    { unit: "article", designator },
  ];
};
