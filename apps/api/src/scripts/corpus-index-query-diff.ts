import { Result } from "better-result";

import { getCorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import { caseLawCorpusQuery } from "@/api/lib/legal-search/corpus-query";
import {
  corpusIndexId,
  isCorpusIndexGeneration,
} from "@/api/lib/legal-search/index-naming";
import {
  divergedQueries,
  type GoldenQueryDiffRow,
  diffRankedDocuments,
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
/**
 * Passage-granularity generations return one hit per passage, so top-N
 * documents need more than N hits before dedup.
 */
const PASSAGE_HIT_FANOUT = 5;

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

const flagValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    fail(`--${name} requires a value`);
  }
  return value;
};

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

const content = await Bun.file(queriesPath).text();
const queries = parseGoldenQueryFile(content);
if (Result.isError(queries)) {
  fail(queries.error.message);
}

const client = getCorpusIndexClient();

type RunQueryOptions = {
  generation: string;
  jurisdiction: string;
  engineQuery: string;
};

const runQuery = async ({
  engineQuery,
  generation,
  jurisdiction,
}: RunQueryOptions): Promise<QueryRunOutcome> => {
  const indexId = corpusIndexId(generation, jurisdiction);
  const searched = await client.search({
    indexId,
    query: engineQuery,
    maxHits: depth * PASSAGE_HIT_FANOUT,
    sortBy: "_score",
  });
  if (Result.isError(searched)) {
    // Exit 2, not an uncaught throw: exit 1 is reserved for divergence,
    // and an unqueryable generation must not read as a diverged one.
    abort(`search against ${indexId} failed: ${searched.error.message}`);
  }
  return {
    totalHits: searched.value.numHits,
    ...rankDocumentHits(searched.value.hits, depth),
  };
};

const rows: GoldenQueryDiffRow[] = [];
for (const query of queries.value) {
  const engineQuery = caseLawCorpusQuery(query.text, query.filters ?? {});
  if (engineQuery === null) {
    fail(`query ${query.id} holds no searchable term: ${query.text}`);
  }
  // oxlint-disable-next-line no-await-in-loop -- one query at a time keeps the load on the engine bounded
  const [base, candidate] = await Promise.all([
    runQuery({
      generation: baseGeneration,
      jurisdiction: query.jurisdiction,
      engineQuery,
    }),
    runQuery({
      generation: candidateGeneration,
      jurisdiction: query.jurisdiction,
      engineQuery,
    }),
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
