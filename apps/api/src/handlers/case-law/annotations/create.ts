import { panic, Result } from "better-result";
import { randomUUIDv7 } from "bun";
import { and, eq } from "drizzle-orm";

import { caseLawDecisionAnnotations } from "@/api/db/schema";
import { storedAnnotationMatchesRequest } from "@/api/handlers/case-law/annotations/create.logic";
import {
  createAnnotationBodySchema,
  decisionParamsSchema,
  requireAnnotationColor,
  requireAnnotationStyle,
  requireAnnotationVisibility,
} from "@/api/handlers/case-law/annotations/schema";
import type { CreateAnnotationBody } from "@/api/handlers/case-law/annotations/schema";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "reader_annotations" },
  params: decisionParamsSchema,
  body: createAnnotationBodySchema,
} satisfies HandlerConfig;

const annotationVisibility = ({ visibility }: CreateAnnotationBody) =>
  requireAnnotationVisibility(visibility ?? "private");

/**
 * Leaves a highlight or a comment on a passage. A passage over several
 * paragraphs becomes one row per paragraph under one group, so it reads,
 * changes and disappears as one mark. Private unless the reader says
 * otherwise; the author and organization come from the session, never from
 * the request.
 */
const createDecisionAnnotation = createSafeRootHandler(
  config,
  async function* ({
    body,
    params: { decisionId },
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    if (body.spans.some((span) => span.endOffset <= span.startOffset)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "An annotation must cover at least one character",
        }),
      );
    }

    const groupId =
      body.spans.length > 1 ? (body.requestId ?? randomUUIDv7()) : null;
    const visibility = annotationVisibility(body);
    const mutation = yield* Result.await(
      safeDb(async (tx) => {
        const values = body.spans.map((span, index) => ({
          id:
            index === 0 && body.requestId !== undefined
              ? body.requestId
              : createSafeId<"caseLawDecisionAnnotation">(),
          organizationId: session.activeOrganizationId,
          userId: user.id,
          decisionId,
          groupId,
          kind: body.kind,
          visibility,
          color:
            body.kind === "highlight"
              ? requireAnnotationColor(body.color)
              : null,
          style:
            body.kind === "highlight"
              ? requireAnnotationStyle(body.style)
              : null,
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
            .insert(caseLawDecisionAnnotations)
            .values(values)
            .returning({ id: caseLawDecisionAnnotations.id });
        } else {
          const insertedFirst = await tx
            .insert(caseLawDecisionAnnotations)
            .values(firstValue)
            .onConflictDoNothing({ target: caseLawDecisionAnnotations.id })
            .returning({ id: caseLawDecisionAnnotations.id });
          if (insertedFirst.length === 0) {
            const firstExisting = await tx
              .select({
                groupId: caseLawDecisionAnnotations.groupId,
              })
              .from(caseLawDecisionAnnotations)
              .where(
                and(
                  eq(
                    caseLawDecisionAnnotations.organizationId,
                    session.activeOrganizationId,
                  ),
                  eq(caseLawDecisionAnnotations.userId, user.id),
                  eq(caseLawDecisionAnnotations.id, body.requestId),
                ),
              )
              .limit(1);
            const existingGroupId = firstExisting.at(0)?.groupId;
            if (existingGroupId === undefined) {
              return { status: "conflict" } as const;
            }
            const existingRows = await tx
              .select({
                blockAnchorId: caseLawDecisionAnnotations.blockAnchorId,
                body: caseLawDecisionAnnotations.body,
                color: caseLawDecisionAnnotations.color,
                decisionId: caseLawDecisionAnnotations.decisionId,
                endOffset: caseLawDecisionAnnotations.endOffset,
                groupId: caseLawDecisionAnnotations.groupId,
                id: caseLawDecisionAnnotations.id,
                kind: caseLawDecisionAnnotations.kind,
                quote: caseLawDecisionAnnotations.quote,
                startOffset: caseLawDecisionAnnotations.startOffset,
                style: caseLawDecisionAnnotations.style,
                visibility: caseLawDecisionAnnotations.visibility,
              })
              .from(caseLawDecisionAnnotations)
              .where(
                and(
                  eq(
                    caseLawDecisionAnnotations.organizationId,
                    session.activeOrganizationId,
                  ),
                  eq(caseLawDecisionAnnotations.userId, user.id),
                  existingGroupId === null
                    ? eq(caseLawDecisionAnnotations.id, body.requestId)
                    : eq(caseLawDecisionAnnotations.groupId, existingGroupId),
                ),
              );
            if (
              !storedAnnotationMatchesRequest({
                body,
                decisionId,
                rows: existingRows,
              })
            ) {
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
                  .insert(caseLawDecisionAnnotations)
                  .values(remainingValues)
                  .returning({ id: caseLawDecisionAnnotations.id });
          mutatedRows = [...insertedFirst, ...insertedRemaining];
        }
        const first = mutatedRows.at(0);
        if (first !== undefined) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.CASE_LAW_DECISION_ANNOTATION,
            resourceId: first.id,
            metadata: {
              decisionId,
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
  },
);

export default createDecisionAnnotation;
