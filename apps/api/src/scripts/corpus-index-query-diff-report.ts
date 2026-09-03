import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import type { CorpusIndexHit } from "@/api/lib/legal-search/corpus-index-client";
import { caseLawCorpusQueryFields } from "@/api/lib/legal-search/corpus-index-read-contract";
import { caseLawCorpusQuery } from "@/api/lib/legal-search/corpus-query";
import {
  corpusIndexRoute,
  isCorpusIndexJurisdiction,
} from "@/api/lib/legal-search/index-naming";

/**
 * Pure half of the golden-query diff harness: query-file parsing, top-N
 * document diffing, threshold gating, and table rendering. The runner
 * (corpus-index-query-diff.ts) owns the engine calls; everything here is
 * unit-testable without a live index.
 */

export class GoldenQueryFileError extends TaggedError("GoldenQueryFileError")<{
  message: string;
}> {}

const goldenQueryFiltersSchema = v.pipe(
  v.strictObject({
    court: v.optional(v.pipe(v.string(), v.nonEmpty())),
    dateFrom: v.optional(v.pipe(v.string(), v.isoDate())),
    dateTo: v.optional(v.pipe(v.string(), v.isoDate())),
    documentType: v.optional(v.pipe(v.string(), v.nonEmpty())),
    language: v.optional(v.pipe(v.string(), v.nonEmpty())),
    source: v.optional(v.pipe(v.string(), v.nonEmpty())),
  }),
  // A reversed range matches nothing in either generation, so the query
  // would pass the gate while testing neither index.
  v.forward(
    v.partialCheck(
      [["dateFrom"], ["dateTo"]],
      ({ dateFrom, dateTo }) =>
        dateFrom === undefined || dateTo === undefined || dateFrom <= dateTo,
      "dateFrom must not be after dateTo",
    ),
    ["dateTo"],
  ),
);

const goldenQuerySchema = v.strictObject({
  id: v.pipe(v.string(), v.nonEmpty()),
  jurisdiction: v.pipe(
    v.string(),
    v.check(
      isCorpusIndexJurisdiction,
      "must be a 2-8 letter jurisdiction code",
    ),
  ),
  text: v.pipe(v.string(), v.nonEmpty()),
  filters: v.optional(goldenQueryFiltersSchema),
});

const goldenQueryFileSchema = v.pipe(
  v.array(goldenQuerySchema),
  v.minLength(1, "query file must hold at least one query"),
  v.check(
    (queries) =>
      new Set(queries.map((query) => query.id)).size === queries.length,
    "query ids must be unique",
  ),
);

export type GoldenQuery = v.InferOutput<typeof goldenQuerySchema>;

