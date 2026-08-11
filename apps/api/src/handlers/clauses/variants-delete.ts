import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";

import { deleteVariantHandler } from "./variants";

const deleteVariantParamsSchema = t.Object({
  clauseId: tSafeId("clause"),
  variantId: tSafeId("clauseVariant"),
});

const config = {
  description:
    "Permanently delete one variant (an alternative wording) of a clause, " +
    "leaving the clause and its other variants in place. Templates that used " +
    "the variant fall back to the clause itself and keep only a stale label " +
    "snapshot of what was removed.",
  permissions: { clause: ["delete"] },
  mcp: { type: "capability", reason: "knowledge_library_admin" },
  params: deleteVariantParamsSchema,
} satisfies HandlerConfig;

const deleteVariant = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, recordAuditEvent }) {
    return yield* deleteVariantHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      clauseId: params.clauseId,
      variantId: params.variantId,
      recordAuditEvent,
    });
  },
);

export default deleteVariant;
