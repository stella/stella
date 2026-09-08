import { panic, Result } from "better-result";
import { mkdir } from "node:fs/promises";

import { envBase } from "@/api/env-base";
import { openCaseLawReadOnlySession } from "@/api/lib/case-law/maintenance-lane";
import { highlightCorpusPassage } from "@/api/lib/legal-search/corpus-passage-highlight";
import type { CorpusPassageResult } from "@/api/lib/legal-search/corpus-passage-reader";
import {
  readCaseLawPassagePointersTx,
  readCorpusPassages,
} from "@/api/lib/legal-search/corpus-passage-reader";
import { tokenizeCorpusFreeText } from "@/api/lib/legal-search/corpus-query";
import { documentMorphologyLanguage } from "@/api/lib/legal-search/morphology/corpus-language";
import { getLegalSearchProvider } from "@/api/lib/legal-search/provider";
import type { LegalSearchHit } from "@/api/lib/legal-search/types";
import {
  compareSnippetFragments,
  parseSnippetCompareArgs,
  parseSnippetCompareQueryFile,
  passageSkipReason,
  renderSnippetCompareMarkdown,
  snippetCompareReport,
  type SnippetCompareHit,
  type SnippetCompareOutcome,
  type SnippetCompareQueryRow,
} from "@/api/scripts/corpus-snippet-compare-report";

/**
 * Runs each query of a query set, cuts a fragment from every hit's passage and
 * writes a JSON and a Markdown report of both fragments per hit to `--out-dir`.
 *
 * The query file is JSON: an array of `{ id, text, country }`; a sample is
 * committed as corpus-snippet-compare.sample.json. Reads only (read-only
 * session, no maintenance lane) and requires
 * `LEGAL_SEARCH_PROVIDER=corpus-index`.
 *
 *   bun run --env-file=.env src/scripts/corpus-snippet-compare.ts \
 *     --queries src/scripts/corpus-snippet-compare.sample.json --out-dir .cache/snippets
 */

const USAGE = `Usage: bun run src/scripts/corpus-snippet-compare.ts [options]

  --queries <path>   Query set file (JSON: [{ id, text, country }]). Required.
  --out-dir <path>   Directory the JSON and Markdown reports are written to. Required.
  --limit <n>        Hits per query (default 10).`;

const USAGE_EXIT_CODE = 2;

// The explicit function-type annotation (not just a return annotation) is what
// lets control-flow analysis treat a `fail(...)` statement as unreachable-after
// and narrow past it.
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

const parsedArgs = parseSnippetCompareArgs(process.argv.slice(2));
if (parsedArgs.type === "invalid") {
  fail(parsedArgs.message);
}
const { queriesPath, outDir, limit } = parsedArgs.args;

if (envBase.LEGAL_SEARCH_PROVIDER !== "corpus-index") {
  abort(
    `LEGAL_SEARCH_PROVIDER is ${envBase.LEGAL_SEARCH_PROVIDER}; this comparison needs corpus-index`,
  );
}

const content = await Result.tryPromise({
  try: async () => await Bun.file(queriesPath).text(),
  catch: (cause) =>
    cause instanceof Error ? cause.message : "query file is not readable",
});
if (Result.isError(content)) {
  abort(`cannot read ${queriesPath}: ${content.error}`);
}
const queries = parseSnippetCompareQueryFile(content.value);
if (Result.isError(queries)) {
  fail(queries.error.message);
}

const provider = getLegalSearchProvider();
const { rootDb } = await openCaseLawReadOnlySession();

/**
 * One hit's fragment, timed, and its comparison with the returned snippet. A
 * hit whose passage or snippet is absent is reported as skipped.
 */
const compareHit = ({
  hit,
  passage,
  tokens,
}: {
  hit: LegalSearchHit;
  /** The reader answers in request order, so this is the hit's own passage. */
  passage: CorpusPassageResult;
  tokens: ReturnType<typeof tokenizeCorpusFreeText>;
}): SnippetCompareOutcome => {
  if (passage.status !== "found") {
    return { status: "skipped", reason: passageSkipReason(passage.status) };
  }
  if (hit.headline === null) {
    return { status: "skipped", reason: "no_engine_snippet" };
  }
  const startedAt = performance.now();
  const fragment = highlightCorpusPassage({
    passage: passage.text,
    tokens,
    language: documentMorphologyLanguage(hit.language),
  });
  const highlightMs = performance.now() - startedAt;
  return {
    status: "compared",
    engineFragment: hit.headline,
    apiFragment: fragment.html,
    comparison: compareSnippetFragments({
      engineSnippet: hit.headline,
      apiSnippet: fragment.html,
    }),
    highlightMs,
  };
};

const rows: SnippetCompareQueryRow[] = [];
for (const query of queries.value) {
  const searchStartedAt = performance.now();
  const searched = await provider.search({
    query: query.text,
    jurisdiction: query.country,
    limit,
  });
  const searchMs = performance.now() - searchStartedAt;
  if (Result.isError(searched)) {
    abort(`search for ${query.id} failed: ${searched.error.message}`);
  }

  const hits = searched.value.hits;
  const requests = hits.map((hit) => ({
    documentId: hit.decisionId,
    anchorId: hit.anchorId,
  }));
  const readStartedAt = performance.now();
  // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- one read per query in the run's own set; the page's pointers are already one `inArray`
  const pointers = await rootDb.transaction(
    async (tx) =>
      await readCaseLawPassagePointersTx(
        tx,
        requests.map(({ documentId }) => documentId),
      ),
  );
  const passages = await readCorpusPassages({ requests, pointers });
  const passageReadMs = performance.now() - readStartedAt;

  const tokens = tokenizeCorpusFreeText(query.text);
  const compared: SnippetCompareHit[] = hits.map((hit, index) => {
    const passage =
      passages.at(index) ??
      panic(`passage result missing for hit ${hit.decisionId}`);
    return {
      decisionId: hit.decisionId,
      anchorId: hit.anchorId,
      outcome: compareHit({ hit, passage, tokens }),
    };
  });

  rows.push({ query, searchMs, passageReadMs, hits: compared });
  console.error(`compared ${rows.length}/${queries.value.length}…`);
}

const report = snippetCompareReport(rows);
await mkdir(outDir, { recursive: true });
const jsonPath = `${outDir}/corpus-snippet-compare.json`;
const markdownPath = `${outDir}/corpus-snippet-compare.md`;
await Bun.write(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
await Bun.write(markdownPath, `${renderSnippetCompareMarkdown(report)}\n`);
console.log(`wrote ${jsonPath} and ${markdownPath}`);
process.exit(0);