export const parseGoldenQueryFile = (
  content: string,
): Result<GoldenQuery[], GoldenQueryFileError> => {
  const json = Result.try({
    try: (): unknown => JSON.parse(content),
    catch: (cause) =>
      new GoldenQueryFileError({
        message: `query file is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
  if (Result.isError(json)) {
    return Result.err(json.error);
  }
  const parsed = v.safeParse(goldenQueryFileSchema, json.value);
  if (!parsed.success) {
    const issues = parsed.issues
      .map((issue) => `${v.getDotPath(issue) ?? "$"}: ${issue.message}`)
      .join("; ");
    return Result.err(
      new GoldenQueryFileError({ message: `invalid query file: ${issues}` }),
    );
  }
  return Result.ok(parsed.output);
};

export type GoldenQueryRequest = {
  /** Physical index the query is sent to. */
  indexId: string;
  /** The engine query, jurisdiction clause included where the index needs one. */
  engineQuery: string;
};

/**
 * What one golden query asks one generation's engine for: the same route and
 * the same query assembly the search paths use, so a generation whose index
 * holds several jurisdictions is compared on the query's jurisdiction alone.
 * Null when the query text carries no searchable term.
 */
export const goldenQueryRequest = (
  generation: string,
  query: GoldenQuery,
): GoldenQueryRequest | null => {
  const { indexId, jurisdictionClause } = corpusIndexRoute(
    generation,
    query.jurisdiction,
  );
  // The diff compares generations, so the query each one gets is the query
  // that generation's schema supports: a clause over a field an index never
  // mapped would compare an invalid query with a valid one.
  const { surfaceFields, stemming } = caseLawCorpusQueryFields({
    generation,
    jurisdiction: query.jurisdiction,
    language: query.filters?.language,
  });
  const engineQuery = caseLawCorpusQuery({
    text: query.text,
    filters: { ...query.filters, jurisdiction: jurisdictionClause },
    stemming,
    surfaceFields,
  });
  return engineQuery === null ? null : { indexId, engineQuery };
};

export type QueryRunOutcome = {
  /** Engine-reported hit total (passage granularity, before dedup). */
  totalHits: number;
  /** Deduplicated document ids, best rank first. */
  rankedDocumentIds: readonly string[];
  /** Hits carrying no document identity; nonzero makes an undercount visible. */
  unidentifiedHits: number;
};

/**
 * Collapse score-ordered passage hits to ranked document ids: first
 * occurrence keeps the document's best rank, later passages of the same
 * document are dropped. Hits without a string `document_id` are counted
 * rather than silently skipped.
 */
export const rankDocumentHits = (
  hits: readonly CorpusIndexHit[],
  depth: number,
): Pick<QueryRunOutcome, "rankedDocumentIds" | "unidentifiedHits"> => {
  const seen = new Set<string>();
  const ranked: string[] = [];
  let unidentifiedHits = 0;
  for (const hit of hits) {
    const id = hit["document_id"];
    if (typeof id !== "string" || id.length === 0) {
      unidentifiedHits += 1;
      continue;
    }
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    if (ranked.length < depth) {
      ranked.push(id);
    }
  }
  return { rankedDocumentIds: ranked, unidentifiedHits };
};

export type GoldenQueryDiff = {
  /** Shared documents over the larger top-N list; 1 when both are empty. */
  overlap: number;
  /** 1 - overlap; what the threshold gates on. */
  divergence: number;
  /** candidate.totalHits - base.totalHits. */
  hitCountDelta: number;
  shared: number;
  /** In the candidate top-N but not the base top-N. */
  entered: number;
  /** In the base top-N but not the candidate top-N. */
  left: number;
  meanRankShift: number | null;
  maxRankShift: number | null;
};

type DiffRankedDocumentsOptions = {
  base: QueryRunOutcome;
  candidate: QueryRunOutcome;
  depth: number;
};

export const diffRankedDocuments = ({
  base,
  candidate,
  depth,
}: DiffRankedDocumentsOptions): GoldenQueryDiff => {
  const baseTop = base.rankedDocumentIds.slice(0, depth);
  const candidateTop = candidate.rankedDocumentIds.slice(0, depth);
  const baseRankById = new Map(baseTop.map((id, index) => [id, index]));
  const shifts: number[] = [];
  for (const [index, id] of candidateTop.entries()) {
    const baseRank = baseRankById.get(id);
    if (baseRank === undefined) {
      continue;
    }
    shifts.push(Math.abs(baseRank - index));
  }
  const shared = shifts.length;
  const larger = Math.max(baseTop.length, candidateTop.length);
  const overlap = larger === 0 ? 1 : shared / larger;
  return {
    overlap,
    divergence: 1 - overlap,
    hitCountDelta: candidate.totalHits - base.totalHits,
    shared,
    entered: candidateTop.length - shared,
    left: baseTop.length - shared,
    meanRankShift:
      shared === 0
        ? null
        : Number(
            (shifts.reduce((sum, shift) => sum + shift, 0) / shared).toFixed(2),
          ),
    maxRankShift: shared === 0 ? null : Math.max(...shifts),
  };
};

export type GoldenQueryDiffRow = {
  query: GoldenQuery;
  base: QueryRunOutcome;
  candidate: QueryRunOutcome;
  diff: GoldenQueryDiff;
};

export const divergedQueries = (
  rows: readonly GoldenQueryDiffRow[],
  maxDivergence: number,
): GoldenQueryDiffRow[] =>
  rows.filter((row) => row.diff.divergence > maxDivergence);

const percent = (fraction: number): string => `${(fraction * 100).toFixed(0)}%`;

const signed = (delta: number): string =>
  delta > 0 ? `+${delta}` : `${delta}`;

type RenderDiffTableOptions = {
  rows: readonly GoldenQueryDiffRow[];
  depth: number;
  maxDivergence: number;
};

/** Plain-text diff table plus a one-line pass/fail summary. */
export const renderDiffTable = ({
  rows,
  depth,
  maxDivergence,
}: RenderDiffTableOptions): string => {
  const header = [
    "query",
    `overlap@${depth}`,
    "hits base",
    "hits cand",
    "Δhits",
    "shift mean/max",
    "in/out",
    "unidentified",
    "verdict",
  ];
  const cells = rows.map((row) => [
    row.query.id,
    percent(row.diff.overlap),
    `${row.base.totalHits}`,
    `${row.candidate.totalHits}`,
    signed(row.diff.hitCountDelta),
    row.diff.meanRankShift === null
      ? "-"
      : `${row.diff.meanRankShift}/${row.diff.maxRankShift}`,
    `+${row.diff.entered}/-${row.diff.left}`,
    row.base.unidentifiedHits + row.candidate.unidentifiedHits === 0
      ? "-"
      : `${row.base.unidentifiedHits}/${row.candidate.unidentifiedHits}`,
    row.diff.divergence > maxDivergence ? "DIVERGED" : "ok",
  ]);
  const widths = header.map((column, index) =>
    Math.max(column.length, ...cells.map((row) => row[index]?.length ?? 0)),
  );
  const renderLine = (line: readonly string[]): string =>
    line
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd();
  const separator = widths.map((width) => "-".repeat(width)).join("  ");

  const diverged = divergedQueries(rows, maxDivergence);
  let worst: GoldenQueryDiffRow | null = null;
  for (const row of rows) {
    if (worst === null || row.diff.divergence > worst.diff.divergence) {
      worst = row;
    }
  }
  const summary =
    worst === null
      ? "no queries compared"
      : `${rows.length - diverged.length}/${rows.length} queries within divergence <= ${maxDivergence}; worst ${worst.diff.divergence.toFixed(2)} (${worst.query.id})`;

  return [
    renderLine(header),
    separator,
    ...cells.map(renderLine),
    "",
    summary,
  ].join("\n");
};
