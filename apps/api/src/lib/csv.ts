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
  SUCCESS: "success",
} as const;

type CSVParseResult =
  | {
      status: typeof CSV_PARSE_STATUS.INVALID;
    }
  | {
      status: typeof CSV_PARSE_STATUS.SUCCESS;
      rows: string[][];
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
export const parseCSV = (text: string): CSVParseResult => {
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

  const finishRow = () => {
    finishCell();
    if (row.length > 1 || row.at(0) !== "") {
      rows.push(row);
    }
    row = [];
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
      if (character === ",") {
        finishCell();
        continue;
      }
      if (character === "\r" || character === "\n") {
        finishRow();
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
    if (character === ",") {
      finishCell();
      continue;
    }
    if (character === "\r" || character === "\n") {
      finishRow();
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

  if (row.length > 0 || cell.length > 0 || closedQuote) {
    finishRow();
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
