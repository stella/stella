/**
 * Write the names stored legislation titles state for versions stored before
 * ingestion wrote them.
 *
 * Ingestion writes a version's names in the transaction that writes the
 * version, so this is a pass over the rows that predate it. It walks
 * `legislation_documents` by id and brings each page's names up to its
 * titles (`backfillLegislationWorkNamesPage`); version rows are only read.
 *
 * Reports by default, writing nothing. `--apply` writes. The walk is bounded
 * by `--limit` versions examined and resumable with `--after <id>`, the last
 * id a run printed. Idempotent: a page already up to date plans no change, so
 * a repeated run writes nothing.
 *
 *   # what the backfill would write
 *   bun run src/scripts/backfill-legislation-work-names.ts
 *
 *   # write, bounded and resumable
 *   bun run src/scripts/backfill-legislation-work-names.ts --apply [--limit 200000] [--page 1000] [--after <id>]
 */

import type { ScopedDb } from "@/api/db/safe-db";
import { backfillLegislationWorkNamesPage } from "@/api/handlers/legislation/work-name-backfill";
import type { SafeId } from "@/api/lib/branded-types";
import {
  enterCaseLawMaintenanceLane,
  openCaseLawReadOnlySession,
} from "@/api/lib/case-law/maintenance-lane";
import { brandPersistedLegislationDocumentId } from "@/api/lib/safe-id-boundaries";
import {
  flagInteger,
  flagUuid,
  readApplyFlag,
  rejectUnknownFlags,
} from "@/api/scripts/repair-flags";

/** Versions one transaction examines. */
const DEFAULT_PAGE_SIZE = 1000;
/** Versions one run examines unless `--limit` says otherwise. */
const DEFAULT_LIMIT = 200_000;

const USAGE = `Usage: bun run src/scripts/backfill-legislation-work-names.ts [options]

  --apply        Write the names. Omitted, the run only reports.
  --dry-run      Report only, the default; contradicts --apply.
  --limit <n>    Versions this run examines (default ${String(DEFAULT_LIMIT)}).
  --page <n>     Versions one transaction examines (default ${String(DEFAULT_PAGE_SIZE)}).
  --after <id>   Resume after this version id, as a previous run printed.`;

rejectUnknownFlags({ known: ["limit", "page", "after"], usage: USAGE });

const apply = readApplyFlag(USAGE);
const limit = flagInteger({
  fallback: DEFAULT_LIMIT,
  name: "limit",
  usage: USAGE,
});
const pageSize = flagInteger({
  fallback: DEFAULT_PAGE_SIZE,
  name: "page",
  usage: USAGE,
});
const afterFlag = flagUuid({ name: "after", usage: USAGE });

// A report only reads, so it takes no lane and cannot block a writer.
const { rootDb } = apply
  ? await enterCaseLawMaintenanceLane()
  : await openCaseLawReadOnlySession();
const db: ScopedDb = async (fn) => await rootDb.transaction(fn);

let cursor: SafeId<"legislationDocument"> | null =
  afterFlag === undefined
    ? null
    : brandPersistedLegislationDocumentId(afterFlag);
let scanned = 0;
let changedDocuments = 0;
let insertedRows = 0;
let deletedRows = 0;
let reachedEnd = false;

while (scanned < limit) {
  // db-await-in-loop: keyset page per iteration; the page is the batch
  const page = await backfillLegislationWorkNamesPage({
    db,
    after: cursor,
    pageSize: Math.min(pageSize, limit - scanned),
    apply,
  });
  if (page.cursor === null) {
    reachedEnd = true;
    break;
  }
  cursor = page.cursor;
  scanned += page.scanned;
  changedDocuments += page.changedDocuments;
  insertedRows += page.insertedRows;
  deletedRows += page.deletedRows;
}

console.info(
  `${scanned.toLocaleString()} versions examined: ` +
    `${changedDocuments.toLocaleString()} ${apply ? "brought up to their titles" : "would change"} ` +
    `(${insertedRows.toLocaleString()} names ${apply ? "written" : "to write"}, ` +
    `${deletedRows.toLocaleString()} ${apply ? "removed" : "to remove"}).`,
);
if (!reachedEnd && cursor !== null) {
  console.info(
    `Stopped at --limit ${String(limit)}; resume with --after ${cursor}.`,
  );
}
if (!apply) {
  console.info("Report only: nothing written. Re-run with --apply to write.");
}

process.exit(0);
