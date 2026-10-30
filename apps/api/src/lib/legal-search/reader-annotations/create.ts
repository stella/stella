import { panic, Result } from "better-result";
import { randomUUIDv7 } from "bun";
import { and, eq } from "drizzle-orm";

import type { ReaderAnnotationTargetType } from "@stll/api-contract/legal-reader-annotations";

import { legalReaderAnnotations } from "@/api/db/schema";
import { AUDIT_ACTION } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { storedAnnotationMatchesRequest } from "@/api/lib/legal-search/reader-annotations/create.logic";
import {
  requireAnnotationColor,
  requireAnnotationStyle,
  requireAnnotationTargetType,
  requireAnnotationVisibility,
} from "@/api/lib/legal-search/reader-annotations/schema";
import type { CreateAnnotationRequest } from "@/api/lib/legal-search/reader-annotations/schema";
import { annotationAuditSubject } from "@/api/lib/legal-search/reader-annotations/target";
import type {
  AnnotationAuthorScope,
  AnnotationPlacement,
} from "@/api/lib/legal-search/reader-annotations/target";

const annotationVisibility = ({ visibility }: CreateAnnotationRequest) =>
  requireAnnotationVisibility(visibility ?? "private");

/**
 * The placement a request's target needs, so a matter target is only ever
 * written with the row its matter route read, and a public-law one with none.
 */
const PLACEMENT_BY_TARGET_TYPE = {
  decision: "public-law",
  statute: "public-law",
  "verification-claim": "verification-claim",
  "matter-document": "matter-document",
} as const satisfies Record<
  ReaderAnnotationTargetType,
  AnnotationPlacement["type"]
>;

/** The id the placement read, which the request's `targetId` must name. */
const placedTargetId = (placement: AnnotationPlacement): string | null => {
  switch (placement.type) {
    case "public-law": {
      return null;
    }
    case "verification-claim": {
      return placement.claimId;
    }
    case "matter-document": {
      return placement.fieldId;
    }
    default: {
      placement satisfies never;
      return panic(`Unhandled annotation placement: ${String(placement)}`);
    }
  }
};

/** The matter columns one row of the mark carries, on the given block. */
const placementColumns = (
  placement: AnnotationPlacement,
  blockAnchorId: string,
) => {
  switch (placement.type) {
    case "public-law": {
      return {
        workspaceId: null,
        verificationRunId: null,
        verificationClaimId: null,
        entityId: null,
        pageTextSha256: null,
      };
    }
    case "verification-claim": {
      return {
        workspaceId: placement.workspaceId,
        verificationRunId: placement.runId,
        verificationClaimId: placement.claimId,
        entityId: null,
        pageTextSha256: null,
      };
    }
    case "matter-document": {
      return {
        workspaceId: placement.workspaceId,
        verificationRunId: null,
        verificationClaimId: null,
        entityId: placement.entityId,
        pageTextSha256:
          placement.pageTextSha256ByAnchorId.get(blockAnchorId) ??
          panic("A placed document span has no page digest"),
      };
    }
    default: {
      placement satisfies never;
      return panic(`Unhandled annotation placement: ${String(placement)}`);
    }
  }
};

/**
 * Leaves a highlight or a comment on a passage of a decision, a statute or
 * matter content. A passage over several paragraphs (or pages) becomes one
 * row per paragraph under one group, so it reads, changes and disappears as
 * one mark. Private unless the reader says otherwise; the author and
 * organization come from the session, never from the request.
 */
type CreateReaderAnnotationProps = AnnotationAuthorScope & {
  body: CreateAnnotationRequest;
  /** Where the mark lands: the matter row a matter target's route read. */
  placement: AnnotationPlacement;
};

