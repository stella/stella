import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslations } from "use-intl";

import { MatterPane } from "@/components/detail-panes";
import { screenStyles } from "@/components/empty-state-screen";
import { MattersList } from "@/components/matters-list";
import { useSelection } from "@/components/selection";
import { SplitPane } from "@/components/split-pane";
import { useSession } from "@/connection/session-provider";
import { useAppColors } from "@/theme";

const MattersScreen = () => {
  const colors = useAppColors();
  const { state } = useSession();
  const selection = useSelection();
  const t = useTranslations("matters");

  return (
    // Left and right: an iPhone Duo docks the tab bar as a rail at the side.
    <SafeAreaView
      edges={["left", "right"]}
      style={[screenStyles.screen, { backgroundColor: colors.background }]}
    >
      {state.status === "signed-in" ? (
        <SplitPane
          detail={
            selection.matter === null ? null : (
              <MatterPane
                key={selection.matter.workspaceId}
                matter={selection.matter}
              />
            )
          }
          emptyDescription={t("pickDescription")}
          emptyTitle={t("pickTitle")}
          list={<MattersList source={state.source} />}
        />
      ) : null}
    </SafeAreaView>
  );
};

export default MattersScreen;
