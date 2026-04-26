import { Result } from "better-result";
import { t } from "elysia";

import { listTemplateClausesHandler } from "@/api/handlers/clauses/template-links";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const listTemplateClausesParamsSchema = t.Object({
  templateId: tSafeId("template"),
});

const config = {
  permissions: { workspace: ["read"] },
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
