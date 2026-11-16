import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { syncClauseHandler } from "@/api/lib/template-clause-links";

const syncTemplateClauseParamsSchema = v.object({
  templateId: resourceIdSchema("template"),
  linkId: resourceIdSchema("templateClause"),
});

const config = {
  contract: "patch",
  description:
    "Re-pin one clause link of a template to its clause's current version, " +
    "so the next fill inserts the newest wording. The link's slot and " +
    "variant stay as they are. Use templates.outdated-clauses.sync to do this for " +
    "every outdated link at once.",
  permissions: { template: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "template_authoring_ui",
    consumesServices: false,
  },
  params: syncTemplateClauseParamsSchema,
} satisfies HandlerConfig;

const syncTemplateClause = createSafeRootHandler(
  config,
  async function* ({ scopedDb, session, params, recordAuditEvent }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await syncClauseHandler({
            scopedDb,
            organizationId: session.activeOrganizationId,
            templateId: params.templateId,
            linkId: params.linkId,
            recordAuditEvent,
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Internal server error",
            cause,
          }),
      }),
    );
    return Result.ok(result);
  },
);

export default syncTemplateClause;
