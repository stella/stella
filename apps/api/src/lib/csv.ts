/**
 * Shared CSV utilities with built-in formula injection protection.
 *
 * Always use `escapeCSV` from this module instead of hand-rolling
 * CSV escaping. It handles both delimiter quoting and spreadsheet
 * formula neutralization (=, +, -, @, tab, CR, LF prefixes).
 */

const FORMULA_PREFIX_RE = /^\s*[=+\-@\t\r\n]/u;

/**
 * Escape a value for safe inclusion in a CSV cell.
 *
 * - Quotes values containing commas, double quotes, or newlines.
 * - Neutralizes leading formula characters (=, +, -, @, tab, CR, LF),
 *   including when preceded by whitespace (Excel trims leading
 *   spaces before evaluating), by prefixing with a tab inside
 *   quotes so spreadsheets treat the cell as text.
 */
export const escapeCSV = (value: string): string => {
  const isFormula = FORMULA_PREFIX_RE.test(value);
  const needsQuote =
    isFormula ||
    value.includes(",") ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r");

  if (!needsQuote) {
    return value;
  }

  const escaped = value.replace(/"/gu, '""');
  if (isFormula) {
    return `"\t${escaped}"`;
  }
  return `"${escaped}"`;
};
