import { View } from "react-native";

import { screenStyles } from "@/components/empty-state-screen";
import { MattersList } from "@/components/matters-list";
import { useSession } from "@/connection/session-provider";
import { useAppColors } from "@/theme";

const MattersScreen = () => {
  const colors = useAppColors();
  const { state } = useSession();

  return (
    <View style={[screenStyles.screen, { backgroundColor: colors.background }]}>
      {state.status === "signed-in" ? (
        <MattersList source={state.source} />
      ) : null}
    </View>
  );
};

export default MattersScreen;
