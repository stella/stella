import { and, desc, eq } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  publishedLegislationDocument,
  publishedLegislationCountryFor,
} from "@/api/lib/legal-search/legislation-redistribution";
import {
  inForceToday,
  versionSortKey,
} from "@/api/lib/legal-search/legislation-validity-window";
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
        publishedLegislationDocument,
      ),
    )
    .limit(1);

  return work ?? null;
};

/** Restricts a `legislation_documents` scan to one Work. */
export const workKeyConditions = (work: LegislationWorkKey): SQL[] => [
  publishedLegislationCountryFor(legislationDocuments.country),
  eq(legislationDocuments.sourceId, work.sourceId),
  eq(legislationDocuments.eli, work.eli),
  eq(legislationDocuments.language, work.language),
];

/**
 * The consolidation a Work's bare address shows: the one in force today, and
 * only when none is (a repealed act, one not yet effective) the latest the
 * corpus holds. The newest window is the wrong default for a live act, since
 * a published amendment makes a future consolidation the newest months before
 * it applies.
 *
 * One query both the reader route and the version listing use, so the page a
 * bare link opens and the version the listing marks as its default cannot
 * disagree.
 */
export const selectDefaultVersionId = async (
  tx: LegislationReadTransaction,
  work: LegislationWorkKey,
): Promise<SafeId<"legislationDocument"> | null> => {
  const [version] = await tx
    .select({ id: legislationDocuments.id })
    .from(legislationDocuments)
    .where(and(...workKeyConditions(work)))
    .orderBy(
      desc(
        inForceToday(
          legislationDocuments.versionValidFrom,
          legislationDocuments.versionValidTo,
        ),
      ),
      desc(versionSortKey(legislationDocuments.versionValidFrom)),
      desc(legislationDocuments.id),
    )
    .limit(1);

  return version?.id ?? null;
};
