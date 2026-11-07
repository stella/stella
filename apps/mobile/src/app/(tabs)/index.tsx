import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslations } from "use-intl";

import { ChatsList } from "@/components/chats-list";
import { ThreadPane } from "@/components/detail-panes";
import { screenStyles } from "@/components/empty-state-screen";
import { useSelection } from "@/components/selection";
import { SplitPane } from "@/components/split-pane";
import { useSession } from "@/connection/session-provider";
import { useAppColors } from "@/theme";

const ChatsScreen = () => {
  const colors = useAppColors();
  const { state } = useSession();
  const selection = useSelection();
  const t = useTranslations("chat");

  return (
    // Left and right: an iPhone Duo docks the tab bar as a rail at the side.
    <SafeAreaView
      edges={["left", "right"]}
      style={[screenStyles.screen, { backgroundColor: colors.background }]}
    >
      {state.status === "signed-in" ? (
        <SplitPane
          detail={
            selection.thread === null ? null : (
              <ThreadPane
                key={selection.thread.threadId}
                thread={selection.thread}
              />
            )
          }
          emptyDescription={t("pickDescription")}
          emptyTitle={t("pickTitle")}
          list={<ChatsList source={state.source} />}
        />
      ) : null}
    </SafeAreaView>
  );
};

export default ChatsScreen;
