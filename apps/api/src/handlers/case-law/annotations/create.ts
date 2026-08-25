import { Result } from "better-result";
import { randomUUIDv7 } from "bun";

import { caseLawDecisionAnnotations } from "@/api/db/schema";
import {
  createAnnotationBodySchema,
  decisionParamsSchema,
  requireAnnotationColor,
  requireAnnotationStyle,
  requireAnnotationVisibility,
} from "@/api/handlers/case-law/annotations/schema";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "reader_annotations" },
  params: decisionParamsSchema,
  body: createAnnotationBodySchema,
} satisfies HandlerConfig;

/**
 * Leaves a highlight or a comment on a passage. A passage over several
 * paragraphs becomes one row per paragraph under one group, so it reads,
 * changes and disappears as one mark. Private unless the reader says
 * otherwise; the author and organization come from the session, never from
 * the request.
 */
const createDecisionAnnotation = createSafeRootHandler(
  config,
  async function* ({ body, params: { decisionId }, safeDb, session, user }) {
    if (body.spans.some((span) => span.endOffset <= span.startOffset)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "An annotation must cover at least one character",
        }),
      );
    }

    const groupId = body.spans.length > 1 ? randomUUIDv7() : null;
    const rows = yield* Result.await(
      safeDb((tx) => 
        // audit: skip — a reader's own mark on public text, private by default; no tenant configuration or shared record changes.
        tx
          .insert(caseLawDecisionAnnotations)
          .values(
            body.spans.map((span, index) => ({
              id: createSafeId<"caseLawDecisionAnnotation">(),
              organizationId: session.activeOrganizationId,
              userId: user.id,
              decisionId,
              groupId,
              kind: body.kind,
              visibility: requireAnnotationVisibility(
                body.visibility ?? "private",
              ),
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
            })),
          )
          .returning({ id: caseLawDecisionAnnotations.id })
      ),
    );

    const first = rows.at(0);
    if (first === undefined) {
      return Result.err(
        new HandlerError({ status: 500, message: "Annotation was not stored" }),
      );
    }

    return Result.ok({
      groupId,
      id: first.id,
      ids: rows.map((row) => row.id),
    });
  },
);

export default createDecisionAnnotation;
