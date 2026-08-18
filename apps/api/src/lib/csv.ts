/**
 * Shared CSV utilities with built-in formula injection protection.
 *
 * Always use `escapeCSV` from this module instead of hand-rolling
 * CSV escaping. It handles both delimiter quoting and spreadsheet
 * formula neutralization (=, +, -, @, tab, CR, LF prefixes).
 */

const FORMULA_PREFIX_RE = /^\s*[=+\-@\t\r\n]/u;

export const CSV_PARSE_STATUS = {
  INVALID: "invalid",
  ROW_LIMIT_EXCEEDED: "row-limit-exceeded",
  SUCCESS: "success",
} as const;

export const CSV_DELIMITERS = [",", ";", "\t"] as const;

export type CSVDelimiter = (typeof CSV_DELIMITERS)[number];

type CSVParseResult =
  | {
      status: typeof CSV_PARSE_STATUS.INVALID;
    }
  | {
      status: typeof CSV_PARSE_STATUS.ROW_LIMIT_EXCEEDED;
      rows: string[][];
    }
  | {
      status: typeof CSV_PARSE_STATUS.SUCCESS;
      rows: string[][];
    };

type CSVParseOptions = {
  delimiter?: CSVDelimiter;
  /**
   * Stop as soon as record `maxRows + 1` is reached and report
   * `ROW_LIMIT_EXCEEDED` with the records parsed so far, so an
   * oversized upload is rejected without parsing its whole suffix.
   */
  maxRows?: number;
};

const restoreGuardedFormula = (value: string): string => {
  if (!value.startsWith("\t")) {
    return value;
  }

  const unguarded = value.slice(1);
  return FORMULA_PREFIX_RE.test(unguarded) ? unguarded : value;
};

/**
 * Parse RFC 4180-style CSV without accepting ambiguous malformed input.
 *
 * Blank records are ignored. Quotes may only open at the start of a cell, and
 * after a closing quote only a delimiter, record boundary, or EOF is valid.
 */
export const parseCSV = (
  text: string,
  { delimiter = ",", maxRows }: CSVParseOptions = {},
): CSVParseResult => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let closedQuote = false;

  const finishCell = () => {
    row.push(restoreGuardedFormula(cell));
    cell = "";
    closedQuote = false;
  };

  const finishRow = (): boolean => {
    finishCell();
    if (row.length > 1 || row.at(0) !== "") {
      if (maxRows !== undefined && rows.length >= maxRows) {
        return false;
      }
      rows.push(row);
    }
    row = [];
    return true;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const nextCharacter = text[index + 1];

    if (inQuotes) {
      if (character !== '"') {
        cell += character;
        continue;
      }

      if (nextCharacter === '"') {
        cell += '"';
        index += 1;
        continue;
      }

      inQuotes = false;
      closedQuote = true;
      continue;
    }

    if (closedQuote) {
      if (character === delimiter) {
        finishCell();
        continue;
      }
      if (character === "\r" || character === "\n") {
        if (!finishRow()) {
          return { rows, status: CSV_PARSE_STATUS.ROW_LIMIT_EXCEEDED };
        }
        if (character === "\r" && nextCharacter === "\n") {
          index += 1;
        }
        continue;
      }
      return { status: CSV_PARSE_STATUS.INVALID };
    }

    if (character === '"') {
      if (cell.length > 0) {
        return { status: CSV_PARSE_STATUS.INVALID };
      }
      inQuotes = true;
      continue;
    }
    if (character === delimiter) {
      finishCell();
      continue;
    }
    if (character === "\r" || character === "\n") {
      if (!finishRow()) {
        return { rows, status: CSV_PARSE_STATUS.ROW_LIMIT_EXCEEDED };
      }
      if (character === "\r" && nextCharacter === "\n") {
        index += 1;
      }
      continue;
    }
    cell += character;
  }

  if (inQuotes) {
    return { status: CSV_PARSE_STATUS.INVALID };
  }

  if ((row.length > 0 || cell.length > 0 || closedQuote) && !finishRow()) {
    return { rows, status: CSV_PARSE_STATUS.ROW_LIMIT_EXCEEDED };
  }

  return { rows, status: CSV_PARSE_STATUS.SUCCESS };
};

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
