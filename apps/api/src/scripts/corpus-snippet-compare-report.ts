import { panic, Result, TaggedError } from "better-result";
import * as v from "valibot";

import { foldCorpusTerm } from "@/api/lib/legal-search/corpus-passage-highlight";
import type { CorpusPassageResult } from "@/api/lib/legal-search/corpus-passage-reader";
import { corpusTokens } from "@/api/lib/legal-search/corpus-tokens";
import { isCorpusIndexJurisdiction } from "@/api/lib/legal-search/index-naming";
import {
  searchHighlightMarks,
  stripSearchHighlightMarkup,
} from "@/api/lib/search/highlight";

/**
 * Pure half of `corpus-snippet-compare.ts`: argument and query-file parsing,
 * the per-hit fragment comparison, the aggregate, and the report renderings.
 * The runner owns the search, the storage reads and the clock.
 */

export class SnippetCompareFileError extends TaggedError(
  "SnippetCompareFileError",
)<{ message: string }> {}

const snippetCompareQuerySchema = v.strictObject({
  id: v.pipe(v.string(), v.nonEmpty()),
  text: v.pipe(v.string(), v.nonEmpty()),
  country: v.pipe(
    v.string(),
    v.check(isCorpusIndexJurisdiction, "must be a 2-8 letter country code"),
  ),
});

const snippetCompareQueryFileSchema = v.pipe(
  v.array(snippetCompareQuerySchema),
  v.minLength(1, "query file must hold at least one query"),
  v.check(
    (queries) =>
      new Set(queries.map((query) => query.id)).size === queries.length,
    "query ids must be unique",
  ),
);

export type SnippetCompareQuery = v.InferOutput<
  typeof snippetCompareQuerySchema
>;

