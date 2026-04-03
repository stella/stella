import { t } from "elysia";

import {
  linkClauseBodySchema,
  linkClauseHandler,
} from "@/api/handlers/clauses/template-links";
import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

const linkTemplateClauseParamsSchema = t.Object({
  templateId: tNanoid,
});

const config = {
  permissions: { template: ["update"] },
  params: linkTemplateClauseParamsSchema,
  body: linkClauseBodySchema,
} satisfies HandlerConfig;

const linkTemplateClause = createRootHandler(
  config,
  async ({ scopedDb, session, params, body }) =>
    await linkClauseHandler({
      scopedDb,
      organizationId: session.activeOrganizationId,
      templateId: params.templateId,
      body,
    }),
);

export default linkTemplateClause;
