import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { listTemplateRecipesHandler } from "./recipes";

const config = {
  permissions: { workspace: ["read"] },
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
