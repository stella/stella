import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import {
  createTemplateRecipeBodySchema,
  createTemplateRecipeHandler,
} from "./recipes";

const config = {
  permissions: { template: ["create"] },
  body: createTemplateRecipeBodySchema,
} satisfies HandlerConfig;

const createTemplateRecipe = createSafeRootHandler(
  config,
  async function* ({ scopedDb, session, user, body, recordAuditEvent }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await createTemplateRecipeHandler({
            scopedDb,
            organizationId: session.activeOrganizationId,
            userId: user.id,
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

export default createTemplateRecipe;
