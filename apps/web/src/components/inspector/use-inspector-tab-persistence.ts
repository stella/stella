import { useLayoutEffect } from "react";

import { readPersistedInspectorPaneOpen } from "@/components/inspector/inspector-broadcast";
import { initializeInspectorTabBroadcast } from "@/components/inspector/inspector-tabs-store";
import type { InspectorBroadcastScope } from "@/components/inspector/inspector-tabs-store";
import { useStorageOwner } from "@/lib/account/use-owner-scoped-state";

/**
 * Restores a member's inspector tabs from storage and keeps them persisted
 * and shared across windows, for one user inside one organization.
 *
 * Every shell that docks the inspector for a member calls this: a shell that
 * did not would open on an empty store, so a legal document's chat tab, the
 * thing that carries its one conversation across a reload, would be lost and
 * the reader would start a fresh thread on every visit.
 *
 * A layout effect, so the restored tabs are in the store before any route
 * below seeds its own and before anything paints the previous scope.
 */
export const useInspectorTabPersistence = ({
  organizationId,
  userId,
}: InspectorBroadcastScope) => {
  const owner = useStorageOwner();
  useLayoutEffect(() => {
    if (owner.kind !== "user" || owner.userId !== userId) {
      return undefined;
    }
    return initializeInspectorTabBroadcast({ organizationId, userId });
  }, [organizationId, owner, userId]);

  // The authenticated shell already knows the scope. Reserve its saved layout
  // while the storage-owner subscription is still hydrating; unknown tabs are
  // not an empty inspector. Tab contents still restore through the owner gate.
  if (owner.kind === "user" && owner.userId === userId) {
    return false;
  }
  return readPersistedInspectorPaneOpen({ organizationId, userId });
};
