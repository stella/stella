import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { caseLawDecisionAnnotations } from "@/api/db/schema";
import {
  annotationParamsSchema,
  updateAnnotationBodySchema,
} from "@/api/handlers/case-law/annotations/schema";
import type { UpdateAnnotationBody } from "@/api/handlers/case-law/annotations/schema";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "reader_annotations" },
  params: annotationParamsSchema,
  body: updateAnnotationBodySchema,
} satisfies HandlerConfig;

/** The columns one change touches; the change names itself. */
const changesFor = (
  body: UpdateAnnotationBody,
): Partial<typeof caseLawDecisionAnnotations.$inferInsert> => {
  switch (body.change) {
    case "body": {
      return { body: body.body };
    }
    case "color": {
      return { color: body.color };
    }
    case "style": {
      return { style: body.style };
    }
    case "visibility": {
      return { visibility: body.visibility };
    }
    default: {
      const unreachable: never = body;
      return unreachable;
    }
  }
};

/**
 * Changes what the author may change: the words of a comment, the colour
 * or style of a highlight, and who sees either. The author predicate is in
 * the query as well as in the row policy, so a colleague's shared note is
 * never touched even if a policy were to loosen.
 */
const updateDecisionAnnotation = createSafeRootHandler(
  config,
  async function* ({ body, params: { annotationId }, safeDb, session, user }) {
    const rows = yield* Result.await(
      // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
      safeDb((tx) => {
        // audit: skip — the author editing their own mark on public text; no tenant configuration or shared record changes.
        return tx
          .update(caseLawDecisionAnnotations)
          .set({ ...changesFor(body), updatedAt: new Date() })
          .where(
            and(
              eq(caseLawDecisionAnnotations.id, annotationId),
              eq(
                caseLawDecisionAnnotations.organizationId,
                session.activeOrganizationId,
              ),
              eq(caseLawDecisionAnnotations.userId, user.id),
            ),
          )
          .returning({ id: caseLawDecisionAnnotations.id });
      }),
    );

    if (rows.length === 0) {
      return Result.err(
        new HandlerError({ status: 404, message: "Annotation not found" }),
      );
    }

    return { ok: true as const };
  },
);

export default updateDecisionAnnotation;
