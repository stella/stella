import { Result } from "better-result";
import { t } from "elysia";

import { unlinkClauseHandler } from "@/api/handlers/clauses/template-links";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const unlinkTemplateClauseParamsSchema = t.Object({
  templateId: tSafeId("template"),
  linkId: tSafeId("templateClause"),
});

const config = {
  permissions: { template: ["update"] },
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
