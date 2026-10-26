import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";

import { createVariantBodySchema, createVariantHandler } from "../variants";

const createVariantParamsSchema = v.object({
  clauseId: resourceIdSchema("clause"),
});

const config = {
  contract: "patch",
  idempotency: { type: "replay" },
  description:
    "Add a variant, an alternative wording of a clause carrying its own " +
    "label, to one clause. Refused when the clause does not exist in this " +
    "organization or already holds its maximum number of variants.",
  permissions: { clause: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "knowledge_library_admin",
    consumesServices: false,
  },
  params: createVariantParamsSchema,
  body: createVariantBodySchema,
} satisfies HandlerConfig;

const createVariant = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, body, recordAuditEvent }) {
    return yield* createVariantHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      clauseId: params.clauseId,
      body,
      recordAuditEvent,
    });
  },
);

export default createVariant;
