import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import {
  annotationParamsSchema,
  updateAnnotationBodySchema,
} from "@/api/lib/legal-search/reader-annotations/schema";
import { DOCUMENT_ANNOTATION_REACH } from "@/api/lib/legal-search/reader-annotations/target";
import { updateReaderAnnotationHandler } from "@/api/lib/legal-search/reader-annotations/update";

const config = {
  contract: "replace",
  precondition: {
    type: "deferred",
    baselineId: "apps/api/src/handlers/legal-reader/annotations/update.ts",
  },
  permissions: { legalReaderAnnotation: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  description:
    "Change one of the caller's highlights or comments: its words, colour, style, or visibility.",
  mcp: { type: "tool", name: "update_reader_annotation" },
  params: annotationParamsSchema,
  body: updateAnnotationBodySchema,
} satisfies HandlerConfig;

const updateReaderAnnotation = createSafeRootHandler(
  config,
  async function* ({
    body,
    params: { annotationId },
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    return yield* updateReaderAnnotationHandler({
      annotationId,
      change: body,
      organizationId: session.activeOrganizationId,
      reach: DOCUMENT_ANNOTATION_REACH,
      recordAuditEvent,
      safeDb,
      userId: user.id,
    });
  },
);

export default updateReaderAnnotation;
