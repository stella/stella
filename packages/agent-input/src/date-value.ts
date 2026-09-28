import { parsePlainDate, Temporal } from "@stll/time";
/**
 * Calendar dates on the agent wire.
 *
 * ISO `YYYY-MM-DD` is the canonical form and the only one a document may store,
 * but a model drafting a Czech lease writes `1. 10. 2026` and one drafting an
 * English one writes `October 1, 2026`. Those spellings carry one meaning each,
 * so they are read.
 *
 * `01/02/2026` does not: it is 1 February under most of the world's convention
 * and 2 January under the United States', and nothing inside the string decides
 * which. A wrong date on an instrument is not a cosmetic defect, so an
 * ambiguous spelling is asked about with both readings named rather than
 * guessed from a default. Same for a two-digit year (`02-03-26`), which is
 * ambiguous in the day/month order as well as the century.
 *
 * A range bound (`date_from`, `date_to`) reads more, because which end it is
 * decides what a partial date means: `2020` as a start is 1 January and as an
 * end is 31 December, and `0001-01-01` or `9999-12-31` is the model saying the
 * range is open on that side. A single date is never read that way, since
 * nothing tells a lone `2020` which day of the year it is.
 */

import { isAbsentPlaceholder } from "./absent";
import type { Normalized, NormalizedOptional } from "./normalized";
import { askForFix, readAsAbsent, readValueAs } from "./normalized";

const DATE_VALUE_EXPECTED = "a calendar date";
export const DATE_VALUE_HINT =
  'Send the date as ISO YYYY-MM-DD ("2026-10-01"). The unambiguous ' +
  'spellings "1. 10. 2026", "1 October 2026" and "October 1, 2026" are read ' +
  "as well.";

export type DateValueOptions = {
  /** Locales to read besides English: the field's own `dateFormat` locale, so
   *  a document rendered in Czech accepts a Czech month name back, and one
   *  rendered in Portuguese accepts `1 de outubro de 2026` — the structure
   *  that locale renders, not only its month names. */
  locales?: readonly string[] | undefined;
  /** Which end of a range the date is. A bound reads a bare year or month as
   *  that end's first or last day, and asks when both ends arrive in one
   *  field. */
  bound?: DateBound | undefined;
};

export type DateBound = "start" | "end";

/** Day-first with dots is one convention wherever it is written, so it needs
 *  no disambiguation: `1.10.2026`, `01. 10. 2026`, `1. 10. 2026.` */
const DOTTED_DAY_FIRST_RE =
  /^(?<day>\d{1,2})\.\s*(?<month>\d{1,2})\.\s*(?<year>\d{4})\.?$/u;
/** Year-first with any separator: the four-digit head fixes the order. */
const YEAR_FIRST_RE =
  /^(?<year>\d{4})[-./]\s*(?<month>\d{1,2})[-./]\s*(?<day>\d{1,2})\.?$/u;
/** Slash- or dash-separated with a four-digit year at the end: the day/month
 *  order still has to be decided. */
const YEAR_LAST_RE =
  /^(?<first>\d{1,2})[/-](?<second>\d{1,2})[/-](?<year>\d{4})$/u;
/** An ISO datetime: the date part is the calendar date it names. */
const ISO_DATETIME_RE = /^(?<date>\d{4}-\d{2}-\d{2})[T ]\S*/u;
/** `1 October 2026`, `1. října 2026`, `1st October 2026`. */
const DAY_MONTH_YEAR_RE =
  /^(?<day>\d{1,2})(?:st|nd|rd|th)?\.?\s+(?<month>\p{L}+\.?)\s+(?<year>\d{4})$/u;
/** `October 1, 2026`, `Oct. 1 2026`. */
const MONTH_DAY_YEAR_RE =
  /^(?<month>\p{L}+\.?)\s+(?<day>\d{1,2})(?:st|nd|rd|th)?,?\s+(?<year>\d{4})$/u;

const MAX_MONTH = 12;

