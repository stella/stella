/**
 * The key two case numbers are compared by.
 *
 * Publishers print the same case with its year in full or in two digits
 * ("C-679/2018" and "C-679/18", "IV. ÚS 452/2011" and "IV. ÚS 452/11"), and a
 * stored key keeps the form its publisher printed. Two keys name the same
 * case when their match keys are equal: a trailing four-digit year of the
 * 1900s or 2000s after a slash, optionally followed by a sheet ("-33"), is
 * read as its last two digits. Nothing else changes, so a year in the middle
 * of a key ("p.20056/2005/52"), a number of three or five digits, and a key
 * with no slash before the year keep their spelling.
 *
 * Only comparisons read the match key; every stored key keeps its printed
 * form. The SQL rendering of the same function, which the expression indexes
 * on the key columns are built from, is
 * `caseNumberMatchKeySql` in `apps/api/src/lib/case-law/case-number-match-key.ts`,
 * and `case-number-match-key.db.test.ts` there holds the two renderings to one
 * answer. A cross-century collision ("/1918" and "/2018") is left to what a
 * caller already decides by: the resolver's rule that a decision cannot cite
 * one published after it, and its court and date adjudication.
 */

/**
 * The year tail, as a pattern both regular expression dialects read alike:
 * ECMAScript here and PostgreSQL's advanced regular expressions in the SQL
 * rendering. ASCII digit ranges rather than `\d`, which PostgreSQL widens to
 * every digit its collation knows.
 */
export const CASE_NUMBER_FULL_YEAR_TAIL_PATTERN =
  "/(?:19|20)([0-9]{2})(-[0-9]+)?$";

const FULL_YEAR_TAIL = new RegExp(CASE_NUMBER_FULL_YEAR_TAIL_PATTERN, "u");

/** A key as it is compared: its trailing full year read as two digits. */
export const caseNumberMatchKey = (key: string): string =>
  key.replace(FULL_YEAR_TAIL, "/$1$2");
