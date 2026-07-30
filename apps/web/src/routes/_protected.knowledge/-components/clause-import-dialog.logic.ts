import { Result } from "better-result";

const countCSVRecords = (text: string): number | null => {
  let count = 0;
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let closedQuote = false;

  const finishCell = () => {
    row.push(cell);
    cell = "";
    closedQuote = false;
  };

  const finishRow = () => {
    finishCell();
    if (row.length > 1 || row.at(0) !== "") {
      count += 1;
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
      return null;
    }

    if (character === '"') {
      if (cell.length > 0) {
        return null;
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
    return null;
  }
  if (row.length > 0 || cell.length > 0 || closedQuote) {
    finishRow();
  }

  return count;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const getClauseImportPreviewCount = (
  text: string,
  fileName: string,
): number => {
  if (fileName.toLowerCase().endsWith(".csv")) {
    const recordCount = countCSVRecords(text);
    return recordCount === null ? 0 : Math.max(recordCount - 1, 0);
  }

  const parsed = Result.try((): unknown => JSON.parse(text));
  if (Result.isError(parsed) || !isRecord(parsed.value)) {
    return 0;
  }

  const clauses = parsed.value["clauses"];
  return Array.isArray(clauses) ? clauses.length : 0;
};
