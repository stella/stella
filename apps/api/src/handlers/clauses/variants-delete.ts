import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tUuid } from "@/api/lib/custom-schema";

import { deleteVariantHandler } from "./variants";

const deleteVariantParamsSchema = t.Object({
  clauseId: tUuid,
  variantId: tUuid,
});

const config = {
  permissions: { clause: ["delete"] },
  params: deleteVariantParamsSchema,
} satisfies HandlerConfig;

const deleteVariant = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params }) {
    return yield* deleteVariantHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      clauseId: params.clauseId,
      variantId: params.variantId,
    });
  },
);

export default deleteVariant;