const pad = (value: number): string => String(value).padStart(2, "0");

/** The ISO spelling of a real calendar date, or null. */
const isoDate = (year: number, month: number, day: number): string | null =>
  parsePlainDate(
    `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`,
  )?.toString() ?? null;

/** A month name folded to the form the tables below are keyed by: lowercase,
 *  no trailing abbreviation dot, diacritics kept (they distinguish nothing a
 *  model gets wrong, and ICU emits them). */
const foldMonthName = (name: string): string =>
  name.toLowerCase().replace(/\.$/u, "").trim();

/**
 * Month names for one locale, in both the standalone form (`říjen`) and the
 * form ICU uses inside a full date (`října`, the Czech genitive), long and
 * abbreviated. Built from `Intl`, so a locale's names never have to be
 * hand-listed.
 */
const monthNamesFor = (locale: string): ReadonlyMap<string, number> => {
  const names = new Map<string, number>();
  const record = (name: string | undefined, month: number): void => {
    if (name !== undefined && /\p{L}/u.test(name)) {
      names.set(foldMonthName(name), month);
    }
  };
  for (const style of ["long", "short"] as const) {
    const standalone = new Intl.DateTimeFormat(locale, {
      month: style,
      timeZone: "UTC",
    });
    const inDate = new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: style,
      year: "numeric",
      timeZone: "UTC",
    });
    for (let month = 1; month <= MAX_MONTH; month += 1) {
      const instant = Temporal.PlainDate.from({
        year: 2026,
        month,
        day: 15,
      }).toZonedDateTime("UTC").epochMilliseconds;
      record(standalone.format(instant), month);
      record(
        inDate.formatToParts(instant).find((part) => part.type === "month")
          ?.value,
        month,
      );
    }
  }
  return names;
};

const monthNameCache = new Map<string, ReadonlyMap<string, number>>();

const monthNumber = (
  name: string,
  locales: readonly string[],
): number | null => {
  const folded = foldMonthName(name);
  for (const locale of locales) {
    const cached = monthNameCache.get(locale) ?? monthNamesFor(locale);
    monthNameCache.set(locale, cached);
    const month = cached.get(folded);
    if (month !== undefined) {
      return month;
    }
  }
  return null;
};

type Reading = { year: number; month: number; day: number };

const readNamedMonth = (
  spec: string,
  locales: readonly string[],
): Reading | null => {
  const match = DAY_MONTH_YEAR_RE.exec(spec) ?? MONTH_DAY_YEAR_RE.exec(spec);
  const groups = match?.groups;
  if (groups === undefined) {
    return null;
  }
  const month = monthNumber(groups["month"] ?? "", locales);
  return month === null
    ? null
    : { year: Number(groups["year"]), month, day: Number(groups["day"]) };
};

const readNumeric = (spec: string): Reading | null => {
  const groups = (DOTTED_DAY_FIRST_RE.exec(spec) ?? YEAR_FIRST_RE.exec(spec))
    ?.groups;
  return groups === undefined
    ? null
    : {
        year: Number(groups["year"]),
        month: Number(groups["month"]),
        day: Number(groups["day"]),
      };
};

/** The month styles a date field renders in, and therefore the structures a
 *  model copies back out of the document. */
const READ_MONTH_STYLES = ["long", "short"] as const;

/** The instant every locale probe is formatted at: a two-digit day and a
 *  two-digit month, so no part of the layout is a single character by
 *  accident. */
const LAYOUT_PROBE =
  Temporal.PlainDate.from("2026-10-15").toZonedDateTime(
    "UTC",
  ).epochMilliseconds;

/** Separators alone. A layout whose month is numeric and whose literals are
 *  only these is `01/02/2026` with one locale's ordering imposed on it, which
 *  is the reading this module refuses to guess. */
const SEPARATORS_ONLY_RE = /^[\s./,-]*$/u;

const REGEXP_META_RE = /[.*+?^${}()|[\]\\]/gu;

/** A literal ICU emits between the parts (`. `, ` de `, `年`), matched with the
 *  whitespace around it left to the writer. */
