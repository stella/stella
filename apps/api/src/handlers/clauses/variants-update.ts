import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

import { updateVariantBodySchema, updateVariantHandler } from "./variants";

const updateVariantParamsSchema = t.Object({
  clauseId: tNanoid,
  variantId: tNanoid,
});

const config = {
  permissions: { clause: ["update"] },
  params: updateVariantParamsSchema,
  body: updateVariantBodySchema,
} satisfies HandlerConfig;

const updateVariant = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, body }) {
    return yield* updateVariantHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      clauseId: params.clauseId,
      variantId: params.variantId,
      body,
    });
  },
);

export default updateVariant;
