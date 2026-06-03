import Elysia, { t } from "elysia";

import { authMacro } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";
import { broadcast, broadcastToOrganization } from "@/api/lib/sse";

const queryKeySchema = t.Array(t.String({ minLength: 1 }), { minItems: 1 });

const invalidateQueryBodySchema = t.Object({
  queryKey: queryKeySchema,
  queryKeys: t.Optional(t.Array(queryKeySchema)),
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

export const broadcastQueryInvalidationToTargetWorkspace = (
  workspaceId: SafeId<"workspace">,
  queryKey: string[],
) => {
  broadcast(workspaceId, createInvalidateQueryEvent(queryKey));
};

export const invalidateQuery = new Elysia({ name: "invalidateQueryMacro" })
  .use(authMacro)
  .macro("invalidateQuery", {
    validateAuth: true,
    body: invalidateQueryBodySchema,
    afterHandle: (ctx) => {
      const workspaceId =
        "workspaceId" in ctx ? String(ctx.workspaceId) : undefined;
      const queryKeys = [ctx.body.queryKey, ...(ctx.body.queryKeys ?? [])];

      for (const queryKey of queryKeys) {
        const event = createInvalidateQueryEvent(queryKey);
        if (workspaceId) {
          broadcast(brandPersistedWorkspaceId(workspaceId), event);
        } else {
          broadcastToOrganization(ctx.session.activeOrganizationId, event);
        }
      }
    },
  })
  .macro("invalidateOrganizationQuery", {
    validateAuth: true,
    body: invalidateQueryBodySchema,
    afterHandle: (ctx) => {
      const queryKeys = [ctx.body.queryKey, ...(ctx.body.queryKeys ?? [])];
      for (const queryKey of queryKeys) {
        broadcastQueryInvalidationToOrganization(
          ctx.session.activeOrganizationId,
          queryKey,
        );
      }
    },
  });
