import { ElysiaCustomStatusResponse } from "elysia";

import type { ResourceType } from "@stll/api-contract";

import type { SafeId } from "@/api/lib/branded-types";
import {
  broadcastOrganizationResourceSetUpdated,
  broadcastWorkspaceResourceSetUpdated,
} from "@/api/lib/resource-realtime";

type ResourceTypes = ResourceType | readonly [ResourceType, ...ResourceType[]];

/** Announce these resource sets to every open tab of the caller's organization. */
export type OrganizationResourceSetUpdates = {
  scope: "organization";
  resourceTypes: ResourceTypes;
};

/** Announce these resource sets to every open tab of the handler's matter. */
export type WorkspaceResourceSetUpdates = {
  scope: "workspace";
  resourceTypes: ResourceTypes;
};

/**
 * A write whose open-tab refresh is owned elsewhere (it broadcasts its own
 * per-resource events, a queue worker announces the outcome, or nothing a web
 * view lists changes). The reason is the reviewable record of that decision.
 */
export type NoResourceSetUpdates = {
  scope: "none";
  reason: string;
};

/**
 * What a successful call of a handler announces over realtime. The safe-handler
 * wrapper owns the broadcast, so it fires for every transport that runs the
 * handler (REST routes, capability executors, and the CLI on top of it), only
 * after the handler returned a success, which is after its transaction
 * committed. A refused, failed or rolled-back call announces nothing.
 */
export type ResourceSetRealtime =
  | OrganizationResourceSetUpdates
  | WorkspaceResourceSetUpdates
  | NoResourceSetUpdates;

export const organizationResourceSetUpdates = (
  resourceTypes: ResourceTypes,
): OrganizationResourceSetUpdates => ({ scope: "organization", resourceTypes });

export const workspaceResourceSetUpdates = (
  resourceTypes: ResourceTypes,
): WorkspaceResourceSetUpdates => ({ scope: "workspace", resourceTypes });

export const noResourceSetUpdates = (reason: string): NoResourceSetUpdates => ({
  scope: "none",
  reason,
});

/** A handler result counts as a committed success unless it is an error status. */
export const isSuccessfulHandlerResult = (result: unknown): boolean => {
  if (result instanceof ElysiaCustomStatusResponse) {
    return result.code < 400;
  }
  if (result instanceof Response) {
    return result.ok;
  }
  return true;
};

const resourceTypesOf = (
  resourceTypes: ResourceTypes,
): ReadonlySet<ResourceType> =>
  new Set(typeof resourceTypes === "string" ? [resourceTypes] : resourceTypes);

type ResourceSetBroadcasts = {
  workspace: typeof broadcastWorkspaceResourceSetUpdated;
  organization: typeof broadcastOrganizationResourceSetUpdated;
};

const DEFAULT_BROADCASTS: ResourceSetBroadcasts = {
  workspace: broadcastWorkspaceResourceSetUpdated,
  organization: broadcastOrganizationResourceSetUpdated,
};

type AnnounceResourceSetUpdatesOptions = {
  realtime: ResourceSetRealtime | undefined;
  result: unknown;
  organizationId: SafeId<"organization">;
  /** The matter the request proved access to; absent for root handlers. */
  workspaceId: SafeId<"workspace"> | undefined;
  broadcasts?: ResourceSetBroadcasts;
};

/**
 * Broadcast the declared resource sets for one finished handler call. Called
 * by the safe-handler wrapper with the handler's final result.
 */
export const announceResourceSetUpdates = ({
  realtime,
  result,
  organizationId,
  workspaceId,
  broadcasts = DEFAULT_BROADCASTS,
}: AnnounceResourceSetUpdatesOptions): void => {
  if (
    realtime === undefined ||
    realtime.scope === "none" ||
    !isSuccessfulHandlerResult(result)
  ) {
    return;
  }
  const resourceTypes = resourceTypesOf(realtime.resourceTypes);
  if (realtime.scope === "workspace") {
    // Root handlers cannot declare a workspace scope (see the factory types);
    // a missing matter here means there is no audience to announce to.
    if (workspaceId === undefined) {
      return;
    }
    for (const resourceType of resourceTypes) {
      broadcasts.workspace(workspaceId, resourceType);
    }
    return;
  }
  for (const resourceType of resourceTypes) {
    broadcasts.organization(organizationId, resourceType);
  }
};
