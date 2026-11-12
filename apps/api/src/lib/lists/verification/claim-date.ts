/**
 * The date a claim asserts, read from its own words.
 *
 * A witness's timeline is compared with the record's, so each claim carries
 * the date it states, in the shape a fact's date has: a day, a month or a
 * year, stored as its first day. The words are read deterministically first.
 * The grader is asked only when they name no complete date (a day and month
 * whose year the passage gives, a numeric date whose order is unclear, or a
 * language this reader does not know); its answer is never preferred over
 * the words.
 *
 * A claim that names several dates, or a range ("2-20 August 2021"), is
 * dated by the smallest day, month or year that covers all of them: "2-20
 * August 2021" is August 2021. Widening never invents a disagreement with
 * the record (a record entry of 17 August sits inside it), and it keeps one
 * date shape for claims and facts. Dates no single year covers leave the
 * claim undated. Relative dates ("the next day", "a week later") are not
 * dates.
 */

import { panic } from "better-result";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import { normalizeUnicode } from "@stll/text-normalize";
import { parsePlainDate, Temporal } from "@stll/time";

import type {
  FactDatePrecision,
  PartialDate,
} from "@/api/lib/lists/fact-details";
import type {
  ClaimAssertedDate,
  ClaimAssertedOnSource,
} from "@/api/lib/lists/verification/contract";

/** What the words alone say: one date, dates no single year covers, or no
 *  complete date. */
export type ClaimTextDate =
  ({ type: "dated" } & PartialDate) | { type: "spread" } | { type: "silent" };

const ENGLISH_MONTHS = [
  ["january", "jan"],
  ["february", "feb"],
  ["march", "mar"],
  ["april", "apr"],
  ["may"],
  ["june", "jun"],
  ["july", "jul"],
  ["august", "aug"],
  ["september", "sept", "sep"],
  ["october", "oct"],
  ["november", "nov"],
  ["december", "dec"],
] as const;

/**
 * Other languages whose month names are read, as the platform's calendar data
 * spells them: alone ("srpen") and inside a date, where some languages
 * inflect them ("10. srpna"). Latin-script languages the product ships in.
 */
const MONTH_LOCALES = [
  "cs",
  "sk",
  "pl",
  "de",
  "fr",
  "es",
  "pt",
  "hu",
  "et",
  "lt",
  "lv",
] as const;

type MonthName = { month: number; english: boolean };

const localeMonthNames = (locale: string, month: number): string[] => {
  const instant = Temporal.Instant.from(
    `2021-${String(month).padStart(2, "0")}-15T12:00:00Z`,
  ).epochMilliseconds;
  const alone = new Intl.DateTimeFormat(locale, {
    month: "long",
    timeZone: "UTC",
  }).format(instant);
  const inDate = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  })
    .formatToParts(instant)
    .filter((part) => part.type === "month")
    .map((part) => part.value);
  return [alone, ...inDate].map((name) => name.toLocaleLowerCase(locale));
};

/** Every month name read, lower-cased. A name two languages give different
 *  months is left out, so it is never read as either. */
const MONTH_BY_NAME: ReadonlyMap<string, MonthName> = (() => {
  const names = new Map<string, MonthName | null>();
  const add = (name: string, entry: MonthName) => {
    const known = names.get(name);
    if (known === undefined) {
      names.set(name, entry);
    } else if (known !== null && known.month !== entry.month) {
      names.set(name, null);
    } else if (known !== null && entry.english) {
      names.set(name, entry);
    }
  };
  for (const [index, english] of ENGLISH_MONTHS.entries()) {
    for (const name of english) {
      add(name, { month: index + 1, english: true });
    }
  }
  for (const locale of MONTH_LOCALES) {
    for (let month = 1; month <= 12; month += 1) {
      for (const name of localeMonthNames(locale, month)) {
        add(name, { month, english: false });
      }
    }
  }
  return new Map(
    [...names].flatMap(([name, entry]) =>
      entry === null ? [] : [[name, entry] as const],
    ),
  );
})();

