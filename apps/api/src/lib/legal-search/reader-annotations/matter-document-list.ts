/**
 * The marks on one matter document that the caller can see, as the PDF viewer
 * reads them while showing one file of the document: the marks on that file,
 * and those placed on the same file of the document's other versions. Each
 * mark names the file and version it was placed on and the digest of the page
 * text it was placed on, so the viewer can draw it on the page it shows only
 * when those words are still there, and lists it as detached otherwise.
 */

import { panic, Result } from "better-result";
import { and, asc, eq, sql } from "drizzle-orm";

import { READER_ANNOTATION_MAX_SPANS } from "@stll/api-contract/legal-reader-annotations";

import { member, user } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import {
  entityVersions,
  fields,
  legalReaderAnnotations,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  documentFileNotFound,
  readMarkedDocumentField,
} from "@/api/lib/legal-search/reader-annotations/matter-document";
import { pageLengthKeepingMarksWhole } from "@/api/lib/legal-search/reader-annotations/page.logic";
import { pdfPageNumberOfAnchor } from "@/api/lib/legal-search/reader-annotations/pdf-page-anchor";
import type { MatterDocumentRef } from "@/api/lib/legal-search/reader-annotations/target";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedLegalReaderAnnotationId } from "@/api/lib/safe-id-boundaries";

const annotationCursor = createTimestampIdCursorCodec({
  column: legalReaderAnnotations.createdAt,
  brandId: brandPersistedLegalReaderAnnotationId,
});

/** The mark's own columns the viewer receives; the guards below force a new
 *  column on the table to be decided about. */
const DOCUMENT_ANNOTATION_PROJECTION = {
  id: legalReaderAnnotations.id,
  groupId: legalReaderAnnotations.groupId,
  kind: legalReaderAnnotations.kind,
  visibility: legalReaderAnnotations.visibility,
  color: legalReaderAnnotations.color,
  style: legalReaderAnnotations.style,
  // Sent as `fieldId`: the file the mark was placed on.
  targetId: legalReaderAnnotations.targetId,
  // Sent as `pageNumber`.
  blockAnchorId: legalReaderAnnotations.blockAnchorId,
  startOffset: legalReaderAnnotations.startOffset,
  endOffset: legalReaderAnnotations.endOffset,
  quote: legalReaderAnnotations.quote,
  quotePrefix: legalReaderAnnotations.quotePrefix,
  quoteSuffix: legalReaderAnnotations.quoteSuffix,
  pageTextSha256: legalReaderAnnotations.pageTextSha256,
  body: legalReaderAnnotations.body,
  createdAt: legalReaderAnnotations.createdAt,
  updatedAt: legalReaderAnnotations.updatedAt,
} as const;

type AnnotationRow = typeof legalReaderAnnotations.$inferSelect;

const UNPROJECTED_DOCUMENT_ANNOTATION_COLUMNS = [
  // The caller's own organization and matter: the predicate and the row
  // policy pin both.
  "organizationId",
  "workspaceId",
  // Sent as `authorId`, beside the name the membership join resolves.
  "userId",
  // Always `matter-document` here, on the document the caller named.
  "targetType",
  "entityId",
  // Claim comment columns, null on a document's mark.
  "verificationRunId",
  "verificationClaimId",
] as const satisfies readonly (keyof AnnotationRow)[];

type MissingProjectedDocumentAnnotationColumn = UnprojectedColumns<
  AnnotationRow,
  typeof DOCUMENT_ANNOTATION_PROJECTION,
  (typeof UNPROJECTED_DOCUMENT_ANNOTATION_COLUMNS)[number]
>;
type UnexpectedProjectedDocumentAnnotationColumn = UnbackedProjectionKeys<
  AnnotationRow,
  typeof DOCUMENT_ANNOTATION_PROJECTION,
  (typeof UNPROJECTED_DOCUMENT_ANNOTATION_COLUMNS)[number]
>;

true satisfies MissingProjectedDocumentAnnotationColumn extends never
  ? true
  : never;
true satisfies UnexpectedProjectedDocumentAnnotationColumn extends never
  ? true
  : never;

