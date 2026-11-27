import { Result } from "better-result";
import { and, asc, eq, gt, isNull } from "drizzle-orm";

import type { DocumentAst } from "@stll/legal-ast/document-ast";
import type { DecisionSection, EmptyAst } from "@stll/legal-ast/document-types";

import type { ScopedDb } from "@/api/db/safe-db-types";
import { legislationDocuments } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  type TimestampCasToken,
  timestampCasToken,
  timestampMatchesCasToken,
} from "@/api/lib/db/timestamp-cas";
import { recordFirstLegislationCorpusWriteTx } from "@/api/lib/legal-search/corpus-projectability-write";
import { writeCorpusDocument } from "@/api/lib/legal-search/corpus-storage";

/**
 * The legislation half of the corpus storage backfill: store the inline
 * payload of documents that have no corpus write yet and record the keys and
 * content hash through the projectability owner, which projects the document
 * into every active generation in the recording transaction. The case-law
 * half is `scripts/backfill-corpus-storage.ts`.
 *
 * A document is read without locks, its objects are written outside any
 * transaction, and the recording is a compare-and-set on "still no corpus
 * write, unchanged since the read", so a concurrent ingestion that recorded
 * newer keys is never pointed back at this payload.
 */
export type LegislationCorpusStorageRow = {
  id: SafeId<"legislationDocument">;
  country: string;
  fulltext: string | null;
  sections: DecisionSection[] | null;
  documentAst: DocumentAst | EmptyAst | null;
  updatedAtToken: TimestampCasToken;
};

/** Documents with no recorded corpus write, after `after` in id order. */
export const readLegislationCorpusStoragePage = async (
  db: ScopedDb,
  {
    after,
    limit,
  }: { after: SafeId<"legislationDocument"> | null; limit: number },
): Promise<LegislationCorpusStorageRow[]> =>
  await db(
    async (tx) =>
      await tx
        .select({
          id: legislationDocuments.id,
          country: legislationDocuments.country,
          fulltext: legislationDocuments.fulltext,
          sections: legislationDocuments.sections,
          documentAst: legislationDocuments.documentAst,
          updatedAtToken: timestampCasToken(legislationDocuments.updatedAt),
        })
        .from(legislationDocuments)
        .where(
          and(
            isNull(legislationDocuments.textS3Key),
            after === null ? undefined : gt(legislationDocuments.id, after),
          ),
        )
        .orderBy(asc(legislationDocuments.id))
        .limit(limit),
  );

export type LegislationCorpusStorageOutcome =
  | { type: "written" }
  /** Changed or recorded since the read, or no readable document to store. */
  | { type: "skipped" }
  | { type: "failed"; error: unknown };

/** One document's PUTs and recording; an error thrown here fails the row. */
const storeAndRecord = async ({
  db,
  row,
  write,
}: {
  db: ScopedDb;
  row: LegislationCorpusStorageRow;
  write: typeof writeCorpusDocument;
}): Promise<LegislationCorpusStorageOutcome> => {
  // The page can go stale while earlier rows in it write: refuse the PUTs
  // when the recording below would already refuse the row.
  const fresh = await db(
    async (tx) =>
      await tx
        .select({ id: legislationDocuments.id })
        .from(legislationDocuments)
        .where(
          and(
            eq(legislationDocuments.id, row.id),
            isNull(legislationDocuments.textS3Key),
            timestampMatchesCasToken(
              legislationDocuments.updatedAt,
              row.updatedAtToken,
            ),
          ),
        )
        .limit(1),
  );
  if (fresh.length === 0) {
    return { type: "skipped" };
  }
  const written = await write({
    documentId: row.id,
    jurisdiction: row.country,
    text: row.fulltext,
    sections: row.sections,
    ast: row.documentAst,
    // The page admits only rows with no recorded corpus write.
    stored: null,
  });
  if (written.isErr()) {
    return { type: "failed", error: written.error };
  }
  const outcome = written.value;
  if (outcome.type === "skipped-empty") {
    // Nothing readable to store; null pointers already represent it.
    return { type: "skipped" };
  }
  // A refused compare-and-set is not success: the objects exist but the
  // row still points nowhere, and only the recording makes the work durable.
  const recorded = await db(
    async (tx) =>
      await recordFirstLegislationCorpusWriteTx(tx, {
        id: row.id,
        written: outcome.written,
        updatedAtToken: row.updatedAtToken,
      }),
  );
  return recorded ? { type: "written" } : { type: "skipped" };
};

/**
 * Store one document's payload and record it. `write` is the corpus object
 * writer, replaceable only so a database test needs no object store.
 */
export const backfillLegislationCorpusStorageRow = async ({
  db,
  row,
  write = writeCorpusDocument,
}: {
  db: ScopedDb;
  row: LegislationCorpusStorageRow;
  write?: typeof writeCorpusDocument;
}): Promise<LegislationCorpusStorageOutcome> => {
  const attempted = await Result.tryPromise(
    async () => await storeAndRecord({ db, row, write }),
  );
  return Result.isError(attempted)
    ? { type: "failed", error: attempted.error }
    : attempted.value;
};

/** Where a resumed run may safely start: after `after`, and never past a failed document. */
export type LegislationCorpusStorageResume<Id> = {
  after: Id | null;
  /** Set once a document failed: the cursor stays before it for the rest of the run. */
  held: boolean;
};

/**
 * Moves the resume cursor over one page (ids ascending). It advances to the
 * last id before the run's first failed document and then stays there, so
 * `--after` from the printed cursor retries every document that failed.
 */
export const advanceLegislationCorpusStorageResume = <Id>(
  resume: LegislationCorpusStorageResume<Id>,
  page: readonly { id: Id; failed: boolean }[],
): LegislationCorpusStorageResume<Id> => {
  if (resume.held) {
    return resume;
  }
  let after = resume.after;
  for (const row of page) {
    if (row.failed) {
      return { after, held: true };
    }
    after = row.id;
  }
  return { after, held: false };
};