const MONTH = `((?<!\\p{L})(?:${[...MONTH_BY_NAME.keys()]
  .toSorted((a, b) => b.length - a.length)
  .join("|")})(?!\\p{L})\\.?)`;
const DAY =
  "((?<![\\p{L}\\p{N}.,])(?:0?[1-9]|[12]\\d|3[01])(?![\\p{N}])(?:st|nd|rd|th)?\\.?)";
const YEAR = "((?<![\\p{N}])(?:1[89]|20)\\d{2}(?![\\p{N}]))";
const TO = "\\s*(?:-|to|until|till|through|and)\\s*";
const OF = "\\s+(?:(?:of|de)\\s+)?";
// "10 de agosto de 2021": Spanish and Portuguese join the year with "de".
const THEN_YEAR = `,?\\s+(?:de\\s+)?${YEAR}`;

/** A date the words name: `year`, `month` and `day` as far as given. An
 *  `unclear` one is date-shaped but cannot be read safely. */
type Mention =
  | {
      type: "date";
      year: number | null;
      month: number | null;
      day: number | null;
    }
  | { type: "unclear" };

type Pattern = {
  regex: RegExp;
  read: (groups: readonly (string | undefined)[]) => Mention[];
};

const pattern = (source: string, read: Pattern["read"]): Pattern => ({
  regex: new RegExp(source, "giu"),
  read,
});

const number = (value: string | undefined): number | null =>
  value === undefined
    ? null
    : parseIntegerToken(value, { sign: "unsigned" }).unwrapOr(null);

/** A month name as written, or null when it is not one: English month names
 *  are capitalised, so "may" and "march" stay verbs. */
const monthOf = (written: string | undefined): number | null => {
  if (written === undefined) {
    return null;
  }
  const bare = written.replace(/\.$/u, "");
  const name = MONTH_BY_NAME.get(bare.toLowerCase());
  if (name === undefined) {
    return null;
  }
  const first = bare.at(0) ?? "";
  return name.english && first === first.toLowerCase() ? null : name.month;
};

const dayOf = (written: string | undefined): number | null =>
  number(written?.replace(/(?:st|nd|rd|th)?\.?$/iu, ""));

const date = (
  year: number | null,
  month: number | null,
  day: number | null,
): Mention => ({
  type: "date",
  year,
  month,
  day,
});

/** Year, month and day mentions; a month name that is not one (a verb)
 *  reads as nothing. */
const named = (
  year: string | undefined,
  month: string | undefined,
  day: number | null,
): Mention[] => {
  const monthNumber = monthOf(month);
  return monthNumber === null ? [] : [date(number(year), monthNumber, day)];
};

