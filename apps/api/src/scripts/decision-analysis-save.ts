/**
 * Store analyses computed outside the application.
 *
 * The counterpart of `decision-analysis-input.ts`. Each record carries the
 * fingerprint and content hash that input reported, and both are re-derived
 * from the live row before anything is written, so an analysis computed over
 * a document that has since been re-parsed is refused rather than pinned
 * onto paragraphs it does not describe. The row is taken through the same
 * claim-then-save the in-app generation run uses, so the two writers cannot
 * interleave: a run holding the sentinel wins, and this run's own claim
 * blocks a run.
 *
 *   CASE_LAW_ANALYSIS_DATABASE_URL=postgres://... \
 *     bun run src/scripts/decision-analysis-save.ts --input analyses.json
 *
 * The input file is one record, or a list of them:
 *
 *   { "decisionId": "...", "fingerprint": "...", "contentHash": "...",
 *     "model": "...", "output": { "headings": [...], "holding": {...},
 *     "abstract": "...", "topics": [...] } }
 *
 * One line per record on stdout: `<decisionId> saved | unchanged |
 * rejected:<reason>`. Re-running the same file once it is stored reports
 * `unchanged` for every record and writes nothing, so a retry is safe.
 *
 * audit: skip — the analysis is global corpus state, not an organization's,
 * and this login has neither an organization nor a user to attribute a row
 * to. The run's own report is the record, and the stored analysis carries
 * the model and the fingerprint that produced it.
 */

import { Result } from "better-result";

import { createDbAnalysisStore } from "@/api/handlers/case-law/analysis/analysis-store-core";
import { applyAnalysisUpdate } from "@/api/handlers/case-law/analysis/analysis-update";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";

import { prepareCorpusReads, readRowAst } from "./decision-analysis.ast";
import { openAnalysisDatabase, readDecisionRows } from "./decision-analysis.db";
import {
  ANALYSIS_REJECTION,
  describeUpdateOutcome,
  flagValue,
  parseSubmissionFile,
  parseSubmissionRecord,
  readAnalysisDatabaseUrl,
  rejectionLine,
  resolveRowAnalysisInput,
  summariseOutcomes,
} from "./decision-analysis.logic";

const USAGE = `Usage: bun run src/scripts/decision-analysis-save.ts --input <path>

  --input <path>   JSON file: one submission record, or a list of them.

Requires CASE_LAW_ANALYSIS_DATABASE_URL.`;

const fail: (message: string) => never = (message) => {
  console.error(message);
  console.error(USAGE);
  process.exit(2);
};

const inputPath = flagValue(process.argv.slice(2), "input");
if (inputPath === undefined) {
  fail("Pass --input <path>.");
}

const parsedFile = parseSubmissionFile(await Bun.file(inputPath).text());
if (Result.isError(parsedFile)) {
  fail(parsedFile.error.message);
}

const url = readAnalysisDatabaseUrl(process.env);
if (Result.isError(url)) {
  fail(url.error.message);
}

const db = openAnalysisDatabase(url.value);
const store = createDbAnalysisStore(db);
await prepareCorpusReads();

const outcomes: string[] = [];
const report = (decisionId: string, outcome: string) => {
  outcomes.push(outcome);
  console.log(`${decisionId} ${outcome}`);
};

// Parse the whole file first, so the rows every accepted record needs are
// read in one statement rather than one per record.
const parsedRecords = parsedFile.value.map(parseSubmissionRecord);
const rowsById = await readDecisionRows(
  db,
  parsedRecords.flatMap((parsed) =>
    parsed.status === "ok"
      ? [brandPersistedCaseLawDecisionId(parsed.record.decisionId)]
      : [],
  ),
);

for (const parsed of parsedRecords) {
  if (parsed.status === "rejected") {
    report(parsed.decisionId, rejectionLine(parsed.reason));
    continue;
  }
  const { record } = parsed;
  const decisionId = brandPersistedCaseLawDecisionId(record.decisionId);

  const row = rowsById.get(decisionId);
  if (row === undefined) {
    report(record.decisionId, rejectionLine(ANALYSIS_REJECTION.notFound));
    continue;
  }
  const ast = await readRowAst(row);
  const resolved = resolveRowAnalysisInput({ ast, row });
  if (resolved.status === "rejected") {
    report(record.decisionId, rejectionLine(resolved.reason));
    continue;
  }

  const outcome = await applyAnalysisUpdate({
    decision: row,
    decisionId,
    input: resolved.input,
    now: new Date(),
    store,
    submission: {
      fingerprint: record.fingerprint,
      contentHash: record.contentHash,
      model: record.model,
      ...record.output,
    },
  });
  report(record.decisionId, describeUpdateOutcome(outcome));
}

for (const line of summariseOutcomes(outcomes)) {
  console.error(line);
}

process.exit(
  outcomes.some((outcome) => outcome.startsWith("rejected:")) ? 1 : 0,
);