export const parseSnippetCompareQueryFile = (
  content: string,
): Result<SnippetCompareQuery[], SnippetCompareFileError> => {
  const json = Result.try({
    try: (): unknown => JSON.parse(content),
    catch: (cause) =>
      new SnippetCompareFileError({
        message: `query file is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
  if (Result.isError(json)) {
    return Result.err(json.error);
  }
  const parsed = v.safeParse(snippetCompareQueryFileSchema, json.value);
  if (!parsed.success) {
    const issues = parsed.issues
      .map((issue) => `${v.getDotPath(issue) ?? "$"}: ${issue.message}`)
      .join("; ");
    return Result.err(
      new SnippetCompareFileError({ message: `invalid query file: ${issues}` }),
    );
  }
  return Result.ok(parsed.output);
};

export const DEFAULT_SNIPPET_COMPARE_LIMIT = 10;

type SnippetCompareArgs = {
  queriesPath: string;
  outDir: string;
  limit: number;
};

/**
 * The run this argv asks for, or why it asks for nothing. Unknown flags,
 * positionals and repeats are refused rather than ignored.
 */
type ParsedSnippetCompareArgs =
  | { type: "parsed"; args: SnippetCompareArgs }
  | { type: "invalid"; message: string };

const KNOWN_FLAGS = ["queries", "out-dir", "limit"] as const;
const DECIMAL_INTEGER = /^\d+$/u;

const invalid = (message: string): ParsedSnippetCompareArgs => ({
  type: "invalid",
  message,
});

export const parseSnippetCompareArgs = (
  argv: readonly string[],
): ParsedSnippetCompareArgs => {
  const flags = new Map<string, string>();
  let index = 0;
  while (index < argv.length) {
    const token = argv.at(index);
    if (token === undefined || !token.startsWith("--")) {
      return invalid(`unexpected argument: ${String(token)}`);
    }
    const name = token.slice(2);
    if (!KNOWN_FLAGS.some((known) => known === name)) {
      return invalid(`unknown option: ${token}`);
    }
    if (flags.has(name)) {
      return invalid(`--${name} was given more than once`);
    }
    const value = argv.at(index + 1);
    if (value === undefined || value.startsWith("--")) {
      return invalid(`--${name} requires a value`);
    }
    flags.set(name, value);
    index += 2;
  }

  const queriesPath = flags.get("queries");
  if (queriesPath === undefined) {
    return invalid("--queries is required");
  }
  const outDir = flags.get("out-dir");
  if (outDir === undefined) {
    return invalid("--out-dir is required");
  }
  const rawLimit = flags.get("limit");
  const limit =
    rawLimit === undefined
      ? DEFAULT_SNIPPET_COMPARE_LIMIT
      : Number.parseInt(rawLimit, 10);
  if (
    rawLimit !== undefined &&
    (!DECIMAL_INTEGER.test(rawLimit) ||
      !Number.isSafeInteger(limit) ||
      limit <= 0)
  ) {
    return invalid(`--limit must be a positive integer, got: ${rawLimit}`);
  }
  return { type: "parsed", args: { queriesPath, outDir, limit } };
};

/** How the two sides' marked terms relate. */
const MARK_AGREEMENTS = [
  "identical",
  "api_superset",
  "engine_superset",
  "divergent",
] as const;
type MarkAgreement = (typeof MARK_AGREEMENTS)[number];

/** Why a hit was not compared; the passage statuses come from the reader. */
const SNIPPET_COMPARE_SKIPS = [
  "unanchored",
  "no_payload",
  "anchor_not_found",
  "no_engine_snippet",
] as const;
type SnippetCompareSkip = (typeof SNIPPET_COMPARE_SKIPS)[number];

const SKIP_COVERAGE = {
  unanchored: "unanchored",
  no_payload: "no_payload",
  anchor_not_found: "anchor_not_found",
} as const satisfies Record<
  Exclude<CorpusPassageResult["status"], "found">,
  SnippetCompareSkip
>;

/** The skip a passage miss reports as. Total over the reader's statuses. */
export const passageSkipReason = (
  status: Exclude<CorpusPassageResult["status"], "found">,
): SnippetCompareSkip => SKIP_COVERAGE[status];

type FragmentComparison = {
  /**
   * Jaccard index of the fragments' folded word multisets: 1 when they hold
   * the same words, 0 when they share none.
   */
  overlap: number;
  /** Distinct folded terms each side marked. */
  engineMarks: string[];
  apiMarks: string[];
  marks: MarkAgreement;
};

const foldedWords = (text: string): string[] =>
  corpusTokens(text).map(foldCorpusTerm);

const multisetOverlap = (left: string[], right: string[]): number => {
  if (left.length === 0 && right.length === 0) {
    return 1;
  }
  const counts = new Map<string, number>();
  for (const word of left) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  let shared = 0;
  for (const word of right) {
    const available = counts.get(word) ?? 0;
    if (available > 0) {
      counts.set(word, available - 1);
      shared += 1;
    }
  }
  return shared / (left.length + right.length - shared);
};

const markedTerms = (snippet: string): Set<string> =>
  new Set(searchHighlightMarks(snippet).flatMap(foldedWords));

const markAgreement = (
  engine: Set<string>,
  api: Set<string>,
): MarkAgreement => {
  const apiCoversEngine = [...engine].every((term) => api.has(term));
  const engineCoversApi = [...api].every((term) => engine.has(term));
  if (apiCoversEngine && engineCoversApi) {
    return "identical";
  }
  if (apiCoversEngine) {
    return "api_superset";
  }
  return engineCoversApi ? "engine_superset" : "divergent";
};

/** One hit's two fragments, compared. Both are `<mark>`-format snippets. */
export const compareSnippetFragments = ({
  engineSnippet,
  apiSnippet,
}: {
  engineSnippet: string;
  apiSnippet: string;
}): FragmentComparison => {
  const engineMarks = markedTerms(engineSnippet);
  const apiMarks = markedTerms(apiSnippet);
  return {
    overlap: multisetOverlap(
      foldedWords(stripSearchHighlightMarkup(engineSnippet)),
      foldedWords(stripSearchHighlightMarkup(apiSnippet)),
    ),
    engineMarks: [...engineMarks].sort(),
    apiMarks: [...apiMarks].sort(),
    marks: markAgreement(engineMarks, apiMarks),
  };
};

export type SnippetCompareOutcome =
  | {
      status: "compared";
      /** The snippet the search returned for this hit. */
      engineFragment: string;
      /** The fragment cut here from the same passage. */
      apiFragment: string;
      comparison: FragmentComparison;
      /** Wall time of the cut alone, storage reads excluded. */
      highlightMs: number;
    }
  | { status: "skipped"; reason: SnippetCompareSkip };

export type SnippetCompareHit = {
  decisionId: string;
  anchorId: string | null;
  outcome: SnippetCompareOutcome;
};

export type SnippetCompareQueryRow = {
  query: SnippetCompareQuery;
  /** Wall time of the whole search call. */
  searchMs: number;
  /** Wall time of reading the page's passages from storage. */
  passageReadMs: number;
  hits: SnippetCompareHit[];
};

type SnippetCompareSummary = {
  queries: number;
  hits: number;
  compared: number;
  skipped: Record<SnippetCompareSkip, number>;
  marks: Record<MarkAgreement, number>;
  /** Share of compared hits, so an empty run reports 0 rather than NaN. */
  overlapAtLeastHalfShare: number;
  apiMarksCoverEngineShare: number;
  medianOverlap: number;
  timings: {
    searchMsMedian: number;
    passageReadMsMedian: number;
    highlightMsMedian: number;
    searchMsTotal: number;
    passageReadMsTotal: number;
    highlightMsTotal: number;
  };
};

const median = (values: readonly number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted.at(middle) ?? panic("median index is out of range");
  if (sorted.length % 2 === 1) {
    return upper;
  }
  const lower = sorted.at(middle - 1) ?? panic("median index is out of range");
  return (lower + upper) / 2;
};

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

const OVERLAP_AGREEMENT_THRESHOLD = 0.5;

export const summarizeSnippetComparison = (
  rows: readonly SnippetCompareQueryRow[],
): SnippetCompareSummary => {
  // Written out rather than built from the lists: the record type is what
  // makes every member counted, and a builder would need a cast to claim it.
  const skipped: Record<SnippetCompareSkip, number> = {
    unanchored: 0,
    no_payload: 0,
    anchor_not_found: 0,
    no_engine_snippet: 0,
  };
  const marks: Record<MarkAgreement, number> = {
    identical: 0,
    api_superset: 0,
    engine_superset: 0,
    divergent: 0,
  };
  const overlaps: number[] = [];
  const highlightMs: number[] = [];
  let hits = 0;
  let overlapAtLeastHalf = 0;
  let apiMarksCoverEngine = 0;

  for (const row of rows) {
    for (const { outcome } of row.hits) {
      hits += 1;
      if (outcome.status === "skipped") {
        skipped[outcome.reason] += 1;
        continue;
      }
      marks[outcome.comparison.marks] += 1;
      overlaps.push(outcome.comparison.overlap);
      highlightMs.push(outcome.highlightMs);
      if (outcome.comparison.overlap >= OVERLAP_AGREEMENT_THRESHOLD) {
        overlapAtLeastHalf += 1;
      }
      if (
        outcome.comparison.marks === "identical" ||
        outcome.comparison.marks === "api_superset"
      ) {
        apiMarksCoverEngine += 1;
      }
    }
  }

  const compared = overlaps.length;
  const share = (count: number): number =>
    compared === 0 ? 0 : count / compared;
  return {
    queries: rows.length,
    hits,
    compared,
    skipped,
    marks,
    overlapAtLeastHalfShare: share(overlapAtLeastHalf),
    apiMarksCoverEngineShare: share(apiMarksCoverEngine),
    medianOverlap: median(overlaps),
    timings: {
      searchMsMedian: median(rows.map(({ searchMs }) => searchMs)),
      passageReadMsMedian: median(
        rows.map(({ passageReadMs }) => passageReadMs),
      ),
      highlightMsMedian: median(highlightMs),
      searchMsTotal: sum(rows.map(({ searchMs }) => searchMs)),
      passageReadMsTotal: sum(rows.map(({ passageReadMs }) => passageReadMs)),
      highlightMsTotal: sum(highlightMs),
    },
  };
};

type SnippetCompareReport = {
  summary: SnippetCompareSummary;
  queries: readonly SnippetCompareQueryRow[];
};

export const snippetCompareReport = (
  rows: readonly SnippetCompareQueryRow[],
): SnippetCompareReport => ({
  summary: summarizeSnippetComparison(rows),
  queries: rows,
});

const percent = (share: number): string => `${(share * 100).toFixed(1)}%`;
const ms = (value: number): string => `${value.toFixed(1)} ms`;
const ratio = (value: number): string => value.toFixed(2);

/** A fragment as one Markdown table cell: no pipes, no line breaks. */
const cell = (text: string): string =>
  text.replaceAll("|", "\\|").replaceAll(/\s+/gu, " ").trim();

/** The Markdown report: the summary tables, then both fragments per hit. */
export const renderSnippetCompareMarkdown = (
  report: SnippetCompareReport,
): string => {
  const { summary } = report;
  const lines: string[] = [
    "# Passage fragments per hit",
    "",
    "Overlap is the Jaccard index of the fragments' folded word multisets;",
    "marks are compared as folded terms.",
    "",
    "## Summary",
    "",
    `- queries: ${summary.queries}`,
    `- hits: ${summary.hits}, compared: ${summary.compared}`,
    `- overlap >= 0.5: ${percent(summary.overlapAtLeastHalfShare)} of compared hits`,
    `- api marks cover engine marks: ${percent(summary.apiMarksCoverEngineShare)}`,
    `- median overlap: ${ratio(summary.medianOverlap)}`,
    "",
    "| measure | median | total |",
    "| --- | ---: | ---: |",
    `| search, per query | ${ms(summary.timings.searchMsMedian)} | ${ms(summary.timings.searchMsTotal)} |`,
    `| passage read, per query | ${ms(summary.timings.passageReadMsMedian)} | ${ms(summary.timings.passageReadMsTotal)} |`,
    `| fragment cut, per hit | ${ms(summary.timings.highlightMsMedian)} | ${ms(summary.timings.highlightMsTotal)} |`,
    "",
    "| marks | hits |",
    "| --- | ---: |",
    ...MARK_AGREEMENTS.map((mark) => `| ${mark} | ${summary.marks[mark]} |`),
    "",
    "| not compared | hits |",
    "| --- | ---: |",
    ...SNIPPET_COMPARE_SKIPS.map(
      (skip) => `| ${skip} | ${summary.skipped[skip]} |`,
    ),
    "",
  ];

  for (const row of report.queries) {
    lines.push(
      `## ${row.query.id} — ${row.query.country}: ${cell(row.query.text)}`,
      "",
      `search ${ms(row.searchMs)}, passage read ${ms(row.passageReadMs)}`,
      "",
      "| hit | side | overlap | marks | fragment |",
      "| --- | --- | ---: | --- | --- |",
    );
    for (const [index, hit] of row.hits.entries()) {
      const rank = index + 1;
      if (hit.outcome.status === "skipped") {
        lines.push(
          `| ${rank} | — | — | — | not compared: ${hit.outcome.reason} |`,
        );
        continue;
      }
      const { comparison, engineFragment, apiFragment } = hit.outcome;
      lines.push(
        `| ${rank} | engine | ${ratio(comparison.overlap)} | ${comparison.marks} | ${cell(engineFragment)} |`,
        `| ${rank} | api | | | ${cell(apiFragment)} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
};
