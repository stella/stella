import { useLocalSearchParams, useRouter } from "expo-router";

import { EntityDetailSheet } from "@/components/entity-detail-sheet";
import { useSession } from "@/connection/session-provider";

/**
 * A document, folder or task, presented as a sheet over its matter; a task
 * deleted from it closes it.
 */
const EntityScreen = () => {
  const { workspaceId, entityId } = useLocalSearchParams<{
    workspaceId: string;
    entityId: string;
  }>();
  const { state } = useSession();
  const router = useRouter();

  return state.status === "signed-in" ? (
    <EntityDetailSheet
      entityId={entityId}
      onDeleted={() => {
        router.back();
      }}
      source={state.source}
      workspaceId={workspaceId}
    />
  ) : null;
};

export default EntityScreen;
