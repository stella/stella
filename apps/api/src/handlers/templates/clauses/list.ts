import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { listTemplateClausesHandler } from "@/api/lib/template-clause-links";

const listTemplateClausesParamsSchema = v.object({
  templateId: resourceIdSchema("template"),
});

const config = {
  contract: "patch",
  description:
    "List the clauses linked to one template: each link's id, clause, pinned " +
    "variant and version, slot name, sort order, and whether the pinned " +
    "version has fallen behind the clause's current one.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "template_authoring_ui",
    consumesServices: false,
  },
  access: "read",
  params: listTemplateClausesParamsSchema,
} satisfies HandlerConfig;

const listTemplateClauses = createSafeRootHandler(
  config,
  async function* ({ scopedDb, session, params }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await listTemplateClausesHandler({
            scopedDb,
            organizationId: session.activeOrganizationId,
            templateId: params.templateId,
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

export default listTemplateClauses;
