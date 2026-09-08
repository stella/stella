/**
 * List the decisions worth analysing first.
 *
 * Ordered by `citation_authority`, the importance signal the corpus already
 * stores: a decay-weighted sum over incoming citations in which every
 * citation is weighted by the citing court's tier from the court-weight
 * registry and by its polarity. Ordering by it is therefore ordering by
 * citation count and court tier at once, from a column the corpus maintains,
 * rather than by a ranking this script invents. The presence of a
 * publisher's own headnote, the only reporting signal the corpus stores, is
 * shown beside it: an operator picking a batch wants to see it, but it is
 * not evidence of how much later case law leans on the decision.
 *
 * A decision that already holds a current analysis is left out: current
 * means version 3 over the fingerprint the row's own text digests to today,
 * so a re-parse since the analysis was written puts the decision back on the
 * list. So does a source that withholds derived AI use, a redacted row, and
 * a decision with no parse at all, in the row or in object storage.
 *
 *   CASE_LAW_ANALYSIS_DATABASE_URL=postgres://... \
 *     bun run src/scripts/decision-analysis-candidates.ts --country CZE --limit 200
 *
 *   # ids only, straight into the input script
 *   CASE_LAW_ANALYSIS_DATABASE_URL=postgres://... \
 *     bun run src/scripts/decision-analysis-candidates.ts --ids-only > candidates.txt
 *
 * Reads only. The database login is `stella_case_law_analysis_writer`; the
 * corpus objects are read with the task role (see `decision-analysis.ast.ts`).
 */

import { Result } from "better-result";

import { parsePersistedDecisionAnalysis } from "@stll/legal-ast/analysis";

import { prepareCorpusReads, readRowAst } from "./decision-analysis.ast";
import {
  candidateAsRow,
  listCandidateRows,
  openAnalysisDatabase,
  type CandidateCursor,
} from "./decision-analysis.db";
import {
  flagValue,
  hasFlag,
  nonNegativeInteger,
  positiveInteger,
  readAnalysisDatabaseUrl,
  resolveRowAnalysisInput,
  summariseOutcomes,
} from "./decision-analysis.logic";

const DEFAULT_LIMIT = 100;
const DEFAULT_MIN_CITATIONS = 1;
/**
 * How many rows one page reads per wanted candidate. Exclusions are decided
 * in this process, so a page over-reads; the loop below pages on when a page
 * does not fill the list.
 */
const SCAN_FACTOR = 3;

const USAGE = `Usage: bun run src/scripts/decision-analysis-candidates.ts [options]

  --country <code>       Restrict to one country (the corpus's own code, e.g. CZE).
  --limit <n>            Candidates to print (default ${DEFAULT_LIMIT}).
  --min-citations <n>    Minimum stored citation count (default ${DEFAULT_MIN_CITATIONS}).
  --ids-only             Print decision ids alone, for --ids-file.

Requires CASE_LAW_ANALYSIS_DATABASE_URL.`;

const fail: (message: string) => never = (message) => {
  console.error(message);
  console.error(USAGE);
  process.exit(2);
};

const argv = process.argv.slice(2);
const limit = positiveInteger(flagValue(argv, "limit"), DEFAULT_LIMIT);
const minCitations = nonNegativeInteger(
  flagValue(argv, "min-citations"),
  DEFAULT_MIN_CITATIONS,
);
const country = flagValue(argv, "country");
const idsOnly = hasFlag(argv, "ids-only");

const url = readAnalysisDatabaseUrl(process.env);
if (Result.isError(url)) {
  fail(url.error.message);
}

const db = openAnalysisDatabase(url.value);

await prepareCorpusReads();

const outcomes: string[] = [];
let printed = 0;
let cursor: CandidateCursor | undefined;

/**
 * One page of the ranking: a cursor walk, not a per-row lookup. Each call is
 * one statement returning `limit * SCAN_FACTOR` rows, and the loop advances
 * the cursor only when a page did not fill the list. A single bounded window
 * would report "no candidates" while eligible decisions sat one row past its
 * edge, because the exclusions are decided in this process rather than in
 * the query.
 */
const readCandidatePage = async (after: CandidateCursor | undefined) =>
  await listCandidateRows(db, {
    after,
    country,
    minCitations,
    scan: limit * SCAN_FACTOR,
  });

while (printed < limit) {
  const rows = await readCandidatePage(cursor);
  if (rows.length === 0) {
    break;
  }
  const last = rows.at(-1);
  cursor =
    last === undefined
      ? undefined
      : {
          citationAuthority: last.citationAuthority,
          citationCount: last.citationCount,
          id: last.id,
        };

  for (const candidate of rows) {
    if (printed === limit) {
      break;
    }
    const row = candidateAsRow(candidate);
    const ast = await readRowAst(row);
    const resolved = resolveRowAnalysisInput({ ast, row });
    if (resolved.status === "rejected") {
      outcomes.push(`skipped:${resolved.reason}`);
      continue;
    }
    const stored = parsePersistedDecisionAnalysis(candidate.analysis);
    const isCurrent =
      stored !== null &&
      !("status" in stored) &&
      stored.version === 3 &&
      stored.inputFingerprint === resolved.input.fingerprint;
    if (isCurrent) {
      outcomes.push("skipped:already-current");
      continue;
    }

    outcomes.push("candidate");
    printed += 1;
    if (idsOnly) {
      console.log(candidate.id);
      continue;
    }
    console.log(
      [
        candidate.id,
        candidate.court,
        candidate.country,
        `citations=${String(candidate.citationCount)}`,
        `authority=${candidate.citationAuthority?.toFixed(3) ?? "0.000"}`,
        `reported=${candidate.reportedInCollection ? "yes" : "no"}`,
      ].join("\t"),
    );
  }
}

// The tally goes to stderr, so `--ids-only` output stays pipeable.
for (const line of summariseOutcomes(outcomes)) {
  console.error(line);
}

if (printed === 0) {
  console.error("No candidates matched.");
}
process.exit(printed === 0 ? 1 : 0);
