import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";

import { updateVariantBodySchema, updateVariantHandler } from "../variants";

const updateVariantParamsSchema = v.object({
  clauseId: resourceIdSchema("clause"),
  variantId: resourceIdSchema("clauseVariant"),
});

const config = {
  contract: "replace",
  precondition: {
    type: "deferred",
    baselineId: "apps/api/src/handlers/clauses/variants/update.ts",
  },
  description:
    "Change one variant's label, body, or position within its clause; only " +
    "the fields you pass are written.",
  permissions: { clause: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "knowledge_library_admin",
    consumesServices: false,
  },
  params: updateVariantParamsSchema,
  body: updateVariantBodySchema,
} satisfies HandlerConfig;

const updateVariant = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, body, recordAuditEvent }) {
    return yield* updateVariantHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      clauseId: params.clauseId,
      variantId: params.variantId,
      body,
      recordAuditEvent,
    });
  },
);

export default updateVariant;
