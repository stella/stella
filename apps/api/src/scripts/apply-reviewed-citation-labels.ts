/**
 * Store reviewed citation polarities and apply them to the current citation
 * rows.
 *
 * The file is a JSON array of entries naming a citation either as
 * `{ citingDecisionId, citationKey }` or as `{ citationId }` (resolved to its
 * citing decision and key before anything is stored), with `polarity`,
 * `reviewRef` and `origin`. `origin` is `human-review`, or for a label a
 * model produced `ai-adjudicated` or `ai-annotation` together with `model`,
 * `promptVersion`, `promptSha256`, `evidenceSha256` (the passage the label was
 * read from), `runId` and `producedAt`.
 *
 * Each entry is settled on its own. One that does not validate or resolve is
 * invalid. Origin precedence runs human, then adjudicated, then annotation;
 * at equal origin a human review replaces the stored one, and a model label
 * replaces it only when produced later. An entry that may not replace the
 * stored review is refused and the stored review stands. `--results` writes one JSON line per entry with its
 * identifiers and outcome, and nothing of its content. Under `--apply` the
 * results are written before the run commits, so labels never change without
 * their record: a run whose results cannot be written applies nothing.
 *
 * A review outlives refreshes of the citing decision: ingestion re-applies it
 * to the re-inserted rows, and the classifier passes leave reviewed rows
 * alone.
 *
 * Idempotent: a stored review that already says the same is left as it is,
 * and a citation row already carrying it is not rewritten.
 *
 *   # what the run would change, writing nothing
 *   bun run src/scripts/apply-reviewed-citation-labels.ts --file labels.json --results results.jsonl
 *
 *   # store and apply
 *   bun run src/scripts/apply-reviewed-citation-labels.ts --file labels.json --results results.jsonl --apply
 */

import { Result } from "better-result";
import * as v from "valibot";

import {
  enterCaseLawMaintenanceLane,
  openCaseLawReadOnlySession,
} from "@/api/lib/case-law/maintenance-lane";
import {
  REVIEWED_LABEL_OUTCOME,
  applyReviewedCitationLabels,
  planReviewedCitationLabels,
  reviewedCitationLabelsFileSchema,
  reviewedLabelResultLines,
} from "@/api/scripts/apply-reviewed-citation-labels-plan";
import {
  readApplyFlag,
  rejectUnknownFlags,
  requiredFlagValue,
} from "@/api/scripts/repair-flags";

const USAGE = `Usage: bun run src/scripts/apply-reviewed-citation-labels.ts --file <labels.json> --results <results.jsonl> [--apply]

  --file <path>     JSON array of reviewed labels.
  --results <path>  Where to write one JSON line per entry: its identifiers and outcome.
  --apply           Store and apply the labels. Omitted, the run only reports.
  --dry-run         Report only, the default; contradicts --apply.`;

rejectUnknownFlags({ known: ["file", "results"], usage: USAGE });
const apply = readApplyFlag(USAGE);
const file = requiredFlagValue({ name: "file", usage: USAGE });
const resultsPath = requiredFlagValue({ name: "results", usage: USAGE });

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

// A report run only reads, so it takes no lane and cannot block a writer.
const { rootDb } = apply
  ? await enterCaseLawMaintenanceLane()
  : await openCaseLawReadOnlySession();

const recordPlan = async () => {
  const planned = await planReviewedCitationLabels(
    rootDb.transaction.bind(rootDb),
    parsed.output,
  );
  const written = await Result.tryPromise(
    async () =>
      await Bun.write(
        resultsPath,
        reviewedLabelResultLines(planned.rows, "plan"),
      ),
  );
  if (written.isErr()) {
    console.error(
      `Could not write results to ${resultsPath}: ${written.error.message}`,
    );
    process.exit(1);
  }
  return planned;
};

const recordApplication = async () => {
  const applied = await applyReviewedCitationLabels({
    transact: rootDb.transaction.bind(rootDb),
    input: parsed.output,
    resultsPath,
  });
  if (applied.isErr()) {
    console.error(applied.error.message);
    process.exit(1);
  }
  return applied.value;
};

const outcome = apply ? await recordApplication() : await recordPlan();

const { summary } = outcome;
const verb = outcome.type === "applied" ? "" : "would be ";
console.info(
  `Entries: ${summary.applied} ${verb}applied, ${summary.unmatched} ${verb}stored without a current citation row, ${summary.unchanged} unchanged, ${summary["refused-precedence"]} refused by precedence, ${summary.invalid} invalid.`,
);
console.info(
  `Citation rows ${verb}relabelled: ${outcome.type === "applied" ? outcome.relabelled : summary.citationRows}.`,
);
console.info(`Results: ${resultsPath}`);
if (outcome.type === "planned") {
  console.info("Report only. Re-run with --apply to write.");
}

process.exit(summary[REVIEWED_LABEL_OUTCOME.INVALID] > 0 ? 1 : 0);
