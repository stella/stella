import Elysia, { t } from "elysia";

import { authMacro } from "@/api/lib/auth";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";
import { broadcast, broadcastToOrganization } from "@/api/lib/sse";

const queryKeySchema = t.Array(t.String({ minLength: 1 }), { minItems: 1 });

const invalidateQueryBodySchema = t.Object({
  queryKey: queryKeySchema,
});

const INVALIDATE_QUERY_EVENT_TYPE = "invalidate-query";

export const invalidateQuery = new Elysia({ name: "invalidateQueryMacro" })
  .use(authMacro)
  .macro("invalidateQuery", {
    validateAuth: true,
    body: invalidateQueryBodySchema,
    afterHandle: (ctx) => {
      if (ctx.session === null || ctx.session === undefined) {
        return;
      }

      const event = {
        type: INVALIDATE_QUERY_EVENT_TYPE,
        data: ctx.body.queryKey,
      };

      const workspaceId =
        "workspaceId" in ctx ? String(ctx.workspaceId) : undefined;

      if (workspaceId) {
        broadcast(brandPersistedWorkspaceId(workspaceId), event);
      } else {
        broadcastToOrganization(ctx.session.activeOrganizationId, event);
      }
    },
  });
