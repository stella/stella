import { Stack, useLocalSearchParams } from "expo-router";

import { MatterEntities } from "@/components/matter-entities";
import { useSession } from "@/connection/session-provider";

/** One matter, titled with the name its row carried so the header shows before the load returns. */
const MatterScreen = () => {
  const { workspaceId, name } = useLocalSearchParams<{
    workspaceId: string;
    name?: string;
  }>();
  const { state } = useSession();

  return (
    <>
      <Stack.Screen options={{ title: name ?? "" }} />
      {state.status === "signed-in" ? (
        <MatterEntities source={state.source} workspaceId={workspaceId} />
      ) : null}
    </>
  );
};

export default MatterScreen;
