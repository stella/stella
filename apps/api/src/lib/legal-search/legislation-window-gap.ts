import { and, asc, desc, eq } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

import type { LegislationInconsistentVersion } from "@stll/api-contract/legislation-expression";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { inconsistentVersionColumns } from "@/api/lib/legal-search/legislation-expression-label";
import {
  isInconsistentWindowGapAt,
  isPromulgatedOnlyTextAt,
  legislationVersionRow,
  versionSortKey,
} from "@/api/lib/legal-search/legislation-validity-window";
import type { LegislationReadTransaction } from "@/api/lib/legislation-public-read-db";

/**
 * How many inconsistent versions one answer names. A Work has one per
 * language at most by construction (each is the latest of its language), so
 * this only bounds a Work stored under several sources.
 */
const INCONSISTENT_VERSIONS_MAX = 8;

/** The row predicate for `legislation_documents` itself. */
export const isInconsistentWindowGapOn = (asOf: SQLWrapper): SQL =>
  isInconsistentWindowGapAt(legislationVersionRow(legislationDocuments), asOf);

/**
 * The versions whose inconsistent publisher windows leave `asOf` without an
 * answer, within the Work the conditions select. Empty when the date is
 * simply not covered. Read only after no eligible version answered.
 *
 * The predicate decides from the stored window and disposition alone; what
 * the answer then reports about each version is the display projection's
 * business (`inconsistentVersionColumns`), which the predicate never reads.
 */
export const selectInconsistentWindowVersions = async (
  tx: LegislationReadTransaction,
  { conditions, asOf }: { conditions: readonly SQL[]; asOf: SQLWrapper },
): Promise<LegislationInconsistentVersion[]> =>
  await tx
    .select(inconsistentVersionColumns)
    .from(legislationDocuments)
    .innerJoin(
      legislationSources,
      eq(legislationSources.id, legislationDocuments.sourceId),
    )
    .where(and(...conditions, isInconsistentWindowGapOn(asOf)))
    .orderBy(
      desc(versionSortKey(legislationDocuments.versionValidFrom)),
      asc(legislationDocuments.language),
      desc(legislationDocuments.id),
    )
    .limit(INCONSISTENT_VERSIONS_MAX);

/** The row predicate for `legislation_documents` itself. */
const isPromulgatedOnlyTextOn = (asOf: SQLWrapper): SQL =>
  isPromulgatedOnlyTextAt(legislationVersionRow(legislationDocuments), asOf);

/**
 * The text as promulgated a read at `asOf` falls back to, within the Work the
 * conditions select, when that Work holds no version of an applicable kind;
 * null otherwise. Read only after no eligible version answered, so it never
 * replaces a text in force.
 */
export const selectPromulgatedOnlyVersion = async (
  tx: LegislationReadTransaction,
  { conditions, asOf }: { conditions: readonly SQL[]; asOf: SQLWrapper },
) => {
  const [version] = await tx
    .select({ id: legislationDocuments.id })
    .from(legislationDocuments)
    .innerJoin(
      legislationSources,
      eq(legislationSources.id, legislationDocuments.sourceId),
    )
    .where(and(...conditions, isPromulgatedOnlyTextOn(asOf)))
    .orderBy(
      desc(versionSortKey(legislationDocuments.versionValidFrom)),
      asc(legislationDocuments.language),
      desc(legislationDocuments.id),
    )
    .limit(1);
  return version?.id ?? null;
};
