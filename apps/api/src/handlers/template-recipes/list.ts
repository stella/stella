import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { listTemplateRecipesHandler } from "./recipes";

const config = {
  description:
    "List the organization's template recipes alphabetically by name, each " +
    "with its id, description, and full definition. Recipes are capped per " +
    "organization, so the whole set comes back in one response without a " +
    "cursor.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "template_authoring_ui",
    consumesServices: false,
  },
  access: "read",
} satisfies HandlerConfig;

const listTemplateRecipes = createSafeRootHandler(
  config,
  async function* ({ scopedDb, session }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await listTemplateRecipesHandler({
            scopedDb,
            organizationId: session.activeOrganizationId,
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

export default listTemplateRecipes;
