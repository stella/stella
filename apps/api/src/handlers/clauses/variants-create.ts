import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tUuid } from "@/api/lib/custom-schema";

import { createVariantBodySchema, createVariantHandler } from "./variants";

const createVariantParamsSchema = t.Object({
  clauseId: tUuid,
});

const config = {
  permissions: { clause: ["create"] },
  params: createVariantParamsSchema,
  body: createVariantBodySchema,
} satisfies HandlerConfig;

const createVariant = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, body }) {
    return yield* createVariantHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      clauseId: params.clauseId,
      body,
    });
  },
);

export default createVariant;
