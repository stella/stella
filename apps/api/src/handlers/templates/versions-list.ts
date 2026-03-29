import { t } from "elysia";

import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

import { listTemplateVersionsHandler } from "./versions";

export const listTemplateVersionsParamsSchema = t.Object({
  templateId: tNanoid,
});

const config = {
  permissions: { workspace: ["read"] },
  params: listTemplateVersionsParamsSchema,
} satisfies HandlerConfig;

const listTemplateVersions = createRootHandler(
  config,
  async ({ scopedDb, session, params }) =>
    await listTemplateVersionsHandler({
      scopedDb,
      organizationId: session.activeOrganizationId,
      templateId: params.templateId,
    }),
);

export default listTemplateVersions;
