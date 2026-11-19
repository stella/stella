import { panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";
import type { PublicCountrySurface } from "@stll/api-contract/public-country-capability";
import { statuteAnchorSchemeFor } from "@stll/api-contract/statute-anchor-schemes";
import { mapWithConcurrency } from "@stll/concurrency";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { readProvision } from "@/api/handlers/legislation/provision-text";
import {
  provisionWordingChange,
  type VersionProvisionReading,
} from "@/api/handlers/legislation/provision-wording-change";
import { projectProvisionHistoryItem } from "@/api/handlers/legislation/reader-response";
import {
  selectWorkKey,
  workKeyConditions,
} from "@/api/handlers/legislation/work-key";
import { status } from "@/api/http/status";
import type { SafeId } from "@/api/lib/branded-types";
import {
  paginationCursorSchema,
  paginationLimitSchema,
  resourceIdSchema,
} from "@/api/lib/custom-schema";
import { legislationExpressionLabelColumns } from "@/api/lib/legal-search/legislation-expression-label";
import { derivedAiLegislationSource } from "@/api/lib/legal-search/legislation-redistribution";
import {
  UNVERSIONED_SORT_DATE,
  versionSortKey,
} from "@/api/lib/legal-search/legislation-validity-window";
import {
  readVersionAst,
  versionAstColumns,
} from "@/api/lib/legal-search/legislation-version-blocks";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isDateOnlyPaginationCursorPart,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedLegislationDocumentId } from "@/api/lib/safe-id-boundaries";

const HISTORY_READ_STEP = "provisionHistory.corpusAst";

export const provisionHistoryParamsSchema = v.object({
  documentId: resourceIdSchema("legislationDocument"),
  anchor: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
});

export const provisionHistoryQuerySchema = v.object({
  limit: v.optional(
    numberFromString(
      paginationLimitSchema(LIMITS.legislationProvisionHistoryPageSizeMax),
    ),
  ),
  cursor: v.optional(paginationCursorSchema()),
});

type ProvisionHistoryQuery = v.InferOutput<typeof provisionHistoryQuerySchema>;

type ProvisionHistoryOptions = {
  documentId: SafeId<"legislationDocument">;
  anchor: string;
  query: ProvisionHistoryQuery;
  legislationDb: LegislationReadDb;
  /** The surface this read answers for; its country list decides publication. */
  surface: PublicCountrySurface;
};

type VersionCursor = {
  validFrom: string;
  id: SafeId<"legislationDocument">;
};

export const decodeProvisionHistoryCursor = (
  cursor: string,
): VersionCursor | null => {
  const parts = decodePaginationCursor(cursor);

  if (parts?.length !== 2) {
    return null;
  }

  const [validFrom, id] = parts;

  if (
    !isDateOnlyPaginationCursorPart(validFrom) ||
    !isUuidPaginationCursorPart(id)
  ) {
    return null;
  }

  return { validFrom, id: brandPersistedLegislationDocumentId(id) };
};

export const encodeProvisionHistoryCursor = (cursor: VersionCursor): string =>
  encodePaginationCursor([cursor.validFrom, cursor.id]);

const versionColumns = {
  ...versionAstColumns,
  country: legislationDocuments.country,
  slug: legislationDocuments.slug,
  sourceUrl: legislationDocuments.sourceUrl,

  versionValidFrom: legislationDocuments.versionValidFrom,
  versionValidTo: legislationDocuments.versionValidTo,
  ...legislationExpressionLabelColumns,
  // Displaying a consolidation's wording and feeding it to a model are
  // separate publisher permissions. The reader ignores this; the agent-facing
  // history withholds the text of a version whose source bars derived AI use,
  // so the permission travels with every item instead of being re-queried.
  allowsDerivedAi: derivedAiLegislationSource,
};

/**
 * One provision's text across the consolidations of its Work, newest window
 * first, so a reader can diff a section without downloading whole statutes.
 *
 * The page walks versions, not occurrences: a version in which the anchor is
 * absent is dropped from `items` while still counting against the page, so
 * the cursor stays a plain keyset over the version order. The addressed
 * document only establishes the Work key: an anchor a later consolidation
 * dropped is still reachable, and "provision not found" is answered once the
 * walk has seen every version of the Work without one occurrence.
 *
 * Each found wording says how it relates to the consolidation just before
 * it (`wordingChange`), compared on the full text rather than the projected
 * one. The page already reads one version past its end for the cursor, so
 * the last item of a page is compared with the first version of the next
 * one at no extra read, and a run of unchanged wording reads the same at any
 * page size. A version whose structure cannot be read is an `unavailable`
 * item: neither it nor its newer neighbour is claimed changed or unchanged,
 * and it is never mistaken for one that lacks the provision.
 */
