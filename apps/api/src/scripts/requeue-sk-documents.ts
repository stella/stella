import {
  enterCaseLawMaintenanceLane,
  openCaseLawReadOnlySession,
} from "@/api/lib/case-law/maintenance-lane";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import {
  countParkedDocuments,
  loadDeferredDocumentSourceId,
  MAX_REQUEUE_PARKED_DOCUMENTS,
  requeueParkedDocuments,
} from "@/api/lib/legal-search/sk-document-backfill";

/**
 * Count the Slovak court decisions the deferred-document walk has parked, or
 * put them back into it.
 *
 * A decision parks after `MAX_DOCUMENT_FETCH_ATTEMPTS` failed attempts, or at
 * once when the parser cannot read its download. This is the way back once
 * the cause is fixed. Requeued decisions are fetched by the running walk at
 * its own pace, so this script sends nothing to the publisher itself.
 *
 *   # how many are parked (the default; writes nothing)
 *   bun run src/scripts/requeue-sk-documents.ts
 *
 *   # requeue at most 5000 of them; run again for more
 *   bun run src/scripts/requeue-sk-documents.ts --requeue 5000
 *
 * Not a scheduled job: a deliberate operation under an operator who reads
 * the report.
 */

const USAGE = `Usage: bun run src/scripts/requeue-sk-documents.ts [--requeue <n>], n <= ${MAX_REQUEUE_PARKED_DOCUMENTS}`;

const parseRequeueLimit = (argv: readonly string[]): number | undefined => {
  if (argv.length === 0) {
    return undefined;
  }
  const [flag, value, ...rest] = argv;
  if (
    flag !== "--requeue" ||
    value === undefined ||
    rest.length > 0 ||
    !/^[1-9]\d*$/u.test(value) ||
    Number(value) > MAX_REQUEUE_PARKED_DOCUMENTS
  ) {
    console.error(USAGE);
    process.exit(1);
  }
  return Number(value);
};

const requeueLimit = parseRequeueLimit(Bun.argv.slice(2));

// Counting only reads, so it takes no lane; a requeue writes and
// serializes with every other maintenance pass.
const { ingestionDb } =
  requeueLimit === undefined
    ? await openCaseLawReadOnlySession()
    : await enterCaseLawMaintenanceLane();

const sourceId = await loadDeferredDocumentSourceId(
  ingestionDb,
  ADAPTER_KEYS.SK_COURTS,
);
if (sourceId === undefined) {
  console.log("No sk-courts source; nothing is parked.");
  process.exit(0);
}

console.log(`parked=${await countParkedDocuments(ingestionDb, sourceId)}`);

if (requeueLimit !== undefined) {
  const requeued = await requeueParkedDocuments({
    scopedDb: ingestionDb,
    sourceId,
    limit: requeueLimit,
  });
  console.log(`requeued=${requeued}`);
}

process.exit(0);
