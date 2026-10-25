import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import * as v from "valibot";

const windowSchema = v.pipe(
  v.strictObject({
    start: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(0),
      v.maxValue(2_147_483_647),
    ),
    end: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(2_147_483_647),
    ),
  }),
  v.check(({ start, end }) => end > start, "Evidence window must contain text"),
);
const windowsSchema = v.tupleWithRest([windowSchema], windowSchema);

type CitationEvidenceWindow = Readonly<v.InferOutput<typeof windowSchema>>;
export type CitationEvidenceWindows = readonly [
  CitationEvidenceWindow,
  ...CitationEvidenceWindow[],
];

/** JSON storage boundary; null is absence, an empty set is invalid. */
export const parseCitationEvidenceWindows = (
  value: unknown,
): CitationEvidenceWindows | null => v.parse(v.nullable(windowsSchema), value);

// Keep persisted windows bounded like the integer offsets they replace.
const INVALID_WINDOW_PATH =
  '$[*] ? (@.type() != "object" || !exists(@.start) || !exists(@.end) || @.start.type() != "number" || @.end.type() != "number" || @.start < 0 || @.end <= @.start || @.start > 2147483647 || @.end > 2147483647 || @.start % 1 != 0 || @.end % 1 != 0 || exists(@.keyvalue() ? (@.key != "start" && @.key != "end")))';

export const citationEvidenceWindowsValidSql = (column: SQLWrapper) =>
  sql<boolean>`CASE WHEN ${column} IS NULL THEN true
    WHEN jsonb_typeof(${column}) <> 'array' THEN false
    ELSE jsonb_array_length(${column}) > 0
      AND NOT jsonb_path_exists(${column}, ${INVALID_WINDOW_PATH}::jsonpath)
    END`;
