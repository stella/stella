import { panic, Result } from "better-result";
import { randomUUIDv7 } from "bun";
import { and, eq } from "drizzle-orm";

import { legalReaderAnnotations } from "@/api/db/schema";
import { storedAnnotationMatchesRequest } from "@/api/handlers/legal-reader/annotations/create.logic";
import {
  createAnnotationBodySchema,
  requireAnnotationColor,
  requireAnnotationStyle,
  requireAnnotationTargetType,
  requireAnnotationVisibility,
} from "@/api/handlers/legal-reader/annotations/schema";
import type { CreateAnnotationBody } from "@/api/handlers/legal-reader/annotations/schema";
import { annotationAuditResourceType } from "@/api/handlers/legal-reader/annotations/target";
import type { AnnotationAuthorScope } from "@/api/handlers/legal-reader/annotations/target";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { legalReaderAnnotation: ["create"] },
  mcp: { type: "tool", name: "create_reader_annotation" },
  body: createAnnotationBodySchema,
} satisfies HandlerConfig;

const annotationVisibility = ({ visibility }: CreateAnnotationBody) =>
  requireAnnotationVisibility(visibility ?? "private");

/**
 * Leaves a highlight or a comment on a passage of a decision or a statute. A
 * passage over several paragraphs becomes one row per paragraph under one
 * group, so it reads, changes and disappears as one mark. Private unless the
 * reader says otherwise; the author and organization come from the session,
 * never from the request.
 */
type CreateReaderAnnotationProps = AnnotationAuthorScope & {
  body: CreateAnnotationBody;
};

export const createReaderAnnotationHandler = async function* ({
  body,
  organizationId,
  recordAuditEvent,
  safeDb,
  userId,
}: CreateReaderAnnotationProps) {
  if (body.spans.some((span) => span.endOffset <= span.startOffset)) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "An annotation must cover at least one character",
      }),
    );
  }

  const targetType = requireAnnotationTargetType(body.targetType);
  const targetId = body.targetId;
  const groupId =
    body.spans.length > 1 ? (body.requestId ?? randomUUIDv7()) : null;
  const visibility = annotationVisibility(body);
  const mutation = yield* Result.await(
    safeDb(async (tx) => {
      const values = body.spans.map((span, index) => ({
        id:
          index === 0 && body.requestId !== undefined
            ? body.requestId
            : createSafeId<"legalReaderAnnotation">(),
        organizationId,
        userId,
        targetType,
        targetId,
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
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: annotationAuditResourceType(targetType),
          resourceId: first.id,
          metadata: {
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

  const first = mutation.rows.at(0);
  if (first === undefined) {
    return Result.err(
      new HandlerError({ status: 500, message: "Annotation was not stored" }),
    );
  }

  return Result.ok({
    groupId: mutation.groupId,
    id: first.id,
    ids: mutation.rows.map((row) => row.id),
  });
};

const createReaderAnnotation = createSafeRootHandler(
  config,
  async function* ({ body, recordAuditEvent, safeDb, session, user }) {
    return yield* createReaderAnnotationHandler({
      body,
      organizationId: session.activeOrganizationId,
      recordAuditEvent,
      safeDb,
      userId: user.id,
    });
  },
);

export default createReaderAnnotation;
