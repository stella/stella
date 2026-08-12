import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  linkClauseBodySchema,
  linkClauseHandler,
} from "@/api/lib/template-clause-links";

const linkTemplateClauseParamsSchema = t.Object({
  templateId: tSafeId("template"),
});

const config = {
  description:
    "Link a clause from the library into a template, optionally pinning one " +
    "of its variants and naming the clause slot it fills. The link records " +
    "the clause's version as it is now, so later edits to the clause do not " +
    "reach the template until it is synced. Refused once the template holds " +
    "its maximum number of clause links.",
  permissions: { template: ["update"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  params: linkTemplateClauseParamsSchema,
  body: linkClauseBodySchema,
} satisfies HandlerConfig;

const linkTemplateClause = createSafeRootHandler(
  config,
  async function* ({ scopedDb, session, params, body, recordAuditEvent }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await linkClauseHandler({
            scopedDb,
            organizationId: session.activeOrganizationId,
            templateId: params.templateId,
            body,
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

export default linkTemplateClause;
