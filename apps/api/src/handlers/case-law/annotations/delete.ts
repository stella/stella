import { Result } from "better-result";

import { caseLawDecisionAnnotations } from "@/api/db/schema";
import { wholeAnnotationSql } from "@/api/handlers/case-law/annotations/group";
import { annotationParamsSchema } from "@/api/handlers/case-law/annotations/schema";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "reader_annotations" },
  params: annotationParamsSchema,
} satisfies HandlerConfig;

/** Removes the author's own annotation; anyone else's is not found. */
const deleteDecisionAnnotation = createSafeRootHandler(
  config,
  async function* ({ params: { annotationId }, safeDb, session, user }) {
    const rows = yield* Result.await(
      // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
      safeDb((tx) => {
        // audit: skip — the author removing their own mark on public text; no tenant configuration or shared record changes.
        return tx
          .delete(caseLawDecisionAnnotations)
          .where(
            wholeAnnotationSql({
              annotationId,
              organizationId: session.activeOrganizationId,
              userId: user.id,
            }),
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

export default deleteDecisionAnnotation;
