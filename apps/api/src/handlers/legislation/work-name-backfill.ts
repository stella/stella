import { asc, gt } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { legislationDocuments } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  planLegislationWorkNames,
  readStoredLegislationWorkNames,
  syncLegislationWorkNamesTx,
} from "@/api/lib/legal-search/legislation-work-names";

/**
 * Brings `legislation_work_names` up to the titles of versions stored before
 * ingestion wrote names, or whose titles changed under an older writer.
 *
 * Walks `legislation_documents` by id, one page per transaction. Each page is
 * compared with the names stored for it (`planLegislationWorkNames`); a
 * report only counts the difference, an apply writes it. The version rows are
 * only read (an apply locks them shared; see below). Converges: a page already up to date plans no change, so a run
 * repeated over the same rows writes nothing.
 */

export type LegislationWorkNameBackfillPage = {
  /** The last version examined; null when the walk reached the end. */
  cursor: SafeId<"legislationDocument"> | null;
  scanned: number;
  /** Versions whose stored names differ from their titles. */
  changedDocuments: number;
  insertedRows: number;
  deletedRows: number;
};

type BackfillLegislationWorkNamesPageOptions = {
  db: ScopedDb;
  after: SafeId<"legislationDocument"> | null;
  pageSize: number;
  apply: boolean;
};

export const backfillLegislationWorkNamesPage = async ({
  db,
  after,
  pageSize,
  apply,
}: BackfillLegislationWorkNamesPageOptions): Promise<LegislationWorkNameBackfillPage> =>
  await db(async (tx) => {
    const page = tx
      .select({
        id: legislationDocuments.id,
        country: legislationDocuments.country,
        title: legislationDocuments.title,
      })
      .from(legislationDocuments)
      .where(after === null ? undefined : gt(legislationDocuments.id, after))
      .orderBy(asc(legislationDocuments.id))
      .limit(pageSize);
    // An apply holds the page's versions shared, in id order, until its names
    // are written. Ingestion rewrites a version's names in the transaction
    // that updates the version row, so a retitle either commits before this
    // read (and the page reads the new title) or waits for this page to
    // commit (and then rewrites the names itself): the backfill can never
    // write names for a title that is no longer stored. Ingestion locks one
    // version row, then its names; this page locks versions, then names, so
    // the two cannot wait on each other in a cycle.
    const subjects = apply ? await page.for("share") : await page;
    const last = subjects.at(-1);
    if (last === undefined) {
      return {
        cursor: null,
        scanned: 0,
        changedDocuments: 0,
        insertedRows: 0,
        deletedRows: 0,
      };
    }
    const plan = apply
      ? await syncLegislationWorkNamesTx(tx, subjects)
      : planLegislationWorkNames(
          subjects,
          await readStoredLegislationWorkNames(
            tx,
            subjects.map((subject) => subject.id),
          ),
        );
    return {
      cursor: last.id,
      scanned: subjects.length,
      changedDocuments: plan.changedDocumentIds.length,
      insertedRows: plan.inserts.length,
      deletedRows: plan.deleteIds.length,
    };
  });
