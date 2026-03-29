import { t } from "elysia";

import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

import { updateVariantBodySchema, updateVariantHandler } from "./variants";

export const updateVariantParamsSchema = t.Object({
  clauseId: tNanoid,
  variantId: tNanoid,
});

const config = {
  permissions: { clause: ["update"] },
  params: updateVariantParamsSchema,
  body: updateVariantBodySchema,
} satisfies HandlerConfig;

const updateVariant = createRootHandler(
  config,
  async ({ scopedDb, session, params, body }) =>
    await updateVariantHandler({
      scopedDb,
      organizationId: session.activeOrganizationId,
      clauseId: params.clauseId,
      variantId: params.variantId,
      body,
    }),
);

export default updateVariant;
