import { Result } from "better-result";
import Elysia, { t } from "elysia";

import { invalidateQueryAction } from "@/api/handlers/registry/actions";
import { authMacro } from "@/api/lib/auth";
import { captureError } from "@/api/lib/posthog";

const queryKeySchema = t.Array(t.String({ minLength: 1 }), { minItems: 1 });

const invalidateQueryBodySchema = t.Object({
  queryKey: queryKeySchema,
});

export const invalidateQuery = new Elysia({ name: "invalidateQueryMacro" })
  .use(authMacro)
  .macro("invalidateQuery", {
    validateAuth: true,
    body: invalidateQueryBodySchema,
    afterHandle: async (ctx) => {
      const result = await invalidateQueryAction({
        organizationId: ctx.session.activeOrganizationId,
        authToken: ctx.session.token,
        queryKey: ctx.body.queryKey,
      });

      if (Result.isError(result)) {
        captureError(result.error, {
          queryKey: ctx.body.queryKey.join("/"),
        });
        return ctx.status(500);
      }

      return;
    },
  });
