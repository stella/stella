import { Result } from "better-result";

import type {
  CorpusIndexClient,
  CorpusIndexHit,
} from "@/api/lib/legal-search/corpus-index-client";
import { isCorpusIndexGeneration } from "@/api/lib/legal-search/index-naming";
import { LIMITS } from "@/api/lib/limits";
import { corpusIndexQueryDiffClientForGeneration } from "@/api/scripts/corpus-index-query-diff-client";
import {
  divergedQueries,
  type GoldenQuery,
  type GoldenQueryDiffRow,
  diffRankedDocuments,
  goldenQueryRequest,
  parseGoldenQueryFile,
  type QueryRunOutcome,
  rankDocumentHits,
  renderDiffTable,
} from "@/api/scripts/corpus-index-query-diff-report";

/**
 * Golden-query diff between two index generations. Runs every query from
 * the given file against both generations' physical indexes and reports
 * per-query top-N overlap, rank shifts, and hit-count deltas as a table.
 * Exits 1 when any query diverges beyond the threshold, so the run can
 * gate a generation flip; 2 on usage or engine errors.
 *
 * The query file is JSON: an array of
 * `{ id, jurisdiction, text, filters? }` entries, where `filters` accepts
 * the case-law corpus filter fields (court, dateFrom, dateTo,
 * documentType, language, source). A small synthetic sample is committed
 * as corpus-index-query-diff.sample.json.
 *
 *   CORPUS_INDEX_SEARCH_ENDPOINT=... bun run src/scripts/corpus-index-query-diff.ts \
 *     --queries queries.json --base case_law_v1 --candidate case_law_v2
 */

const DEFAULT_DEPTH = 20;
const DEFAULT_MAX_DIVERGENCE = 0.2;

const USAGE = `Usage: bun run src/scripts/corpus-index-query-diff.ts [options]

  --queries <path>         Query list file (JSON; see script doc comment). Required.
  --base <generation>      Baseline generation prefix, e.g. case_law_v1. Required.
  --candidate <generation> Candidate generation prefix. Required.
  --top <n>                Compared document depth per query (default ${DEFAULT_DEPTH}).
  --max-divergence <0..1>  Per-query divergence (1 - overlap) above which the
                           run exits 1 (default ${DEFAULT_MAX_DIVERGENCE}).`;

const USAGE_EXIT_CODE = 2;
const DIVERGED_EXIT_CODE = 1;

// The explicit function-type annotation (not just a return annotation) is
// what lets control-flow analysis treat a `fail(...)` statement as
// unreachable-after and narrow past it.
const fail: (message: string) => never = (message) => {
  console.error(message);
  console.error(USAGE);
  process.exit(USAGE_EXIT_CODE);
};

/** Runtime failure: same exit code as `fail`, without re-printing usage. */
const abort: (message: string) => never = (message) => {
  console.error(message);
  process.exit(USAGE_EXIT_CODE);
};

const KNOWN_FLAGS = new Set([
  "queries",
  "base",
  "candidate",
  "top",
  "max-divergence",
]);

/**
 * Strict parse of `--flag value` pairs: unknown flags, positional
 * arguments, and duplicates all fail rather than being silently ignored,
 * so a typo cannot run the diff with a default it did not ask for.
 */
const parseFlags = (argv: readonly string[]): Map<string, string> => {
  const flags = new Map<string, string>();
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) {
      fail(`unexpected argument: ${token}`);
    }
    const name = token.slice(2);
    if (!KNOWN_FLAGS.has(name)) {
      fail(`unknown option: ${token}`);
    }
    if (flags.has(name)) {
      fail(`--${name} was given more than once`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`--${name} requires a value`);
    }
    flags.set(name, value);
    index += 2;
  }
  return flags;
};

const flags = parseFlags(process.argv.slice(2));

const flagValue = (name: string): string | undefined => flags.get(name);

const requiredFlag = (name: string): string =>
  flagValue(name) ?? fail(`--${name} is required`);

const generationFlag = (name: string): string => {
  const value = requiredFlag(name);
  if (!isCorpusIndexGeneration(value)) {
    fail(`--${name} is not a valid generation prefix: ${value}`);
  }
  return value;
};

const DECIMAL_INTEGER = /^\d+$/u;

