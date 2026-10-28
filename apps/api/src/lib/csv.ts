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

type CSVParseResultWithMetadata =
  | {
      status: typeof CSV_PARSE_STATUS.INVALID;
    }
  | {
      status: typeof CSV_PARSE_STATUS.ROW_LIMIT_EXCEEDED;
      rows: string[][];
      rowNumbers: number[];
      skippedBlankRowCount: number;
    }
  | {
      status: typeof CSV_PARSE_STATUS.SUCCESS;
      rows: string[][];
      rowNumbers: number[];
      skippedBlankRowCount: number;
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
export const parseCSVWithMetadata = (
  text: string,
  { delimiter = ",", maxRows }: CSVParseOptions = {},
): CSVParseResultWithMetadata => {
  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let closedQuote = false;
  let lineNumber = 1;
  let rowLineNumber = 1;
  let skippedBlankRowCount = 0;

  const finishCell = () => {
    row.push(restoreGuardedFormula(cell));
    cell = "";
    closedQuote = false;
  };

  const finishRow = (): boolean => {
    finishCell();
    if (row.some((value) => value.trim().length > 0)) {
      if (maxRows !== undefined && rows.length >= maxRows) {
        return false;
      }
      rows.push(row);
      rowNumbers.push(rowLineNumber);
    } else {
      skippedBlankRowCount += 1;
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
        if (character === "\n") {
          lineNumber += 1;
        } else if (character === "\r" && nextCharacter !== "\n") {
          lineNumber += 1;
        }
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
          return {
            rowNumbers,
            rows,
            skippedBlankRowCount,
            status: CSV_PARSE_STATUS.ROW_LIMIT_EXCEEDED,
          };
        }
        if (character === "\r" && nextCharacter === "\n") {
          index += 1;
        }
        lineNumber += 1;
        rowLineNumber = lineNumber;
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
        return {
          rowNumbers,
          rows,
          skippedBlankRowCount,
          status: CSV_PARSE_STATUS.ROW_LIMIT_EXCEEDED,
        };
      }
      if (character === "\r" && nextCharacter === "\n") {
        index += 1;
      }
      lineNumber += 1;
      rowLineNumber = lineNumber;
      continue;
    }
    cell += character;
  }

  if (inQuotes) {
    return { status: CSV_PARSE_STATUS.INVALID };
  }

  if ((row.length > 0 || cell.length > 0 || closedQuote) && !finishRow()) {
    return {
      rowNumbers,
      rows,
      skippedBlankRowCount,
      status: CSV_PARSE_STATUS.ROW_LIMIT_EXCEEDED,
    };
  }

  return {
    rowNumbers,
    rows,
    skippedBlankRowCount,
    status: CSV_PARSE_STATUS.SUCCESS,
  };
};

export const parseCSV = (text: string, options: CSVParseOptions = {}) => {
  const parsed = parseCSVWithMetadata(text, options);
  return parsed.status === CSV_PARSE_STATUS.INVALID
    ? parsed
    : { rows: parsed.rows, status: parsed.status };
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