export const createReaderAnnotationHandler = async function* ({
  body,
  organizationId,
  placement,
  recordAuditEvent,
  safeDb,
  userId,
}: CreateReaderAnnotationProps) {
  const targetType = requireAnnotationTargetType(body.targetType);
  const placedId = placedTargetId(placement);
  if (
    PLACEMENT_BY_TARGET_TYPE[targetType] !== placement.type ||
    (placedId !== null && placedId !== body.targetId)
  ) {
    return panic("A matter mark must name the row its matter route read");
  }
  if (body.spans.some((span) => span.endOffset <= span.startOffset)) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "An annotation must cover at least one character",
      }),
    );
  }

  const targetId = body.targetId;
  const groupId =
    body.spans.length > 1 ? (body.requestId ?? randomUUIDv7()) : null;
  const visibility = annotationVisibility(body);
  const annotationIds = body.spans.map((_, index) =>
    index === 0 && body.requestId !== undefined
      ? body.requestId
      : createSafeId<"legalReaderAnnotation">(),
  );
  const mutation = yield* Result.await(
    safeDb(async (tx) => {
      const firstAnnotationId =
        annotationIds.at(0) ??
        panic("A validated annotation request has no spans");
      await withAggregateLock({
        aggregate: "readerAnnotation",
        id: { id: firstAnnotationId, organizationId, userId },
        tx,
      });
      const values = body.spans.map((span, index) => ({
        id:
          annotationIds.at(index) ??
          panic("An annotation span is missing its generated ID"),
        organizationId,
        userId,
        targetType,
        targetId,
        ...placementColumns(placement, span.blockAnchorId),
        groupId,
        kind: body.kind,
        visibility,
        color:
          body.kind === "highlight" ? requireAnnotationColor(body.color) : null,
        style:
          body.kind === "highlight" ? requireAnnotationStyle(body.style) : null,
        // A comment's words belong to the passage once, on its first
        // paragraph; the other rows only mark where it continues.
        body: body.kind === "comment" && index === 0 ? body.body : null,
        blockAnchorId: span.blockAnchorId,
        startOffset: span.startOffset,
        endOffset: span.endOffset,
        quote: span.quote,
      }));
      const firstValue = values.at(0);
      if (firstValue === undefined) {
        return panic("A validated annotation request has no spans");
      }

      let mutatedRows: { id: typeof firstValue.id }[];
      if (body.requestId === undefined) {
        mutatedRows = await tx
          .insert(legalReaderAnnotations)
          .values(values)
          .returning({ id: legalReaderAnnotations.id });
      } else {
        const insertedFirst = await tx
          .insert(legalReaderAnnotations)
          .values(firstValue)
          .onConflictDoNothing({ target: legalReaderAnnotations.id })
          .returning({ id: legalReaderAnnotations.id });
        if (insertedFirst.length === 0) {
          const firstExisting = await tx
            .select({
              groupId: legalReaderAnnotations.groupId,
            })
            .from(legalReaderAnnotations)
            .where(
              and(
                eq(legalReaderAnnotations.organizationId, organizationId),
                eq(legalReaderAnnotations.userId, userId),
                eq(legalReaderAnnotations.id, body.requestId),
              ),
            )
            .limit(1);
          const existingGroupId = firstExisting.at(0)?.groupId;
          if (existingGroupId === undefined) {
            return { status: "conflict" } as const;
          }
          const existingRows = await tx
            .select({
              blockAnchorId: legalReaderAnnotations.blockAnchorId,
              body: legalReaderAnnotations.body,
              color: legalReaderAnnotations.color,
              endOffset: legalReaderAnnotations.endOffset,
              groupId: legalReaderAnnotations.groupId,
              id: legalReaderAnnotations.id,
              kind: legalReaderAnnotations.kind,
              quote: legalReaderAnnotations.quote,
              startOffset: legalReaderAnnotations.startOffset,
              style: legalReaderAnnotations.style,
              targetId: legalReaderAnnotations.targetId,
              targetType: legalReaderAnnotations.targetType,
              visibility: legalReaderAnnotations.visibility,
            })
            .from(legalReaderAnnotations)
            .where(
              and(
                eq(legalReaderAnnotations.organizationId, organizationId),
                eq(legalReaderAnnotations.userId, userId),
                existingGroupId === null
                  ? eq(legalReaderAnnotations.id, body.requestId)
                  : eq(legalReaderAnnotations.groupId, existingGroupId),
              ),
            );
          if (!storedAnnotationMatchesRequest({ body, rows: existingRows })) {
            return { status: "conflict" } as const;
          }
          return {
            groupId: existingGroupId,
            rows: existingRows.map((row) => ({ id: row.id })),
            status: "replayed",
          } as const;
        }
        const remainingValues = values.slice(1);
        const insertedRemaining =
          remainingValues.length === 0
            ? []
            : await tx
                .insert(legalReaderAnnotations)
                .values(remainingValues)
                .returning({ id: legalReaderAnnotations.id });
        mutatedRows = [...insertedFirst, ...insertedRemaining];
      }
      const first = mutatedRows.at(0);
      if (first !== undefined) {
        const subject = annotationAuditSubject({
          annotationId: first.id,
          ...placementColumns(placement, firstValue.blockAnchorId),
          targetId,
          targetType,
        });
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: subject.resourceType,
          resourceId: subject.resourceId,
          ...(subject.workspaceId === undefined
            ? {}
            : { workspaceId: subject.workspaceId }),
          metadata: {
            ...subject.metadata,
            targetId,
            targetType,
            kind: body.kind,
            spanCount: body.spans.length,
            visibility,
          },
        });
      }
      return { groupId, rows: mutatedRows, status: "created" } as const;
    }),
  );

  if (mutation.status === "conflict") {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "Annotation request ID was already used",
      }),
    );
  }

  const first =
    mutation.rows.at(0) ?? panic("An annotation mutation returned no rows");

  return Result.ok({
    groupId: mutation.groupId,
    id: first.id,
    ids: mutation.rows.map((row) => row.id),
  });
};
