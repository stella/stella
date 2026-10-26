import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import { apiDateTimeSchema } from "@stll/api-contract/api-date";
import { sha256Hex } from "@stll/sha256/bun";
import { Temporal } from "@stll/time";

import type { SafeId } from "@/api/lib/branded-types";

const PINNED_DECISION_IDS: readonly SafeId<"caseLawDecision">[] = [];

export const CORPUS_SLICE_CONFIG = {
  recentYears: 5,
  pinnedDecisionIds: PINNED_DECISION_IDS,
} as const;

export type CorpusSliceRow = {
  id: SafeId<"caseLawDecision">;
  sourceKey: string;
  court: string;
  decisionDate: string | null;
};

export type CorpusSliceYear =
  { type: "year"; year: number } | { type: "undated" };

const corpusSliceYearSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("year"),
    year: v.pipe(v.number(), v.integer()),
  }),
  v.strictObject({ type: v.literal("undated") }),
]);

const corpusSliceManifestSchema = v.strictObject({
  version: v.literal(1),
  asOf: apiDateTimeSchema,
  recentYears: v.pipe(v.number(), v.integer(), v.minValue(1)),
  memberCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  memberIdsSha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)),
  cells: v.array(
    v.strictObject({
      sourceKey: v.pipe(v.string(), v.nonEmpty()),
      court: v.pipe(v.string(), v.nonEmpty()),
      year: corpusSliceYearSchema,
      count: v.pipe(v.number(), v.integer(), v.minValue(1)),
    }),
  ),
});

export type CorpusSliceManifest = v.InferOutput<
  typeof corpusSliceManifestSchema
>;

export class CorpusSliceManifestError extends TaggedError(
  "CorpusSliceManifestError",
)<{ message: string }> {}

const calendarDay = (instant: Date): Temporal.PlainDate =>
  Temporal.Instant.fromEpochMilliseconds(instant.getTime())
    .toZonedDateTimeISO("UTC")
    .toPlainDate();

const startYear = (asOf: Date): number =>
  calendarDay(asOf).year - CORPUS_SLICE_CONFIG.recentYears + 1;

export const isInCorpusSlice = (
  row: Pick<CorpusSliceRow, "id" | "decisionDate">,
  { asOf }: { asOf: Date },
): boolean => {
  if (CORPUS_SLICE_CONFIG.pinnedDecisionIds.includes(row.id)) {
    return true;
  }
  if (row.decisionDate === null) {
    return false;
  }
  const day = Temporal.PlainDate.from(row.decisionDate);
  return (
    day.year >= startYear(asOf) &&
    Temporal.PlainDate.compare(day, calendarDay(asOf)) <= 0
  );
};

const yearOf = (decisionDate: string | null): CorpusSliceYear =>
  decisionDate === null
    ? { type: "undated" }
    : {
        type: "year",
        year: Number.parseInt(decisionDate.slice(0, 4), 10),
      };

const cellKey = (
  sourceKey: string,
  court: string,
  year: CorpusSliceYear,
): string =>
  JSON.stringify([
    sourceKey,
    court,
    year.type === "year" ? String(year.year) : year.type,
  ]);

const compareCells = (
  left: CorpusSliceManifest["cells"][number],
  right: CorpusSliceManifest["cells"][number],
): number => {
  const leftKey = cellKey(left.sourceKey, left.court, left.year);
  const rightKey = cellKey(right.sourceKey, right.court, right.year);
  if (leftKey === rightKey) {
    return 0;
  }
  return leftKey < rightKey ? -1 : 1;
};

export const corpusSliceManifest = (
  rows: readonly CorpusSliceRow[],
  asOf: Date,
): CorpusSliceManifest => {
  const members = rows.filter((row) => isInCorpusSlice(row, { asOf }));
  const grouped = new Map<string, CorpusSliceManifest["cells"][number]>();
  for (const row of members) {
    const year = yearOf(row.decisionDate);
    const key = cellKey(row.sourceKey, row.court, year);
    const cell = grouped.get(key);
    if (cell === undefined) {
      grouped.set(key, {
        sourceKey: row.sourceKey,
        court: row.court,
        year,
        count: 1,
      });
    } else {
      cell.count += 1;
    }
  }
  const ids = members.map(({ id }) => id).toSorted();
  return {
    version: 1,
    asOf: asOf.toISOString(),
    recentYears: CORPUS_SLICE_CONFIG.recentYears,
    memberCount: members.length,
    memberIdsSha256: sha256Hex(ids.join("\n")),
    cells: [...grouped.values()].toSorted(compareCells),
  };
};

export const parseCorpusSliceManifest = (
  value: unknown,
): Result<CorpusSliceManifest, CorpusSliceManifestError> => {
  const parsed = v.safeParse(corpusSliceManifestSchema, value);
  if (parsed.success) {
    return Result.ok(parsed.output);
  }
  return Result.err(
    new CorpusSliceManifestError({
      message: `invalid corpus slice manifest: ${parsed.issues
        .map((issue) => `${v.getDotPath(issue) ?? "$"}: ${issue.message}`)
        .join("; ")}`,
    }),
  );
};