/**
 * Every mark the caller may see on the document's file: their own, and what
 * colleagues on the matter shared. Row-level security draws that line, and
 * hides a mark whose version was withdrawn; the query names the document and
 * the file's property, so the file of each version is one file across
 * versions while another file of the same document stays apart. Oldest first,
 * so the side list reads in the order the notes were made.
 */
type ListMatterDocumentAnnotationsOptions = MatterDocumentRef & {
  cursor: string | undefined;
  limit: number | undefined;
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  userId: SafeId<"user">;
};

export const listMatterDocumentAnnotations = async function* ({
  cursor,
  entityId,
  fieldId,
  limit: requestedLimit,
  organizationId,
  safeDb,
  userId,
  workspaceId,
}: ListMatterDocumentAnnotationsOptions) {
  const limit = normalizeTenantPageLimit(
    requestedLimit ?? LIMITS.readerAnnotationsPageSizeDefault,
  );
  const conditions = [
    eq(legalReaderAnnotations.organizationId, organizationId),
    eq(legalReaderAnnotations.workspaceId, workspaceId),
    eq(legalReaderAnnotations.entityId, entityId),
    eq(legalReaderAnnotations.targetType, "matter-document"),
  ];
  if (cursor !== undefined) {
    const decoded = annotationCursor.decode(cursor);
    if (!decoded) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }
    const cursorCondition = annotationCursor.keysetAfter({
      cursor: decoded,
      direction: "ascending",
      idColumn: legalReaderAnnotations.id,
    });
    if (cursorCondition) {
      conditions.push(cursorCondition);
    }
  }

  const rows = yield* Result.await(
    safeDb(async (tx) => {
      const viewed = await readMarkedDocumentField({
        entityId,
        fieldId,
        tx,
        workspaceId,
      });
      if (viewed === undefined) {
        return undefined;
      }
      return await tx
        .select({
          ...DOCUMENT_ANNOTATION_PROJECTION,
          versionNumber: entityVersions.versionNumber,
          authorId: legalReaderAnnotations.userId,
          authorName: user.name,
          authorImage: user.image,
          mine: sql<boolean>`${legalReaderAnnotations.userId} = ${userId}`,
          createdAtCursor: annotationCursor.cursorValue.as("created_at_cursor"),
        })
        .from(legalReaderAnnotations)
        .innerJoin(
          fields,
          and(
            eq(fields.id, legalReaderAnnotations.targetId),
            eq(fields.workspaceId, workspaceId),
            eq(fields.propertyId, viewed.propertyId),
          ),
        )
        .innerJoin(
          entityVersions,
          and(
            eq(entityVersions.id, fields.entityVersionId),
            eq(entityVersions.workspaceId, workspaceId),
          ),
        )
        .innerJoin(
          member,
          and(
            eq(member.userId, legalReaderAnnotations.userId),
            eq(member.organizationId, organizationId),
          ),
        )
        .innerJoin(user, eq(user.id, member.userId))
        .where(and(...conditions))
        .orderBy(
          asc(legalReaderAnnotations.createdAt),
          asc(legalReaderAnnotations.id),
        )
        // Room to finish the last mark on the page: a mark's rows are
        // contiguous in this order and number at most the span cap.
        .limit(limit + READER_ANNOTATION_MAX_SPANS);
    }),
  );
  if (rows === undefined) {
    return Result.err(documentFileNotFound());
  }

  const page = createCursorPage({
    rows,
    limit: pageLengthKeepingMarksWhole(rows, limit),
    cursorForItem: (item) =>
      annotationCursor.encode(item.createdAtCursor, item.id),
  });

  return Result.ok({
    ...page,
    limit,
    items: page.items.map(
      ({
        blockAnchorId,
        createdAtCursor: _,
        pageTextSha256,
        targetId,
        ...item
      }) => ({
        ...item,
        fieldId: targetId,
        pageNumber:
          pdfPageNumberOfAnchor(blockAnchorId) ??
          panic("A matter document mark has no page anchor"),
        pageTextSha256:
          pageTextSha256 ?? panic("A matter document mark has no page digest"),
      }),
    ),
  });
};
