import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

import { getClauseVersionHandler } from "./read";

const getClauseVersionParamsSchema = t.Object({
  clauseId: tNanoid,
  versionId: tNanoid,
});

const config = {
  permissions: { workspace: ["read"] },
  params: getClauseVersionParamsSchema,
} satisfies HandlerConfig;

const getClauseVersion = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params }) {
    return yield* getClauseVersionHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      clauseId: params.clauseId,
      versionId: params.versionId,
    });
  },
);

export default getClauseVersion;