export const readProvisionHistoryHandler = async ({
  documentId,
  anchor,
  query,
  legislationDb,
  surface,
}: ProvisionHistoryOptions) => {
  const limit = normalizeTenantPageLimit(
    query.limit ?? LIMITS.legislationProvisionHistoryPageSizeDefault,
  );
  let cursor: VersionCursor | null = null;

  if (query.cursor !== undefined) {
    cursor = decodeProvisionHistoryCursor(query.cursor);

    if (cursor === null) {
      return status(400, { message: "Invalid cursor" });
    }
  }

  const versions = await legislationDb(async (tx) => {
    const work = await selectWorkKey(tx, documentId, surface);

    if (work === null) {
      return null;
    }

    const conditions: SQL[] = workKeyConditions(work, surface);

    if (cursor !== null) {
      conditions.push(
        sql`(${versionSortKey(legislationDocuments.versionValidFrom)}, ${legislationDocuments.id}) < (${cursor.validFrom}::date, ${cursor.id}::uuid)`,
      );
    }

    return await tx
      .select(versionColumns)
      .from(legislationDocuments)
      .innerJoin(
        legislationSources,
        eq(legislationSources.id, legislationDocuments.sourceId),
      )
      .where(and(...conditions))
      .orderBy(
        sql`${versionSortKey(legislationDocuments.versionValidFrom)} desc`,
        sql`${legislationDocuments.id} desc`,
      )
      .limit(limit + 1);
  });

  if (versions === null) {
    return status(404, { message: "Legislation document not found" });
  }

  // One object-storage read per version, bounded rather than one request per
  // item: a page is already capped far below the version page size because
  // each item costs one whole AST.
  const readings = await mapWithConcurrency({
    items: versions,
    limit: LIMITS.legislationProvisionReadConcurrency,
    operation: async (version): Promise<VersionProvisionReading> => {
      const ast = await readVersionAst({
        surface,
        row: version,
        legislationDb,
        step: HISTORY_READ_STEP,
      });
      // No structure (unreadable, or a source without a parser) says nothing
      // about whether the provision is there.
      if (ast === null || !("blocks" in ast)) {
        return { type: "unavailable" };
      }
      const reading = readProvision(
        { blocks: ast.blocks, scheme: statuteAnchorSchemeFor(version.country) },
        anchor,
      );
      return reading === null ? { type: "absent" } : { type: "found", reading };
    },
  });

  const page = createCursorPage({
    rows: versions.map((version, index) => ({
      allowsDerivedAi: version.allowsDerivedAi,
      documentId: version.id,
      country: version.country,
      slug: version.slug,
      sourceUrl: version.sourceUrl,

      versionValidFrom: version.versionValidFrom,
      versionValidTo: version.versionValidTo,
      expressionKind: version.expressionKind,
      windowDisposition: version.windowDisposition,
      windowDispositionBasis: version.windowDispositionBasis,
      reading: readings[index] ?? panic("A history version lost its reading"),
      // The look-ahead row is the next page's first version, so even a
      // page's last item has its older neighbour here; only the oldest
      // version of the Work has none.
      older: readings[index + 1],
    })),
    limit,
    cursorForItem: (item) =>
      encodePaginationCursor([
        item.versionValidFrom ?? UNVERSIONED_SORT_DATE,
        item.documentId,
      ]),
  });

  const items = page.items.flatMap(({ reading, older, ...item }) => {
    switch (reading.type) {
      case "absent":
        return [];
      case "unavailable":
        return [
          projectProvisionHistoryItem({ ...item, status: "unavailable" }),
        ];
      case "found":
        return [
          projectProvisionHistoryItem({
            ...item,
            status: "found",
            wordingChange: provisionWordingChange(reading.reading, older),
            text: reading.reading.text,
            governingText: reading.reading.governing,
            ...(reading.reading.governingTruncated
              ? { governingTextTruncated: true as const }
              : {}),
          }),
        ];
      default:
        return panic("Unhandled provision reading", reading satisfies never);
    }
  });

  // Only a first page can establish that no consolidation of the Work carries
  // the anchor. A continuation page sees the older tail alone: versions that
  // predate the provision end a walk that already returned it, so that page
  // is an empty last page, not a missing provision.
  if (
    query.cursor === undefined &&
    items.length === 0 &&
    page.nextCursor === null
  ) {
    return status(404, { message: "Provision not found" });
  }

  return { ...page, items };
};
