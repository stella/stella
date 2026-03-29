import { t } from "elysia";

import { unlinkClauseHandler } from "@/api/handlers/clauses/template-links";
import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

export const unlinkTemplateClauseParamsSchema = t.Object({
  templateId: tNanoid,
  linkId: tNanoid,
});

const config = {
  permissions: { template: ["update"] },
  params: unlinkTemplateClauseParamsSchema,
} satisfies HandlerConfig;

const unlinkTemplateClause = createRootHandler(
  config,
  async ({ scopedDb, session, params }) =>
    await unlinkClauseHandler({
      scopedDb,
      organizationId: session.activeOrganizationId,
      templateId: params.templateId,
      linkId: params.linkId,
    }),
);

export default unlinkTemplateClause;
