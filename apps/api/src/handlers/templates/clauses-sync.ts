import { t } from "elysia";

import { syncClauseHandler } from "@/api/handlers/clauses/template-links";
import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

export const syncTemplateClauseParamsSchema = t.Object({
  templateId: tNanoid,
  linkId: tNanoid,
});

const config = {
  permissions: { template: ["update"] },
  params: syncTemplateClauseParamsSchema,
} satisfies HandlerConfig;

const syncTemplateClause = createRootHandler(
  config,
  async ({ scopedDb, session, params }) =>
    await syncClauseHandler({
      scopedDb,
      organizationId: session.activeOrganizationId,
      templateId: params.templateId,
      linkId: params.linkId,
    }),
);

export default syncTemplateClause;