const literalPattern = (literal: string): string =>
  literal
    .split(/\s+/u)
    .map((chunk) => chunk.replace(REGEXP_META_RE, (meta) => `\\${meta}`))
    .join(String.raw`\s*`);

/** The parts a calendar-date layout is built from. A formatter asked for a
 *  day, a month and a year emits nothing else; anything else means the layout
 *  is not one this reader can rebuild. */
const LAYOUT_PART_KINDS = ["day", "month", "year", "literal"] as const;

type LayoutPartKind = (typeof LAYOUT_PART_KINDS)[number];

const layoutPartKind = (
  type: Intl.DateTimeFormatPartTypes,
): LayoutPartKind | null =>
  LAYOUT_PART_KINDS.find((kind) => kind === type) ?? null;

/**
 * The date structures one locale actually renders, as patterns: ICU's own
 * ordering and its own literals, so `1 de outubro de 2026` and
 * `2026. október 1.` are read where the field renders them that way. A layout
 * whose month is a number separated by nothing but punctuation is dropped: it
 * carries the day/month ambiguity this module never guesses at.
 */
const localeLayouts = (locale: string): readonly RegExp[] => {
  const layouts: RegExp[] = [];
  for (const month of READ_MONTH_STYLES) {
    const parts = new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month,
      year: "numeric",
      timeZone: "UTC",
    }).formatToParts(LAYOUT_PROBE);
    let source = "";
    let literals = "";
    let named = false;
    let readable = true;
    for (const part of parts) {
      const kind = layoutPartKind(part.type);
      if (kind === null) {
        readable = false;
        continue;
      }
      switch (kind) {
        case "day":
          source += String.raw`(?<day>\d{1,2})`;
          break;
        case "year":
          source += String.raw`(?<year>\d{4})`;
          break;
        case "month":
          named = /\p{L}/u.test(part.value);
          source += named
            ? String.raw`(?<month>[\p{L}\p{M}]+\.?)`
            : String.raw`(?<month>\d{1,2})`;
          break;
        case "literal":
          literals += part.value;
          source += literalPattern(part.value);
          break;
      }
    }
    if (readable && (named || !SEPARATORS_ONLY_RE.test(literals))) {
      layouts.push(new RegExp(String.raw`^\s*${source}\s*$`, "u"));
    }
  }
  return layouts;
};

const layoutCache = new Map<string, readonly RegExp[]>();

const NUMERIC_RE = /^\d+$/u;

const readLocaleLayout = (
  spec: string,
  locales: readonly string[],
): Reading | null => {
  for (const locale of locales) {
    const layouts = layoutCache.get(locale) ?? localeLayouts(locale);
    layoutCache.set(locale, layouts);
    for (const layout of layouts) {
      const groups = layout.exec(spec)?.groups;
      if (groups === undefined) {
        continue;
      }
      const spelled = groups["month"] ?? "";
      const month = NUMERIC_RE.test(spelled)
        ? Number(spelled)
        : monthNumber(spelled, [locale]);
      if (month !== null) {
        return {
          year: Number(groups["year"]),
          month,
          day: Number(groups["day"]),
        };
      }
    }
  }
  return null;
};

/** English is always read: it is the language of the schema and of most model
 *  output, whatever the document's own language is. */
const readingLocales = (options: DateValueOptions | undefined): string[] => [
  "en",
  ...(options?.locales ?? []),
];

const invalidAsk = (input: unknown) =>
  askForFix({
    input,
    expected: DATE_VALUE_EXPECTED,
    hint: DATE_VALUE_HINT,
  });

/** Both readings of a day/month pair, named, so the ask carries the fix rather
 *  than a rule the model has to look up. */
