import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { deleteReaderAnnotationHandler } from "@/api/lib/legal-search/reader-annotations/delete";
import { annotationParamsSchema } from "@/api/lib/legal-search/reader-annotations/schema";
import { DOCUMENT_ANNOTATION_REACH } from "@/api/lib/legal-search/reader-annotations/target";

const config = {
  contract: "patch",
  permissions: { legalReaderAnnotation: ["delete"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  description: "Permanently delete one of the caller's highlights or comments.",
  mcp: { type: "tool", name: "delete_reader_annotation" },
  params: annotationParamsSchema,
} satisfies HandlerConfig;

/** Removes the author's own annotation; anyone else's is not found. */
const deleteReaderAnnotation = createSafeRootHandler(
  config,
  async function* ({
    params: { annotationId },
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    return yield* deleteReaderAnnotationHandler({
      annotationId,
      organizationId: session.activeOrganizationId,
      reach: DOCUMENT_ANNOTATION_REACH,
      recordAuditEvent,
      safeDb,
      userId: user.id,
    });
  },
);

export default deleteReaderAnnotation;
