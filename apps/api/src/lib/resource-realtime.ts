import {
  resourceDeletedRealtimeEvent,
  resourceSetUpdatedRealtimeEvent,
  resourceUpdatedRealtimeEvent,
  resourcesChangedRealtimeEvent,
  type ResourceChange,
  type ResourceRef,
  type ResourceType,
} from "@stll/api-contract";

import type { SafeId } from "@/api/lib/branded-types";
import { broadcast, broadcastToOrganization } from "@/api/lib/sse";

/**
 * Broadcast a resource fact within an already-authorized workspace scope.
 * Resource identity does not grant access; callers must supply the workspace
 * from their authenticated mutation or system-owned job context.
 */
export const broadcastWorkspaceResourceUpdated = (
  workspaceId: SafeId<"workspace">,
  resource: ResourceRef,
  broadcastEvent: typeof broadcast = broadcast,
): void => {
  broadcastEvent(workspaceId, resourceUpdatedRealtimeEvent(resource));
};

export const broadcastWorkspaceResourceDeleted = (
  workspaceId: SafeId<"workspace">,
  resource: ResourceRef,
): void => {
  broadcast(workspaceId, resourceDeletedRealtimeEvent(resource));
};

export const broadcastWorkspaceResourceChanges = (
  workspaceId: SafeId<"workspace">,
  changes: readonly ResourceChange[],
): void => {
  broadcast(workspaceId, resourcesChangedRealtimeEvent(changes));
};

export const broadcastWorkspaceResourceSetUpdated = (
  workspaceId: SafeId<"workspace">,
  resourceType: ResourceType,
  broadcastEvent: typeof broadcast = broadcast,
): void => {
  broadcastEvent(workspaceId, resourceSetUpdatedRealtimeEvent(resourceType));
};

/** Organization fan-out carries a public resource type, never a resource ID. */
export const broadcastOrganizationResourceSetUpdated = (
  organizationId: SafeId<"organization">,
  resourceType: ResourceType,
): void => {
  broadcastToOrganization(
    organizationId,
    resourceSetUpdatedRealtimeEvent(resourceType),
  );
};
