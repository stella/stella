import { t } from "elysia";

import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

import { createVariantBodySchema, createVariantHandler } from "./variants";

export const createVariantParamsSchema = t.Object({
  clauseId: tNanoid,
});

const config = {
  permissions: { clause: ["create"] },
  params: createVariantParamsSchema,
  body: createVariantBodySchema,
} satisfies HandlerConfig;

const createVariant = createRootHandler(
  config,
  async ({ scopedDb, session, params, body }) =>
    await createVariantHandler({
      scopedDb,
      organizationId: session.activeOrganizationId,
      clauseId: params.clauseId,
      body,
    }),
);

export default createVariant;
