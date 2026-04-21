import { Result } from "better-result";
import { t } from "elysia";

import {
  linkClauseBodySchema,
  linkClauseHandler,
} from "@/api/handlers/clauses/template-links";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tUuid } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const linkTemplateClauseParamsSchema = t.Object({
  templateId: tUuid,
});

const config = {
  permissions: { template: ["update"] },
  params: linkTemplateClauseParamsSchema,
  body: linkClauseBodySchema,
} satisfies HandlerConfig;

const linkTemplateClause = createSafeRootHandler(
  config,
  async function* ({ scopedDb, session, params, body }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await linkClauseHandler({
            scopedDb,
            organizationId: session.activeOrganizationId,
            templateId: params.templateId,
            body,
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
