/**
 * Print the model input for one or more court decisions.
 *
 * Exactly what the in-app generation run feeds its model: the system prompt
 * the decision's language selects, the user message carrying the text with
 * its paragraph anchor ids, the fingerprint that digests both, the row's
 * content hash, and the JSON Schema the answer must satisfy. A producer
 * outside the application computes the analysis against this and writes it
 * back with `decision-analysis-save.ts`, where the fingerprint and content
 * hash it echoes are the fence.
 *
 *   CASE_LAW_ANALYSIS_DATABASE_URL=postgres://... \
 *     bun run src/scripts/decision-analysis-input.ts --decision <decisionId>
 *
 *   CASE_LAW_ANALYSIS_DATABASE_URL=postgres://... \
 *     bun run src/scripts/decision-analysis-input.ts --ids-file candidates.txt \
 *     > inputs.json
 *
 * The decision's parse comes from wherever the corpus keeps it: most rows
 * hold only a pointer, and the object is read with the task role. A run
 * reports `ast-unavailable` only when there is no parse anywhere.
 *
 * Reads only. The database login is `stella_case_law_analysis_writer`; the
 * corpus objects are read with the task role (see `decision-analysis.ast.ts`).
 */

import { Result } from "better-result";

import { ANALYSIS_OUTPUT_JSON_SCHEMA } from "@/api/handlers/case-law/analysis/analysis-output";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";

import { prepareCorpusReads, readRowAst } from "./decision-analysis.ast";
import { openAnalysisDatabase, readDecisionRows } from "./decision-analysis.db";
import {
  ANALYSIS_REJECTION,
  flagValue,
  parseIdsFile,
  readAnalysisDatabaseUrl,
  resolveRowAnalysisInput,
  summariseOutcomes,
  type AnalysisRejection,
} from "./decision-analysis.logic";

const USAGE = `Usage: bun run src/scripts/decision-analysis-input.ts (--decision <id> | --ids-file <path>)

  --decision <id>     One decision id.
  --ids-file <path>   A file of decision ids, one per line; # comments ignored.

Requires CASE_LAW_ANALYSIS_DATABASE_URL.`;

const fail: (message: string) => never = (message) => {
  console.error(message);
  console.error(USAGE);
  process.exit(2);
};

const argv = process.argv.slice(2);
const single = flagValue(argv, "decision");
const idsFile = flagValue(argv, "ids-file");

if ((single === undefined) === (idsFile === undefined)) {
  fail("Pass exactly one of --decision or --ids-file.");
}

const ids =
  single === undefined
    ? parseIdsFile(await Bun.file(idsFile ?? "").text())
    : [single];

if (ids.length === 0) {
  fail("No decision ids to read.");
}

const url = readAnalysisDatabaseUrl(process.env);
if (Result.isError(url)) {
  fail(url.error.message);
}

const db = openAnalysisDatabase(url.value);

type InputRecord =
  | {
      decisionId: string;
      status: "ok";
      language: string;
      systemPrompt: string;
      userMessage: string;
      fingerprint: string;
      contentHash: string | null;
    }
  | { decisionId: string; status: "rejected"; reason: AnalysisRejection };

// One statement for the whole batch: a run over a candidate list is the
// normal case, and a query per id would be a query per candidate.
const rowsById = await readDecisionRows(
  db,
  ids.map((id) => brandPersistedCaseLawDecisionId(id)),
);

await prepareCorpusReads();

const records: InputRecord[] = [];
for (const id of ids) {
  const row = rowsById.get(id);
  if (row === undefined) {
    records.push({
      decisionId: id,
      status: "rejected",
      reason: ANALYSIS_REJECTION.notFound,
    });
    continue;
  }
  // Sequentially, one corpus object at a time: a batch is an operator's
  // pass over the corpus, not a request, and the object store is shared
  // with the serving path.
  const ast = await readRowAst(row);
  const resolved = resolveRowAnalysisInput({ ast, row });
  if (resolved.status === "rejected") {
    records.push({
      decisionId: id,
      status: "rejected",
      reason: resolved.reason,
    });
    continue;
  }
  records.push({
    decisionId: id,
    status: "ok",
    language: resolved.input.language,
    systemPrompt: resolved.input.systemPrompt,
    userMessage: resolved.input.userMessage,
    fingerprint: resolved.input.fingerprint,
    contentHash: row.contentHash,
  });
}

// One schema for the whole run: it is a property of the analysis, not of any
// decision, and repeating it per record would bury the inputs.
console.log(
  JSON.stringify(
    { outputSchema: ANALYSIS_OUTPUT_JSON_SCHEMA, decisions: records },
    null,
    2,
  ),
);

// The tally goes to stderr, so stdout stays a single JSON document a
// producer can pipe straight into its own tooling.
for (const line of summariseOutcomes(
  records.map((record) =>
    record.status === "ok" ? "ok" : `rejected:${record.reason}`,
  ),
)) {
  console.error(line);
}

const rejected = records.filter(
  (record) => record.status === "rejected",
).length;
process.exit(rejected === records.length && rejected > 0 ? 1 : 0);
