import {
  resourceDeletedRealtimeEvent,
  resourceUpdatedRealtimeEvent,
  type ResourceRef,
} from "@stll/api-contract";

import type { SafeId } from "@/api/lib/branded-types";
import { broadcast } from "@/api/lib/sse";

/**
 * Broadcast a resource fact within an already-authorized workspace scope.
 * Resource identity does not grant access; callers must supply the workspace
 * from their authenticated mutation or system-owned job context.
 */
export const broadcastWorkspaceResourceUpdated = (
  workspaceId: SafeId<"workspace">,
  resource: ResourceRef,
): void => {
  broadcast(workspaceId, resourceUpdatedRealtimeEvent(resource));
};

export const broadcastWorkspaceResourceDeleted = (
  workspaceId: SafeId<"workspace">,
  resource: ResourceRef,
): void => {
  broadcast(workspaceId, resourceDeletedRealtimeEvent(resource));
};
