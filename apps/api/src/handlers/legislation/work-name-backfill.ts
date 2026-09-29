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
 * only read. Converges: a page already up to date plans no change, so a run
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
    const subjects = await tx
      .select({
        id: legislationDocuments.id,
        country: legislationDocuments.country,
        title: legislationDocuments.title,
      })
      .from(legislationDocuments)
      .where(after === null ? undefined : gt(legislationDocuments.id, after))
      .orderBy(asc(legislationDocuments.id))
      .limit(pageSize);
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
