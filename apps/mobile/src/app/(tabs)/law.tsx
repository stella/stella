import { View } from "react-native";

import { CaseLawList } from "@/components/case-law-list";
import { screenStyles } from "@/components/empty-state-screen";
import { useSession } from "@/connection/session-provider";
import { useAppColors } from "@/theme";

/** The public case law of the signed-in server, searched from the header. */
const LawScreen = () => {
  const colors = useAppColors();
  const { state } = useSession();

  return (
    <View style={[screenStyles.screen, { backgroundColor: colors.background }]}>
      {state.status === "signed-in" ? (
        <CaseLawList serverUrl={state.source.session().serverUrl} />
      ) : null}
    </View>
  );
};

export default LawScreen;
