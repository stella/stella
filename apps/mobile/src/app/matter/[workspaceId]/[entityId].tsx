import { useLocalSearchParams } from "expo-router";

import { EntityDetailSheet } from "@/components/entity-detail-sheet";
import { useSession } from "@/connection/session-provider";

/** A document, folder or task, presented as a sheet over its matter. */
const EntityScreen = () => {
  const { workspaceId, entityId } = useLocalSearchParams<{
    workspaceId: string;
    entityId: string;
  }>();
  const { state } = useSession();

  return state.status === "signed-in" ? (
    <EntityDetailSheet
      entityId={entityId}
      source={state.source}
      workspaceId={workspaceId}
    />
  ) : null;
};

export default EntityScreen;
