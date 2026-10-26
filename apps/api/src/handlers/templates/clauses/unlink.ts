import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { unlinkClauseHandler } from "@/api/lib/template-clause-links";

const unlinkTemplateClauseParamsSchema = v.object({
  templateId: resourceIdSchema("template"),
  linkId: resourceIdSchema("templateClause"),
});

const config = {
  contract: "patch",
  description:
    "Remove one clause link from a template, with its pinned version, " +
    "variant, and slot assignment. Reversible: nothing leaves the clause " +
    "library and the same clause can be linked again with " +
    "templates.clauses.link. The template's own document is not rewritten, " +
    "so the slot marker stays in it.",
  permissions: { template: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "template_authoring_ui",
    consumesServices: false,
  },
  params: unlinkTemplateClauseParamsSchema,
} satisfies HandlerConfig;

const unlinkTemplateClause = createSafeRootHandler(
  config,
  async function* ({ scopedDb, session, params, recordAuditEvent }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await unlinkClauseHandler({
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

export default unlinkTemplateClause;
