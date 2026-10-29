import { panic, Result } from "better-result";
import { and, asc, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";
import { READER_ANNOTATION_MAX_SPANS } from "@stll/api-contract/legal-reader-annotations";
import type { ReaderAnnotationTargetType } from "@stll/api-contract/legal-reader-annotations";

import { member, user } from "@/api/db/auth-schema";
import { legalReaderAnnotations } from "@/api/db/schema";
import {
  paginationCursorSchema,
  paginationLimitSchema,
  uuidSchema,
} from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { pageLengthKeepingMarksWhole } from "@/api/lib/legal-search/reader-annotations/page.logic";
import {
  annotationTargetTypeSchema,
  requireAnnotationTargetType,
} from "@/api/lib/legal-search/reader-annotations/schema";
import type {
  AnnotationAuthorScope,
  VerificationClaimRef,
} from "@/api/lib/legal-search/reader-annotations/target";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedLegalReaderAnnotationId } from "@/api/lib/safe-id-boundaries";

export const listAnnotationsQuerySchema = v.object({
  targetType: annotationTargetTypeSchema,
  targetId: uuidSchema,
  cursor: v.optional(paginationCursorSchema()),
  limit: v.optional(
    numberFromString(
      paginationLimitSchema(LIMITS.readerAnnotationsPageSizeMax),
    ),
  ),
});

const annotationCursor = createTimestampIdCursorCodec({
  column: legalReaderAnnotations.createdAt,
  brandId: brandPersistedLegalReaderAnnotationId,
});

/**
 * The columns of the mark itself that the reader receives. The author's name
 * and picture come from the membership join and the cursor from the codec, so
 * they are added at the query; this is the table's own share, and the guards
 * below are what force a new column on the table to be decided about.
 */
const ANNOTATION_PROJECTION = {
  id: legalReaderAnnotations.id,
  groupId: legalReaderAnnotations.groupId,
  kind: legalReaderAnnotations.kind,
  visibility: legalReaderAnnotations.visibility,
  color: legalReaderAnnotations.color,
  style: legalReaderAnnotations.style,
  blockAnchorId: legalReaderAnnotations.blockAnchorId,
  startOffset: legalReaderAnnotations.startOffset,
  endOffset: legalReaderAnnotations.endOffset,
  quote: legalReaderAnnotations.quote,
  quotePrefix: legalReaderAnnotations.quotePrefix,
  quoteSuffix: legalReaderAnnotations.quoteSuffix,
  body: legalReaderAnnotations.body,
  createdAt: legalReaderAnnotations.createdAt,
  updatedAt: legalReaderAnnotations.updatedAt,
} as const;

type AnnotationRow = typeof legalReaderAnnotations.$inferSelect;

const UNPROJECTED_ANNOTATION_COLUMNS = [
  // The caller's own organization: the predicate and the row policy both
  // pin it, so the reader learns nothing from it coming back.
  "organizationId",
  // Sent as `authorId`, beside the name the membership join resolves.
  "userId",
  // The document the caller named in the query; echoing it repeats the ask.
  "targetId",
  "targetType",
  // A claim comment's matter, run and claim: the caller named the claim.
  "workspaceId",
  "verificationRunId",
  "verificationClaimId",
  // A matter document's mark is listed by the document's own route
  // (`matter-document-list.ts`), never here.
  "entityId",
  "pageTextSha256",
] as const satisfies readonly (keyof AnnotationRow)[];

type MissingProjectedAnnotationColumn = UnprojectedColumns<
  AnnotationRow,
  typeof ANNOTATION_PROJECTION,
  (typeof UNPROJECTED_ANNOTATION_COLUMNS)[number]
>;
type UnexpectedProjectedAnnotationColumn = UnbackedProjectionKeys<
  AnnotationRow,
  typeof ANNOTATION_PROJECTION,
  (typeof UNPROJECTED_ANNOTATION_COLUMNS)[number]
>;

true satisfies MissingProjectedAnnotationColumn extends never ? true : never;
true satisfies UnexpectedProjectedAnnotationColumn extends never ? true : never;

/**
 * Every annotation on one document the caller may see: their own, and what
 * colleagues shared. Row-level security draws that line; the query only
 * names the document. The author is read through the organization's
 * membership, so a name is only ever shown for a colleague. Oldest first,
 * so the margin reads in the order the notes were made.
 */
type ListReaderAnnotationsProps = Omit<
  AnnotationAuthorScope,
  "recordAuditEvent"
> & {
  query: Omit<
    v.InferOutput<typeof listAnnotationsQuerySchema>,
    "targetType"
  > & {
    /** A matter document's marks span the document's versions, so they are
     *  listed by `listMatterDocumentAnnotations` instead. */
    targetType: Exclude<ReaderAnnotationTargetType, "matter-document">;
  };
  /**
   * The claim a `verification-claim` listing reads, from the matter route's
   * authorized context; absent for every other target.
   */
  verificationClaim?: VerificationClaimRef;
};

export const listReaderAnnotationsHandler = async function* ({
  organizationId,
  query,
  safeDb,
  userId,
  verificationClaim,
}: ListReaderAnnotationsProps) {
  const targetType = requireAnnotationTargetType(query.targetType);
  if (
    (targetType === "verification-claim") !==
      (verificationClaim !== undefined) ||
    (verificationClaim !== undefined &&
      verificationClaim.claimId !== query.targetId)
  ) {
    return panic("A claim listing must name the claim its matter route read");
  }
  const limit = normalizeTenantPageLimit(
    query.limit ?? LIMITS.readerAnnotationsPageSizeDefault,
  );
  const conditions = [
    eq(legalReaderAnnotations.organizationId, organizationId),
    eq(legalReaderAnnotations.targetType, targetType),
    eq(legalReaderAnnotations.targetId, query.targetId),
  ];
  if (verificationClaim !== undefined) {
    conditions.push(
      eq(legalReaderAnnotations.workspaceId, verificationClaim.workspaceId),
      eq(legalReaderAnnotations.verificationRunId, verificationClaim.runId),
    );
  }

  if (query.cursor) {
    const cursor = annotationCursor.decode(query.cursor);
    if (!cursor) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }
    const cursorCondition = annotationCursor.keysetAfter({
      cursor,
      direction: "ascending",
      idColumn: legalReaderAnnotations.id,
    });
    if (cursorCondition) {
      conditions.push(cursorCondition);
    }
  }

  const rows = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({
          ...ANNOTATION_PROJECTION,
          authorId: legalReaderAnnotations.userId,
          authorName: user.name,
          authorImage: user.image,
          mine: sql<boolean>`${legalReaderAnnotations.userId} = ${userId}`,
          createdAtCursor: annotationCursor.cursorValue.as("created_at_cursor"),
        })
        .from(legalReaderAnnotations)
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
        .limit(limit + READER_ANNOTATION_MAX_SPANS),
    ),
  );

  const page = createCursorPage({
    rows,
    limit: pageLengthKeepingMarksWhole(rows, limit),
    cursorForItem: (item) =>
      annotationCursor.encode(item.createdAtCursor, item.id),
  });

  return Result.ok({
    ...page,
    limit,
    items: page.items.map(({ createdAtCursor: _, ...item }) => item),
  });
};