const ambiguousAsk = ({
  input,
  first,
  second,
  year,
}: {
  input: unknown;
  first: number;
  second: number;
  year: number;
}) => {
  const dayFirst = isoDate(year, second, first);
  const monthFirst = isoDate(year, first, second);
  if (dayFirst === null || monthFirst === null) {
    return invalidAsk(input);
  }
  return askForFix({
    input,
    expected: DATE_VALUE_EXPECTED,
    hint:
      `That reads as ${dayFirst} with the day first, or ${monthFirst} with ` +
      `the month first. Send "${dayFirst}" or "${monthFirst}".`,
  });
};

/** One whole calendar date, the reading every field shares. */
const readCalendarDate = (
  input: unknown,
  options?: DateValueOptions,
): Normalized<string> => {
  if (typeof input !== "string") {
    return invalidAsk(input);
  }
  const trimmed = input.trim();
  if (trimmed === "") {
    return invalidAsk(input);
  }

  // An ISO datetime names the calendar date in its head; the clock part is not
  // a date field's value.
  const spec = ISO_DATETIME_RE.exec(trimmed)?.groups?.["date"] ?? trimmed;

  const locales = readingLocales(options);
  const unambiguous =
    readNumeric(spec) ??
    readNamedMonth(spec, locales) ??
    readLocaleLayout(spec, locales);
  if (unambiguous !== null) {
    const iso = isoDate(unambiguous.year, unambiguous.month, unambiguous.day);
    return iso === null ? invalidAsk(input) : readValueAs(input, iso);
  }

  const yearLast = YEAR_LAST_RE.exec(spec)?.groups;
  if (yearLast === undefined) {
    return invalidAsk(input);
  }
  const first = Number(yearLast["first"]);
  const second = Number(yearLast["second"]);
  const year = Number(yearLast["year"]);
  // Only one reading survives when a component cannot be a month.
  if (first > MAX_MONTH && second <= MAX_MONTH) {
    const iso = isoDate(year, second, first);
    return iso === null ? invalidAsk(input) : readValueAs(input, iso);
  }
  if (second > MAX_MONTH && first <= MAX_MONTH) {
    const iso = isoDate(year, first, second);
    return iso === null ? invalidAsk(input) : readValueAs(input, iso);
  }
  if (first > MAX_MONTH && second > MAX_MONTH) {
    return invalidAsk(input);
  }
  // Both readings land on the same day when the two components agree, so
  // there is nothing to ask about.
  if (first === second) {
    const iso = isoDate(year, first, second);
    return iso === null ? invalidAsk(input) : readValueAs(input, iso);
  }
  return ambiguousAsk({ input, first, second, year });
};

const YEAR_ONLY_RE = /^(?<year>\d{4})$/u;
/** `2020-05`, `2020/5`: the four-digit head fixes which part is the year. */
const YEAR_MONTH_RE = /^(?<year>\d{4})[-/](?<month>\d{1,2})$/u;
/** `05/2020`, `5/2020`, `05.2020`: the four-digit tail fixes it the same way. */
const MONTH_YEAR_RE = /^(?<month>\d{1,2})[-/.]\s*(?<year>\d{4})$/u;

/**
 * A bare year or month as the first or last day it covers. Only a bound reads
 * these: as a start, `2020` means from the first day of 2020, and as an end,
 * through its last, which is what a model filtering "decisions from 2020"
 * means by it.
 */
const readPartialDate = (trimmed: string, bound: DateBound): string | null => {
  const yearOnly = YEAR_ONLY_RE.exec(trimmed)?.groups;
  if (yearOnly !== undefined) {
    const year = Number(yearOnly["year"]);
    return bound === "start" ? isoDate(year, 1, 1) : isoDate(year, 12, 31);
  }
  const groups = (YEAR_MONTH_RE.exec(trimmed) ?? MONTH_YEAR_RE.exec(trimmed))
    ?.groups;
  if (groups === undefined) {
    return null;
  }
  const year = Number(groups["year"]);
  const month = Number(groups["month"]);
  const first = isoDate(year, month, 1);
  if (first === null || bound === "start") {
    return first;
  }
  return isoDate(year, month, Temporal.PlainDate.from(first).daysInMonth);
};

