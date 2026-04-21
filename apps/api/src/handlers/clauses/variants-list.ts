import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tUuid } from "@/api/lib/custom-schema";

import { listVariantsHandler } from "./variants";

const listVariantsParamsSchema = t.Object({
  clauseId: tUuid,
});

const config = {
  permissions: { workspace: ["read"] },
  params: listVariantsParamsSchema,
} satisfies HandlerConfig;

const listVariants = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params }) {
    return yield* listVariantsHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      clauseId: params.clauseId,
    });
  },
);

export default listVariants;
