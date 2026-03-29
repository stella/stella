import { t } from "elysia";

import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

import { getClauseVersionHandler } from "./read";

export const getClauseVersionParamsSchema = t.Object({
  clauseId: tNanoid,
  versionId: tNanoid,
});

const config = {
  permissions: { workspace: ["read"] },
  params: getClauseVersionParamsSchema,
} satisfies HandlerConfig;

const getClauseVersion = createRootHandler(
  config,
  async ({ scopedDb, session, params }) =>
    await getClauseVersionHandler({
      scopedDb,
      organizationId: session.activeOrganizationId,
      clauseId: params.clauseId,
      versionId: params.versionId,
    }),
);

export default getClauseVersion;
