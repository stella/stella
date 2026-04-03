import { t } from "elysia";

import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

import { deleteVariantHandler } from "./variants";

const deleteVariantParamsSchema = t.Object({
  clauseId: tNanoid,
  variantId: tNanoid,
});

const config = {
  permissions: { clause: ["delete"] },
  params: deleteVariantParamsSchema,
} satisfies HandlerConfig;

const deleteVariant = createRootHandler(
  config,
  async ({ scopedDb, session, params }) =>
    await deleteVariantHandler({
      scopedDb,
      organizationId: session.activeOrganizationId,
      clauseId: params.clauseId,
      variantId: params.variantId,
    }),
);

export default deleteVariant;
