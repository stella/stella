import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";

import { createVariantBodySchema, createVariantHandler } from "./variants";

const createVariantParamsSchema = t.Object({
  clauseId: tSafeId("clause"),
});

const config = {
  permissions: { clause: ["create"] },
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