// Tried together; where two match overlapping text, the earlier start wins,
// then the longer match.
const PATTERNS: readonly Pattern[] = [
  // 2021-08-10
  pattern(
    "(?<![\\p{N}-])(\\d{4})-(\\d{2})-(\\d{2})(?![\\p{N}])",
    ([y, m, d]) => [date(number(y), number(m), number(d))],
  ),
  // 10.8.2021, 10. 8. 2021: day first wherever dots separate the parts.
  pattern(
    "(?<![\\p{N}.])(\\d{1,2})\\.\\s?(\\d{1,2})\\.\\s?(\\d{4})(?![\\p{N}])",
    ([d, m, y]) => [date(number(y), number(m), number(d))],
  ),
  // 10/08/2021: day or month first depends on where it was written.
  pattern(
    "(?<![\\p{N}/-])\\d{1,2}([/-])\\d{1,2}\\1(?:\\d{4}|\\d{2})(?![\\p{N}/-])",
    () => [{ type: "unclear" }],
  ),
  // 2-20 August 2021, between 2 and 20 August: the month covers the range.
  pattern(`${DAY}${TO}${DAY}${OF}${MONTH}(?:${THEN_YEAR})?`, (groups) =>
    named(groups[3], groups[2], null),
  ),
  // August 2-20, 2021
  pattern(`${MONTH}\\s+${DAY}${TO}${DAY}(?:${THEN_YEAR})?`, (groups) =>
    named(groups[3], groups[0], null),
  ),
  // 10 August 2021, 10th of August, 10. srpna 2021
  pattern(`${DAY}${OF}${MONTH}(?:${THEN_YEAR})?`, ([d, m, y]) =>
    named(y, m, dayOf(d)),
  ),
  // August 10, 2021
  pattern(`${MONTH}\\s+${DAY}(?:${THEN_YEAR})?`, ([m, d, y]) =>
    named(y, m, dayOf(d)),
  ),
  // July to August 2021
  pattern(`${MONTH}${TO}${MONTH}${THEN_YEAR}`, ([first, second, y]) => {
    const months = [...named(y, first, null), ...named(y, second, null)];
    return months.length === 2 ? months : [];
  }),
  // August 2021
  pattern(`${MONTH}${THEN_YEAR}`, ([m, y]) => named(y, m, null)),
  // 2019 to 2021, 2011-12
  pattern(
    `${YEAR}(?:${TO}(\\d{4})|-(\\d{2}))(?![\\p{N}])`,
    ([first, full, short]) => {
      const from = number(first) ?? panic("A year range has no first year");
      const to =
        number(full) ??
        Math.floor(from / 100) * 100 +
          (number(short) ?? panic("A year range has no second year"));
      return [date(from, null, null), date(to, null, null)];
    },
  ),
  // in 2021
  pattern(
    `(?<![\\p{N}/.,:])(?<![£$€¥#§¶]\\s?)${YEAR}(?![%/]|[.,:-]\\p{N})`,
    ([y]) => [date(number(y), null, null)],
  ),
];

/** Words before a number that make it an identifier, never a year. */
const IDENTIFIER_WORDS = new Set([
  "account",
  "annex",
  "appendix",
  "art",
  "article",
  "case",
  "chapter",
  "claim",
  "clause",
  "code",
  "exhibit",
  "flat",
  "folio",
  "house",
  "id",
  "invoice",
  "item",
  "line",
  "no",
  "nos",
  "number",
  "p",
  "page",
  "pages",
  "para",
  "paragraph",
  "paragraphs",
  "part",
  "pp",
  "ref",
  "reference",
  "room",
  "rule",
  "schedule",
  "section",
  "sheet",
  "tab",
  "unit",
  "version",
]);

const NOT_A_LETTER = /\P{L}/u;

/** The word just before `start`, a trailing dot dropped ("No. 2021"). */
const followsIdentifierWord = (text: string, start: number): boolean => {
  const before = text.slice(Math.max(0, start - 24), start).trimEnd();
  const word = (before.endsWith(".") ? before.slice(0, -1) : before)
    .split(NOT_A_LETTER)
    .at(-1);
  return word !== undefined && IDENTIFIER_WORDS.has(word.toLowerCase());
};

type Match = { start: number; end: number; mentions: Mention[] };

const normalize = (text: string): string =>
  normalizeUnicode(text, "NFC")
    .replaceAll(/[\u2010-\u2015\u2212]/gu, "-")
    .replaceAll(/[\u00a0\u2007\u2009\u202f]/gu, " ");

const mentionsOf = (text: string): Mention[] => {
  // A match that names nothing (a month name that is a verb) claims no text,
  // so a date beside it is still read.
  const matches: Match[] = PATTERNS.flatMap(({ regex, read }) =>
    [...text.matchAll(regex)].flatMap((match) => {
      const mentions = read(match.slice(1));
      return mentions.length === 0
        ? []
        : [
            {
              start: match.index,
              end: match.index + match[0].length,
              mentions,
            },
          ];
    }),
  ).toSorted((a, b) => a.start - b.start || b.end - a.end);
  const taken: Match[] = [];
  for (const match of matches) {
    const last = taken.at(-1);
    if (last !== undefined && match.start < last.end) {
      continue;
    }
    const bareYear =
      match.mentions.length === 1 &&
      match.mentions[0]?.type === "date" &&
      match.mentions[0].month === null &&
      match.end - match.start === 4;
    if (bareYear && followsIdentifierWord(text, match.start)) {
      continue;
    }
    taken.push(match);
  }
  return taken.flatMap((match) => match.mentions);
};