const queriesPath = requiredFlag("queries");
const baseGeneration = generationFlag("base");
const candidateGeneration = generationFlag("candidate");

const rawDepth = flagValue("top");
const depth =
  rawDepth === undefined ? DEFAULT_DEPTH : Number.parseInt(rawDepth, 10);
if (
  rawDepth !== undefined &&
  (!DECIMAL_INTEGER.test(rawDepth) ||
    !Number.isSafeInteger(depth) ||
    depth <= 0)
) {
  fail(`--top must be a positive integer, got: ${rawDepth}`);
}

const rawMaxDivergence = flagValue("max-divergence");
const maxDivergence =
  rawMaxDivergence === undefined
    ? DEFAULT_MAX_DIVERGENCE
    : Number(rawMaxDivergence);
if (!Number.isFinite(maxDivergence) || maxDivergence < 0 || maxDivergence > 1) {
  fail(`--max-divergence must be within [0, 1], got: ${rawMaxDivergence}`);
}

const content = await Result.tryPromise({
  try: async () => await Bun.file(queriesPath).text(),
  catch: (cause) =>
    cause instanceof Error ? cause.message : "query file is not readable",
});
if (Result.isError(content)) {
  // A missing input file is a runtime failure (exit 2), not divergence.
  abort(`cannot read ${queriesPath}: ${content.error}`);
}
const queries = parseGoldenQueryFile(content.value);
if (Result.isError(queries)) {
  fail(queries.error.message);
}

/**
 * Bounded offset scan until the top-N distinct documents are collected.
 * A passage-granularity index can put hundreds of one judgment's passages
 * ahead of the next document, so a single fixed-size page cannot promise
 * N distinct documents; the scan widens page by page (the production
 * reader's shape) up to the shared scan limit.
 *
 * Each generation gets its own route: from generation 3 on a physical
 * index may hold several jurisdictions, and the query then carries the
 * jurisdiction clause the search paths carry.
 */
const runQuery = async (
  client: CorpusIndexClient,
  generation: string,
  query: GoldenQuery,
): Promise<QueryRunOutcome> => {
  const request =
    goldenQueryRequest(generation, query) ??
    fail(`query ${query.id} holds no searchable term: ${query.text}`);
  const { indexId, engineQuery } = request;
  const scanned: CorpusIndexHit[] = [];
  let totalHits = 0;
  let startOffset = 0;
  let ranked = rankDocumentHits(scanned, depth);
  for (;;) {
    const searched = await client.search({
      indexId,
      query: engineQuery,
      maxHits: LIMITS.corpusIndexSearchCandidateLimit,
      startOffset,
      sortBy: "_score",
    });
    if (Result.isError(searched)) {
      // Exit 2, not an uncaught throw: exit 1 is reserved for divergence,
      // and an unqueryable generation must not read as a diverged one.
      abort(`search against ${indexId} failed: ${searched.error.message}`);
    }
    totalHits = searched.value.numHits;
    scanned.push(...searched.value.hits);
    startOffset += searched.value.hits.length;
    ranked = rankDocumentHits(scanned, depth);
    const exhausted =
      searched.value.hits.length === 0 || startOffset >= totalHits;
    if (
      ranked.rankedDocumentIds.length >= depth ||
      exhausted ||
      startOffset >= LIMITS.corpusIndexSearchScanLimit
    ) {
      break;
    }
  }
  return { totalHits, ...ranked };
};

const rows: GoldenQueryDiffRow[] = [];
const baseClient = corpusIndexQueryDiffClientForGeneration(baseGeneration);
const candidateClient =
  corpusIndexQueryDiffClientForGeneration(candidateGeneration);
for (const query of queries.value) {
  const [base, candidate] = await Promise.all([
    runQuery(baseClient, baseGeneration, query),
    runQuery(candidateClient, candidateGeneration, query),
  ]);
  rows.push({
    query,
    base,
    candidate,
    diff: diffRankedDocuments({ base, candidate, depth }),
  });
  console.error(`compared ${rows.length}/${queries.value.length}…`);
}

console.log(renderDiffTable({ rows, depth, maxDivergence }));
process.exit(
  divergedQueries(rows, maxDivergence).length > 0 ? DIVERGED_EXIT_CODE : 0,
);