/** How a model writes both ends of a range in one string, matched on the
 *  string with its whitespace runs collapsed to one space (halves are trimmed
 *  after the split), so no separator backtracks over a run of whitespace. The
 *  unspaced dash and the slash split only where both halves are dates on
 *  their own, so a single `2020-05` or `5/2020` never reads as two. */
const RANGE_SEPARATORS = [
  /\.\./u,
  /[–—]/u,
  / to /iu,
  / - /u,
  /\//u,
  /-/u,
] as const;

const WHITESPACE_RUN_RE = /\s+/gu;

/** One bound read on its own: a whole date, else a partial one. */
const readBoundHalf = (
  half: string,
  bound: DateBound,
  options: DateValueOptions | undefined,
): string | null => {
  const whole = readCalendarDate(half, options);
  return whole.ok ? whole.value : readPartialDate(half, bound);
};

/** Both ends of a range, when the string is one written into a single bound. */
const readRange = (
  trimmed: string,
  options: DateValueOptions | undefined,
): { start: string; end: string } | null => {
  const spaced = trimmed.replace(WHITESPACE_RUN_RE, " ");
  for (const separator of RANGE_SEPARATORS) {
    const halves = spaced.split(separator).map((half) => half.trim());
    const [left, right] = halves;
    if (halves.length !== 2 || left === undefined || right === undefined) {
      continue;
    }
    const start = readBoundHalf(left, "start", options);
    const end = readBoundHalf(right, "end", options);
    if (start !== null && end !== null) {
      return { start, end };
    }
  }
  return null;
};

const rangeAsk = (input: unknown, range: { start: string; end: string }) =>
  askForFix({
    input,
    expected: "a single date",
    hint:
      "This is one bound of a range: send the start and the end as two " +
      "separate date properties (for example date_from " +
      `"${range.start}" and date_to "${range.end}").`,
  });

/** Read a calendar date an agent spelled its own way, as ISO YYYY-MM-DD. With
 *  a `bound`, a bare year or month reads as that end's day, and a whole range
 *  in the one field asks for its two halves. */
export const normalizeDateValue = (
  input: unknown,
  options?: DateValueOptions,
): Normalized<string> => {
  const bound = options?.bound;
  if (bound === undefined || typeof input !== "string") {
    return readCalendarDate(input, options);
  }
  const trimmed = input.trim();
  // The range goes first: an ISO datetime's clock part is read away, which
  // would take `2020-01-01 to 2020-12-31` for its first half alone.
  const range = readRange(trimmed, options);
  if (range !== null) {
    return rangeAsk(input, range);
  }
  const whole = readCalendarDate(input, options);
  if (whole.ok) {
    return whole;
  }
  const partial = readPartialDate(trimmed, bound);
  return partial === null ? whole : readValueAs(input, partial);
};

/** Years no range filter means literally: `0001-01-01` and `9999-12-31` are
 *  how a database and a model spell "no limit on this side". Year 1000 is kept,
 *  since a medieval charter is a real bound in a legal corpus. */
const OPEN_BOUND_YEAR_BELOW = 1000;
const OPEN_BOUND_YEAR_FROM = 9000;

export type DateBoundOptions = {
  bound: DateBound;
  locales?: readonly string[] | undefined;
};

/**
 * Read one end of a date range. A placeholder or an open-ended sentinel date
 * is no bound at all, so the caller drops the property rather than filtering
 * to the year 1 or 9999.
 */
export const normalizeDateBound = (
  input: unknown,
  options: DateBoundOptions,
): NormalizedOptional<string> => {
  if (isAbsentPlaceholder(input)) {
    return readAsAbsent(input);
  }
  const result = normalizeDateValue(input, options);
  if (!result.ok) {
    return result;
  }
  const year = Temporal.PlainDate.from(result.value).year;
  return year < OPEN_BOUND_YEAR_BELOW || year >= OPEN_BOUND_YEAR_FROM
    ? readAsAbsent(input, "an open bound")
    : result;
};
