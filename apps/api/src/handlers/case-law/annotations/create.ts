import { Result } from "better-result";

import { caseLawDecisionAnnotations } from "@/api/db/schema";
import {
  createAnnotationBodySchema,
  decisionParamsSchema,
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
 * Leaves a highlight or a comment on a passage. Private unless the reader
 * says otherwise; the author and organization come from the session, never
 * from the request.
 */
const createDecisionAnnotation = createSafeRootHandler(
  config,
  async function* ({ body, params: { decisionId }, safeDb, session, user }) {
    if (body.endOffset <= body.startOffset) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "An annotation must cover at least one character",
        }),
      );
    }

    const rows = yield* Result.await(
      // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
      safeDb((tx) => {
        // audit: skip — a reader's own mark on public text, private by default; no tenant configuration or shared record changes.
        return tx
          .insert(caseLawDecisionAnnotations)
          .values({
            id: createSafeId<"caseLawDecisionAnnotation">(),
            organizationId: session.activeOrganizationId,
            userId: user.id,
            decisionId,
            kind: body.kind,
            visibility: body.visibility ?? "private",
            color: body.kind === "highlight" ? body.color : null,
            style: body.kind === "highlight" ? body.style : null,
            body: body.kind === "comment" ? body.body : null,
            blockAnchorId: body.blockAnchorId,
            startOffset: body.startOffset,
            endOffset: body.endOffset,
            quote: body.quote,
          })
          .returning({
            id: caseLawDecisionAnnotations.id,
            createdAt: caseLawDecisionAnnotations.createdAt,
          });
      }),
    );

    const created = rows.at(0);
    if (created === undefined) {
      return Result.err(
        new HandlerError({ status: 500, message: "Annotation was not stored" }),
      );
    }

    return created;
  },
);

export default createDecisionAnnotation;
