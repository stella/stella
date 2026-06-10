import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { deleteTemplateRecipeHandler } from "./recipes";

const deleteTemplateRecipeParamsSchema = t.Object({
  recipeId: tSafeId("templateRecipe"),
});

const config = {
  permissions: { template: ["delete"] },
  params: deleteTemplateRecipeParamsSchema,
} satisfies HandlerConfig;

const deleteTemplateRecipe = createSafeRootHandler(
  config,
  async function* ({ scopedDb, session, params, recordAuditEvent }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await deleteTemplateRecipeHandler({
            scopedDb,
            organizationId: session.activeOrganizationId,
            recipeId: params.recipeId,
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

export default deleteTemplateRecipe;
