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
 * a row whose parse this database-only login cannot reach.
 *
 *   CASE_LAW_ANALYSIS_DATABASE_URL=postgres://... \
 *     bun run src/scripts/decision-analysis-candidates.ts --country CZE --limit 200
 *
 *   # ids only, straight into the input script
 *   CASE_LAW_ANALYSIS_DATABASE_URL=postgres://... \
 *     bun run src/scripts/decision-analysis-candidates.ts --ids-only > candidates.txt
 *
 * Reads only; connects as `stella_case_law_analysis_writer`.
 */

import { Result } from "better-result";

import { parsePersistedDecisionAnalysis } from "@stll/legal-ast/analysis";

import {
  candidateAsRow,
  listCandidateRows,
  openAnalysisDatabase,
} from "./decision-analysis.db";
import {
  flagValue,
  hasFlag,
  nonNegativeInteger,
  positiveInteger,
  readAnalysisDatabaseUrl,
  resolveRowAnalysisInput,
} from "./decision-analysis.logic";

const DEFAULT_LIMIT = 100;
const DEFAULT_MIN_CITATIONS = 1;
/**
 * How many rows to read per wanted candidate. Exclusions are decided in this
 * process (a current analysis, a refused source, an unreachable parse), so
 * the scan has to over-read; three is generous for a corpus where most
 * decisions carry no analysis yet.
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

const rows = await listCandidateRows(db, {
  country,
  minCitations,
  scan: limit * SCAN_FACTOR,
});

let printed = 0;
for (const candidate of rows) {
  if (printed === limit) {
    break;
  }
  const row = candidateAsRow(candidate);
  const resolved = resolveRowAnalysisInput(row);
  if (resolved.status === "rejected") {
    continue;
  }
  const stored = parsePersistedDecisionAnalysis(candidate.analysis);
  const isCurrent =
    stored !== null &&
    !("status" in stored) &&
    stored.version === 3 &&
    stored.inputFingerprint === resolved.input.fingerprint;
  if (isCurrent) {
    continue;
  }

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

if (printed === 0) {
  console.error("No candidates matched.");
}
process.exit(printed === 0 ? 1 : 0);
