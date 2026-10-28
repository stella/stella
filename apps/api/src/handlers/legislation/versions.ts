import { panic } from "better-result";
import { and, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";
import type { PublicCountrySurface } from "@stll/api-contract/public-country-capability";
import { servedStatuteVersionChanges } from "@stll/api-contract/statute-version-changes";

import { legislationDocuments } from "@/api/db/schema";
import {
  projectStatuteAmendments,
  projectStatuteVersion,
} from "@/api/handlers/legislation/reader-response";
import {
  selectDefaultVersionId,
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
import {
  LEGISLATION_AMENDMENT_PAGE_MAX,
  readLegislationAmendments,
  readLegislationAmendmentSnapshot,
} from "@/api/lib/legal-search/legislation-amendments";
import { legislationDocumentStatusToday } from "@/api/lib/legal-search/legislation-current-version";
import { legislationExpressionLabelColumns } from "@/api/lib/legal-search/legislation-expression-label";
import {
  effectOpensVersion,
  UNVERSIONED_SORT_DATE,
  versionSortKey,
} from "@/api/lib/legal-search/legislation-validity-window";
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

export const listStatuteVersionsParamsSchema = v.object({
  documentId: resourceIdSchema("legislationDocument"),
});

export const listStatuteVersionsQuerySchema = v.object({
  limit: v.optional(
    numberFromString(
      paginationLimitSchema(LIMITS.legislationVersionsPageSizeMax),
    ),
  ),
  cursor: v.optional(paginationCursorSchema()),
});

type ListStatuteVersionsQuery = v.InferOutput<
  typeof listStatuteVersionsQuerySchema
>;

type ListStatuteVersionsOptions = {
  documentId: SafeId<"legislationDocument">;
  query: ListStatuteVersionsQuery;
  legislationDb: LegislationReadDb;
  /** The surface this read answers for; its country list decides publication. */
  surface: PublicCountrySurface;
};

type VersionCursor = {
  validFrom: string;
  id: SafeId<"legislationDocument">;
};

export const decodeVersionCursor = (cursor: string): VersionCursor | null => {
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

export const encodeVersionCursor = (cursor: VersionCursor): string =>
  encodePaginationCursor([cursor.validFrom, cursor.id]);

/**
 * Every consolidated version of the work the given document belongs to,
 * newest validity window first. The work key is the source, ELI and
 * language triple the unique indexes are built on. `isDefault` marks the one
 * the Work's bare address shows, so a reader never re-derives that rule.
 *
 * Every version the publisher lists is here, labelled with its kind and
 * disposition: a version that never took effect or whose window is
 * inconsistent is history too, just never one that applied.
 */
export const listStatuteVersionsHandler = async ({
  documentId,
  query,
  legislationDb,
  surface,
}: ListStatuteVersionsOptions) => {
  const limit = normalizeTenantPageLimit(
    query.limit ?? LIMITS.legislationVersionsPageSizeDefault,
  );
  let cursor: VersionCursor | null = null;

  if (query.cursor !== undefined) {
    cursor = decodeVersionCursor(query.cursor);

    if (cursor === null) {
      return status(400, { message: "Invalid cursor" });
    }
  }

  const rows = await legislationDb(async (tx) => {
    const work = await selectWorkKey(tx, documentId, surface);

    if (work === null) {
      return { type: "missing" } as const;
    }

    const conditions: SQL[] = workKeyConditions(work, surface);

    if (cursor !== null) {
      conditions.push(
        sql`(${versionSortKey(legislationDocuments.versionValidFrom)}, ${legislationDocuments.id}) < (${cursor.validFrom}::date, ${cursor.id}::uuid)`,
      );
    }

    const defaultId = await selectDefaultVersionId(tx, work, surface);
    const page = await tx
      .select({
        id: legislationDocuments.id,
        eli: legislationDocuments.eli,
        slug: legislationDocuments.slug,
        title: legislationDocuments.title,
        country: legislationDocuments.country,
        language: legislationDocuments.language,
        documentType: legislationDocuments.documentType,
        status: legislationDocumentStatusToday,
        effectiveDate: legislationDocuments.effectiveDate,
        versionValidFrom: legislationDocuments.versionValidFrom,
        versionValidTo: legislationDocuments.versionValidTo,
        ...legislationExpressionLabelColumns,
        sourceUrl: legislationDocuments.sourceUrl,
        documentUrl: legislationDocuments.documentUrl,
        changeSummary: legislationDocuments.changeSummary,
        payloadRevision: legislationDocuments.payloadRevision,
      })
      .from(legislationDocuments)
      .where(and(...conditions))
      .orderBy(
        sql`${versionSortKey(legislationDocuments.versionValidFrom)} desc`,
        sql`${legislationDocuments.id} desc`,
      )
      .limit(limit + 1);

    const amendmentOwnerByOpeningDate = new Map<
      string,
      (typeof page)[number]
    >();
    // The look-ahead row is dropped by the cursor page, so it never owns relations.
    for (const row of page.slice(0, limit)) {
      const openingDate = row.versionValidFrom;
      if (openingDate !== null && effectOpensVersion(openingDate, row)) {
        const currentOwner = amendmentOwnerByOpeningDate.get(openingDate);
        // A relation belongs to one response version: prefer the default when it
        // opens that day, otherwise retain the first eligible row in page order.
        if (currentOwner === undefined || row.id === defaultId) {
          amendmentOwnerByOpeningDate.set(openingDate, row);
        }
      }
    }
    // Query only dates some returned version owns, so relations nobody can
    // receive never spend the shared page budget.
    const snapshot = await readLegislationAmendmentSnapshot(tx, work);
    const amendments =
      snapshot === null || amendmentOwnerByOpeningDate.size === 0
        ? { items: [], limit: LEGISLATION_AMENDMENT_PAGE_MAX, nextCursor: null }
        : await readLegislationAmendments(tx, {
            work,
            direction: "incoming",
            limit: LEGISLATION_AMENDMENT_PAGE_MAX,
            effectiveDates: [...amendmentOwnerByOpeningDate.keys()],
          });
    // Total over the returned versions: every owner is one of them, so a
    // missing entry is a bug, not an empty list.
    const amendmentsByOwner = new Map<
      SafeId<"legislationDocument">,
      (typeof amendments.items)[number][]
    >(page.map((row) => [row.id, []]));
    const amendmentsFor = (id: SafeId<"legislationDocument">) =>
      amendmentsByOwner.get(id) ??
      panic("Statute version has no amendment slot");
    for (const relation of amendments.items) {
      if (relation.effectiveDate !== null) {
        const owner = amendmentOwnerByOpeningDate.get(relation.effectiveDate);
        if (owner !== undefined) {
          amendmentsFor(owner.id).push(relation);
        }
      }
    }
    return {
      type: "found",
      rows: page.map(({ changeSummary, payloadRevision, ...row }) =>
        projectStatuteVersion({
          ...row,
          isDefault: row.id === defaultId,
          // Counts computed from the wording the row holds now, or none.
          changes: servedStatuteVersionChanges({
            stored: changeSummary,
            payloadRevision,
          }),
          // The actor comes from an explicit publisher relation; multiple acts
          // starting on one day remain separate effects in that day's wording.
          amendedBy: projectStatuteAmendments({
            snapshot,
            page: {
              ...amendments,
              items: amendmentsFor(row.id),
            },
          }),
        }),
      ),
    } as const;
  });

  if (rows.type === "missing") {
    return status(404, { message: "Legislation document not found" });
  }

  return createCursorPage({
    rows: rows.rows,
    limit,
    cursorForItem: (item) =>
      encodePaginationCursor([
        item.versionValidFrom ?? UNVERSIONED_SORT_DATE,
        item.id,
      ]),
  });
};
