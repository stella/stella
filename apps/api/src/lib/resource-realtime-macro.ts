import Elysia, { ElysiaCustomStatusResponse } from "elysia";

import type { ResourceType } from "@stll/api-contract";

import { authMacro } from "@/api/lib/auth";
import {
  broadcastOrganizationResourceSetUpdated,
  broadcastWorkspaceResourceSetUpdated,
} from "@/api/lib/resource-realtime";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";

type ResourceTypes = ResourceType | readonly [ResourceType, ...ResourceType[]];

type ResourceSetUpdatedConfig =
  | {
      scope: "organization";
      resourceTypes: ResourceTypes;
    }
  | {
      scope: "workspace";
      resourceTypes: ResourceTypes;
    };

export const organizationResourceSetUpdates = (resourceTypes: ResourceTypes) =>
  ({ scope: "organization", resourceTypes }) as const;

export const workspaceResourceSetUpdates = (resourceTypes: ResourceTypes) =>
  ({ scope: "workspace", resourceTypes }) as const;

const didAuthResolve = (ctx: { session?: unknown }): boolean =>
  ctx.session !== undefined && ctx.session !== null;

const didMutationSucceed = (response: unknown): boolean => {
  if (response instanceof ElysiaCustomStatusResponse) {
    return response.code < 400;
  }
  if (response instanceof Response) {
    return response.ok;
  }
  return true;
};

const resourceTypesFromConfig = ({
  resourceTypes,
}: ResourceSetUpdatedConfig): readonly ResourceType[] =>
  typeof resourceTypes === "string" ? [resourceTypes] : resourceTypes;

export const resourceRealtime = new Elysia({ name: "resourceRealtimeMacro" })
  .use(authMacro)
  .macro("resourceSetUpdated", (config: ResourceSetUpdatedConfig) => ({
    validateAuth: true,
    afterHandle: (ctx) => {
      if (!(didAuthResolve(ctx) && didMutationSucceed(ctx.responseValue))) {
        return;
      }

      const resourceTypes = new Set(resourceTypesFromConfig(config));
      if (config.scope === "workspace") {
        if (!("workspaceId" in ctx) || typeof ctx.workspaceId !== "string") {
          return;
        }
        const workspaceId = brandPersistedWorkspaceId(ctx.workspaceId);
        for (const resourceType of resourceTypes) {
          broadcastWorkspaceResourceSetUpdated(workspaceId, resourceType);
        }
        return;
      }

      for (const resourceType of resourceTypes) {
        broadcastOrganizationResourceSetUpdated(
          ctx.session.activeOrganizationId,
          resourceType,
        );
      }
    },
  }));
