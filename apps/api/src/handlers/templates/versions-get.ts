import { t } from "elysia";

import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

import { getTemplateVersionHandler } from "./versions";

export const getTemplateVersionParamsSchema = t.Object({
  templateId: tNanoid,
  versionId: tNanoid,
});

const config = {
  permissions: { workspace: ["read"] },
  params: getTemplateVersionParamsSchema,
} satisfies HandlerConfig;

const getTemplateVersion = createRootHandler(
  config,
  async ({ scopedDb, session, params }) =>
    await getTemplateVersionHandler({
      scopedDb,
      organizationId: session.activeOrganizationId,
      templateId: params.templateId,
      versionId: params.versionId,
    }),
);

export default getTemplateVersion;
