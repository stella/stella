import { Result } from "better-result";
import { t } from "elysia";

import { syncAllClausesHandler } from "@/api/handlers/clauses/template-links";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const syncAllTemplateClausesParamsSchema = t.Object({
  templateId: tSafeId("template"),
});

const config = {
  permissions: { template: ["update"] },
  params: syncAllTemplateClausesParamsSchema,
} satisfies HandlerConfig;

/** Re-pin every outdated clause link of a template to the latest
 *  clause version in one transaction; each link is audited like a
 *  single sync. */
const syncAllTemplateClauses = createSafeRootHandler(
  config,
  async function* ({ scopedDb, session, params, recordAuditEvent }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await syncAllClausesHandler({
            scopedDb,
            organizationId: session.activeOrganizationId,
            templateId: params.templateId,
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

export default syncAllTemplateClauses;
