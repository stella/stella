/**
 * Store reviewed citation polarities and apply them to the current citation
 * rows.
 *
 * The file is a JSON array of
 * `{ citingDecisionId, citationKey, polarity, reviewRef }` or
 * `{ citationId, polarity, reviewRef }`; a citation id is resolved to its
 * citing decision and key before anything is stored. A file with any invalid
 * entry is refused whole.
 *
 * A review outlives refreshes of the citing decision: ingestion re-applies it
 * to the re-inserted rows, and the classifier passes leave reviewed rows
 * alone.
 *
 * Idempotent: a stored review that already says the same is left as it is,
 * and a citation row already carrying it is not rewritten.
 *
 *   # what the run would change, writing nothing
 *   bun run src/scripts/apply-reviewed-citation-labels.ts --file labels.json
 *
 *   # store and apply
 *   bun run src/scripts/apply-reviewed-citation-labels.ts --file labels.json --apply
 */

import { Result } from "better-result";
import * as v from "valibot";

import {
  enterCaseLawMaintenanceLane,
  openCaseLawReadOnlySession,
} from "@/api/lib/case-law/maintenance-lane";
import {
  reviewedCitationLabelsFileSchema,
  runReviewedCitationLabels,
} from "@/api/scripts/apply-reviewed-citation-labels-plan";
import {
  readApplyFlag,
  rejectUnknownFlags,
  requiredFlagValue,
} from "@/api/scripts/repair-flags";

const USAGE = `Usage: bun run src/scripts/apply-reviewed-citation-labels.ts --file <labels.json> [--apply]

  --file <path>  JSON array of reviewed labels.
  --apply        Store and apply the labels. Omitted, the run only reports.
  --dry-run      Report only, the default; contradicts --apply.`;

rejectUnknownFlags({ known: ["file"], usage: USAGE });
const apply = readApplyFlag(USAGE);
const file = requiredFlagValue({ name: "file", usage: USAGE });

const raw = await Result.tryPromise(
  async (): Promise<unknown> => await Bun.file(file).json(),
);
if (raw.isErr()) {
  console.error(`Could not read JSON from ${file}: ${raw.error.message}`);
  process.exit(1);
}
const parsed = v.safeParse(reviewedCitationLabelsFileSchema, raw.value);
if (!parsed.success) {
  console.error(`${file} is not a valid list of reviewed labels:`);
  for (const issue of parsed.issues) {
    console.error(`  ${v.getDotPath(issue) ?? "(root)"}: ${issue.message}`);
  }
  process.exit(1);
}
const entries = parsed.output;

// A report run only reads, so it takes no lane and cannot block a writer.
const { rootDb } = apply
  ? await enterCaseLawMaintenanceLane()
  : await openCaseLawReadOnlySession();

const outcome = await rootDb.transaction(
  async (tx) =>
    await runReviewedCitationLabels(tx, entries, apply ? "apply" : "plan"),
);

if (outcome.type === "rejected") {
  console.error(`${file} cannot be applied; nothing was written:`);
  for (const problem of outcome.problems) {
    console.error(`  ${problem}`);
  }
  process.exit(1);
}

const { summary } = outcome;
const verb = outcome.type === "applied" ? "" : "would be ";
console.info(
  `Reviews: ${summary.insert} ${verb}inserted, ${summary.update} ${verb}updated, ${summary.unchanged} unchanged.`,
);
console.info(
  `Citation rows ${verb}relabelled: ${outcome.type === "applied" ? outcome.relabelled : summary.citationRows}.`,
);
if (summary.unmatched > 0) {
  console.info(
    `${summary.unmatched} labels match no current citation row; they apply once a refresh produces one.`,
  );
}
if (outcome.type === "planned") {
  console.info("Report only. Re-run with --apply to write.");
}

process.exit(0);
