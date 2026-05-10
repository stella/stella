import Elysia, { t } from "elysia";

import { authMacro } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";
import { broadcast, broadcastToOrganization } from "@/api/lib/sse";

const queryKeySchema = t.Array(t.String({ minLength: 1 }), { minItems: 1 });

const invalidateQueryBodySchema = t.Object({
  queryKey: queryKeySchema,
});

const INVALIDATE_QUERY_EVENT_TYPE = "invalidate-query";

const createInvalidateQueryEvent = (queryKey: string[]) => ({
  type: INVALIDATE_QUERY_EVENT_TYPE,
  data: queryKey,
});

export const broadcastQueryInvalidationToOrganization = (
  organizationId: SafeId<"organization">,
  queryKey: string[],
) => {
  broadcastToOrganization(organizationId, createInvalidateQueryEvent(queryKey));
};

export const invalidateQuery = new Elysia({ name: "invalidateQueryMacro" })
  .use(authMacro)
  .macro("invalidateQuery", {
    validateAuth: true,
    body: invalidateQueryBodySchema,
    afterHandle: (ctx) => {
      if (ctx.session === null || ctx.session === undefined) {
        return;
      }

      const event = createInvalidateQueryEvent(ctx.body.queryKey);
      const workspaceId =
        "workspaceId" in ctx ? String(ctx.workspaceId) : undefined;

      if (workspaceId) {
        broadcast(brandPersistedWorkspaceId(workspaceId), event);
      } else {
        broadcastToOrganization(ctx.session.activeOrganizationId, event);
      }
    },
  })
  .macro("invalidateOrganizationQuery", {
    validateAuth: true,
    body: invalidateQueryBodySchema,
    afterHandle: (ctx) => {
      if (ctx.session === null || ctx.session === undefined) {
        return;
      }

      broadcastQueryInvalidationToOrganization(
        ctx.session.activeOrganizationId,
        ctx.body.queryKey,
      );
    },
  });
