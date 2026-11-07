// parser-output-unchanged: the printed-date reader moved here verbatim from provision-version-grammar.ts.
/**
 * Calendar dates as courts and authorities print them: "1. listopadu 2018",
 * "17. 10. 2016", "7. decembra 2020". One owner, so a citation's applied
 * version and a decision's letterhead date read the same words the same way.
 */

const escapedAlternatives = (words: readonly string[]): string =>
  words
    .toSorted((a, b) => b.length - a.length)
    .map((word) => RegExp.escape(word))
    .join("|");

/** Month words in the genitive a date prints, mapped to their number. */
export type PrintedMonthNames = Readonly<Record<string, number>>;

/**
 * A regular-expression source matching one printed date, with named groups
 * `day`, `month` (numeric) or `monthName`, and `year`. Embed it in a larger
 * pattern; read a match back with `printedDateOf`.
 */
export const printedDatePattern = (monthNames: PrintedMonthNames): string =>
  `(?<day>\\d{1,2})\\.\\s*(?:(?<month>\\d{1,2})\\.\\s*|(?<monthName>${escapedAlternatives(Object.keys(monthNames))})\\s+)(?<year>\\d{4})(?![\\p{L}\\p{N}/]|\\.\\d)`;

const validDate = (year: number, month: number, day: number): boolean => {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) {
    return false;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const maximum = days.at(month - 1);
  return maximum !== undefined && day <= maximum;
};

/**
 * The ISO date (YYYY-MM-DD) a `printedDatePattern` match names, or undefined
 * when its month word is unknown or the day does not exist in that month.
 */
export const printedDateOf = (
  groups: Readonly<Record<string, string | undefined>> | undefined,
  monthNames: PrintedMonthNames,
): string | undefined => {
  const day = Number(groups?.["day"]);
  const year = Number(groups?.["year"]);
  const monthName = groups?.["monthName"];
  const month =
    monthName === undefined
      ? Number(groups?.["month"])
      : monthNames[monthName.toLowerCase()];
  if (month === undefined || !validDate(year, month, day)) {
    return undefined;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};
