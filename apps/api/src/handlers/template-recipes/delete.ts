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
  description:
    "Permanently delete one template recipe (a reusable, pre-configured block " +
    "of template fields) from the organization. Templates already built with " +
    "it keep the fields that were inserted, and there is no in-use check.",
  permissions: { template: ["delete"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
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
