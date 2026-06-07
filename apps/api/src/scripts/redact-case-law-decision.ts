/**
 * GDPR redaction / takedown for a single case-law decision: strips
 * personal text from Quickwit, the pg-fts index, object storage, and the
 * Postgres columns. The decision row (citation-graph node) is kept.
 *
 *   bun run src/scripts/redact-case-law-decision.ts <decisionId>
 */
import { createIngestionDb } from "@/api/db";
import { rlsDb } from "@/api/db/root";
import { redactCaseLawDecision } from "@/api/handlers/case-law/erasure";
import { toSafeId } from "@/api/lib/branded-types";
import { refreshCorpusS3, refreshS3 } from "@/api/lib/s3";

const decisionIdArg = process.argv[2];
if (decisionIdArg === undefined || decisionIdArg.length === 0) {
  console.error(
    "Usage: bun run src/scripts/redact-case-law-decision.ts <decisionId>",
  );
  process.exit(1);
}

const ingestionDb = createIngestionDb(rlsDb);
await refreshS3();
await refreshCorpusS3();

const found = await redactCaseLawDecision({
  decisionId: toSafeId<"caseLawDecision">(decisionIdArg),
  scopedDb: ingestionDb,
});

console.log(
  found
    ? `Redacted decision ${decisionIdArg} across all stores.`
    : `Decision ${decisionIdArg} not found.`,
);

process.exit(found ? 0 : 1);
