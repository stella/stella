import { t } from "elysia";

import { listTemplateClausesHandler } from "@/api/handlers/clauses/template-links";
import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

export const listTemplateClausesParamsSchema = t.Object({
  templateId: tNanoid,
});

const config = {
  permissions: { workspace: ["read"] },
  params: listTemplateClausesParamsSchema,
} satisfies HandlerConfig;

const listTemplateClauses = createRootHandler(
  config,
  async ({ scopedDb, session, params }) =>
    await listTemplateClausesHandler({
      scopedDb,
      organizationId: session.activeOrganizationId,
      templateId: params.templateId,
    }),
);

export default listTemplateClauses;
