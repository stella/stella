import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { createReaderAnnotationHandler } from "@/api/lib/legal-search/reader-annotations/create";
import { createAnnotationBodySchema } from "@/api/lib/legal-search/reader-annotations/schema";
import { PUBLIC_LAW_ANNOTATION_PLACEMENT } from "@/api/lib/legal-search/reader-annotations/target";

const config = {
  contract: "patch",
  idempotency: { type: "replay" },
  permissions: { legalReaderAnnotation: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  description:
    "Leave a highlight or comment on a passage of a case-law decision or a statute version; private unless shared.",
  mcp: { type: "tool", name: "create_reader_annotation" },
  body: createAnnotationBodySchema,
} satisfies HandlerConfig;

const createReaderAnnotation = createSafeRootHandler(
  config,
  async function* ({ body, recordAuditEvent, safeDb, session, user }) {
    return yield* createReaderAnnotationHandler({
      body,
      organizationId: session.activeOrganizationId,
      placement: PUBLIC_LAW_ANNOTATION_PLACEMENT,
      recordAuditEvent,
      safeDb,
      userId: user.id,
    });
  },
);

export default createReaderAnnotation;
