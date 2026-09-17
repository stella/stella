import { and, eq, inArray } from "drizzle-orm";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  derivedAiLegislationSource,
  publishedLegislationDocument,
} from "@/api/lib/legal-search/legislation-redistribution";
import { versionAstColumns } from "@/api/lib/legal-search/legislation-version-blocks";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";

/**
 * What one consolidation must carry to answer a provision read: where its AST
 * lives, the validity window it applied in, and whether its source permits AI
 * use of the wording.
 *
 * `documentAst` is projected only for the rows object storage does not serve
 * (see `versionAstColumns`), so a batch read never pulls whole statutes out
 * of Postgres when the canonical payloads live in the object store.
 */
export type LegislationProvisionVersion = {
  id: SafeId<"legislationDocument">;
  astS3Key: string | null;
  documentAst: unknown;
  versionValidFrom: string | null;
  versionValidTo: string | null;
  allowsDerivedAi: boolean;
};

/**
 * Those columns for several consolidations at once, addressed by id.
 *
 * One query per batch read rather than one per requested provision: a batch
 * naming twenty provisions of the same act resolves to one id and reads one
 * row. Rows whose source is not cleared for redistribution are absent, which
 * is how the read reports a withdrawn source as no such document.
 */
export const readLegislationProvisionVersions = async ({
  documentIds,
  legislationDb,
}: {
  documentIds: readonly SafeId<"legislationDocument">[];
  legislationDb: LegislationReadDb;
}): Promise<LegislationProvisionVersion[]> => {
  if (documentIds.length === 0) {
    return [];
  }

  return await legislationDb(
    async (tx) =>
      await tx
        .select({
          ...versionAstColumns,
          versionValidFrom: legislationDocuments.versionValidFrom,
          versionValidTo: legislationDocuments.versionValidTo,
          allowsDerivedAi: derivedAiLegislationSource,
        })
        .from(legislationDocuments)
        .innerJoin(
          legislationSources,
          eq(legislationSources.id, legislationDocuments.sourceId),
        )
        .where(
          and(
            inArray(legislationDocuments.id, [...documentIds]),
            publishedLegislationDocument,
          ),
        ),
  );
};
