import { Result } from "better-result";

type LegacyHistoryRow = {
  at: string;
  id?: string | undefined;
  kind?: string | undefined;
  query?: string | undefined;
};

const readRows = (raw: string | null): LegacyHistoryRow[] => {
  const parsed =
    raw === null
      ? null
      : Result.try((): unknown => JSON.parse(raw)).unwrapOr(null);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(
    (row: unknown): row is LegacyHistoryRow =>
      typeof row === "object" &&
      row !== null &&
      "at" in row &&
      typeof row.at === "string" &&
      (("query" in row && typeof row.query === "string") ||
        ("kind" in row &&
          typeof row.kind === "string" &&
          "id" in row &&
          typeof row.id === "string")),
  );
};

const rowKey = (row: LegacyHistoryRow): string =>
  row.query === undefined
    ? `${row.kind ?? "unknown"}:${row.id ?? "unknown"}`
    : `search:${row.query}`;

const newestFirst = (left: LegacyHistoryRow, right: LegacyHistoryRow) => {
  if (left.at < right.at) {
    return 1;
  }
  if (left.at > right.at) {
    return -1;
  }
  return 0;
};

/** Merge the unscoped browser history into its owner's scoped history. */
export const mergeLegacyLawHistory = (
  legacyRaw: string,
  existingRaw: string | null,
): string | null => {
  const legacy = readRows(legacyRaw);
  if (legacy.length === 0) {
    return null;
  }
  const seen = new Set<string>();
  return JSON.stringify(
    [...readRows(existingRaw), ...legacy]
      .toSorted(newestFirst)
      .filter((row) => {
        const key = rowKey(row);
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      }),
  );
};
