import { and, eq } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { redistributableLegislationSource } from "@/api/handlers/legislation/redistribution";
import type { SafeId } from "@/api/lib/branded-types";
import type { LegislationReadTransaction } from "@/api/lib/legislation-public-read-db";

/**
 * What identifies a Work across its consolidations: the source, ELI and
 * language triple the unique indexes are built on. Two Expressions share a
 * Work exactly when these three match.
 */
export type LegislationWorkKey = {
  sourceId: SafeId<"legislationSource">;
  eli: string;
  language: string;
};

/**
 * The Work one Expression belongs to, or null when the document does not
 * exist or its source is not cleared for redistribution. Every read that
 * walks a Work's versions starts here, so "not found" means the same thing
 * on all of them.
 */
export const selectWorkKey = async (
  tx: LegislationReadTransaction,
  documentId: SafeId<"legislationDocument">,
): Promise<LegislationWorkKey | null> => {
  const [work] = await tx
    .select({
      sourceId: legislationDocuments.sourceId,
      eli: legislationDocuments.eli,
      language: legislationDocuments.language,
    })
    .from(legislationDocuments)
    .innerJoin(
      legislationSources,
      eq(legislationSources.id, legislationDocuments.sourceId),
    )
    .where(
      and(
        eq(legislationDocuments.id, documentId),
        redistributableLegislationSource,
      ),
    )
    .limit(1);

  return work ?? null;
};

/** Restricts a `legislation_documents` scan to one Work. */
export const workKeyConditions = (work: LegislationWorkKey): SQL[] => [
  eq(legislationDocuments.sourceId, work.sourceId),
  eq(legislationDocuments.eli, work.eli),
  eq(legislationDocuments.language, work.language),
];