type FullDate = { year: number; month: number | null; day: number | null };

const exists = ({ year, month, day }: FullDate): boolean =>
  parsePlainDate(
    `${String(year)}-${String(month ?? 1).padStart(2, "0")}-${String(day ?? 1).padStart(2, "0")}`,
  ) !== null;

/** Mentions with their years: a day or month the words give without one
 *  takes the year of the next mention that has one, else the previous.
 *  Null when one cannot be completed or does not exist. */
const completed = (mentions: readonly Mention[]): FullDate[] | null => {
  const dates: FullDate[] = [];
  for (const [index, mention] of mentions.entries()) {
    if (mention.type === "unclear") {
      return null;
    }
    const year =
      mention.year ??
      [...mentions.slice(index + 1), ...mentions.slice(0, index).toReversed()]
        .flatMap((other) =>
          other.type === "date" && other.year !== null ? [other.year] : [],
        )
        .at(0);
    if (year === undefined) {
      return null;
    }
    const full = { year, month: mention.month, day: mention.day };
    if (!exists(full)) {
      return null;
    }
    dates.push(full);
  }
  return dates;
};

const iso = (year: number, month: number, day: number): string =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

/** The smallest day, month or year covering every date, or null when no
 *  year covers them all. */
const covering = (dates: readonly FullDate[]): PartialDate | null => {
  const [first, ...rest] = dates;
  if (first === undefined) {
    return null;
  }
  if (rest.some((other) => other.year !== first.year)) {
    return null;
  }
  const { year, month, day } = first;
  if (month === null || rest.some((other) => other.month !== month)) {
    return { date: iso(year, 1, 1), precision: "year" };
  }
  if (day === null || rest.some((other) => other.day !== day)) {
    return { date: iso(year, month, 1), precision: "month" };
  }
  return { date: iso(year, month, day), precision: "day" };
};

/** A claim's asserted date as its row stores it. */
export const assertedDateColumns = (
  asserted: ClaimAssertedDate,
): {
  assertedOn: string | null;
  assertedOnPrecision: FactDatePrecision | null;
  assertedOnSource: ClaimAssertedOnSource;
} =>
  asserted.type === "none"
    ? { assertedOn: null, assertedOnPrecision: null, assertedOnSource: "none" }
    : {
        assertedOn: asserted.date,
        assertedOnPrecision: asserted.precision,
        assertedOnSource: asserted.source,
      };

/** What a claim's own words say about its date. */
export const readClaimTextDate = (text: string): ClaimTextDate => {
  const dates = completed(mentionsOf(normalize(text)));
  if (dates === null || dates.length === 0) {
    return { type: "silent" };
  }
  const covered = covering(dates);
  return covered === null ? { type: "spread" } : { type: "dated", ...covered };
};

/**
 * The date a claim asserts: its words' date when they give one, else the
 * grader's (`null` when it was not asked or gave none). Dates no single year
 * covers stay undated whatever the grader said.
 */
export const claimAssertedDate = (
  text: string,
  graderDate: PartialDate | null,
): ClaimAssertedDate => {
  const read = readClaimTextDate(text);
  switch (read.type) {
    case "dated": {
      return {
        type: "dated",
        source: "text",
        date: read.date,
        precision: read.precision,
      };
    }
    case "spread": {
      return { type: "none" };
    }
    case "silent": {
      return graderDate === null
        ? { type: "none" }
        : { type: "dated", source: "grader", ...graderDate };
    }
    default: {
      read satisfies never;
      return panic(`Unhandled claim date reading: ${String(read)}`);
    }
  }
};
