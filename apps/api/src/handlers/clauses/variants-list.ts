import { t } from "elysia";

import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

import { listVariantsHandler } from "./variants";

export const listVariantsParamsSchema = t.Object({
  clauseId: tNanoid,
});

const config = {
  permissions: { workspace: ["read"] },
  params: listVariantsParamsSchema,
} satisfies HandlerConfig;

const listVariants = createRootHandler(
  config,
  async ({ scopedDb, session, params }) =>
    await listVariantsHandler({
      scopedDb,
      organizationId: session.activeOrganizationId,
      clauseId: params.clauseId,
    }),
);

export default listVariants;
