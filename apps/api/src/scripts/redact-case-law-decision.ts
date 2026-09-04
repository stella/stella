import { panic } from "better-result";

/**
 * GDPR redaction / takedown for a single case-law decision: strips
 * personal text from corpus index, the pg-fts index, object storage, and the
 * Postgres columns. The decision row (citation-graph node) is kept.
 *
 *   bun run src/scripts/redact-case-law-decision.ts <decisionId>
 */
import { redactCaseLawDecision } from "@/api/handlers/case-law/erasure";
// eslint-disable-next-line no-restricted-imports -- CLI boundary: brands the decision id parsed from argv
import { toSafeId } from "@/api/lib/branded-types";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";
import { refreshCorpusS3, refreshS3 } from "@/api/lib/s3";

// Hold the maintenance lane before the first statement: operator passes over
// the case-law tables serialize here instead of deadlocking on row locks.
const { ingestionDb } = await enterCaseLawMaintenanceLane();

const decisionIdArg = process.argv[2];
if (decisionIdArg === undefined || decisionIdArg.length === 0) {
  console.error(
    "Usage: bun run src/scripts/redact-case-law-decision.ts <decisionId>",
  );
  process.exit(1);
}

await refreshS3();
await refreshCorpusS3();

const outcome = await redactCaseLawDecision({
  decisionId: toSafeId<"caseLawDecision">(decisionIdArg),
  scopedDb: ingestionDb,
});

const report = ((): { exitCode: 0 | 1; message: string } => {
  switch (outcome.type) {
    case "redacted":
      return {
        exitCode: 0,
        message: `Redacted decision ${decisionIdArg} across all stores.`,
      };
    case "not-found":
      return { exitCode: 1, message: `Decision ${decisionIdArg} not found.` };
    case "corpus-objects-remain": {
      const cause =
        outcome.error instanceof Error
          ? outcome.error.message
          : String(outcome.error);
      return {
        exitCode: 1,
        message: `Redacted decision ${decisionIdArg}, but corpus objects remain; pointer columns are kept for a retry: ${cause}`,
      };
    }
    default: {
      outcome satisfies never;
      return panic(`Unhandled redaction outcome: ${String(outcome)}`);
    }
  }
})();

if (report.exitCode === 0) {
  console.log(report.message);
} else {
  console.error(report.message);
}
process.exit(report.exitCode);
