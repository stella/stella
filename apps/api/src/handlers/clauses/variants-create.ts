import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";

import { createVariantBodySchema, createVariantHandler } from "./variants";

const createVariantParamsSchema = t.Object({
  clauseId: tSafeId("clause"),
});

const config = {
  description:
    "Add a variant, an alternative wording of a clause carrying its own " +
    "label, to one clause. Refused when the clause does not exist in this " +
    "organization or already holds its maximum number of variants.",
  permissions: { clause: ["create"] },
  mcp: { type: "capability", reason: "knowledge_library_admin" },
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
