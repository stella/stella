import { View } from "react-native";

import { ChatsList } from "@/components/chats-list";
import { screenStyles } from "@/components/empty-state-screen";
import { useSession } from "@/connection/session-provider";
import { useAppColors } from "@/theme";

const ChatsScreen = () => {
  const colors = useAppColors();
  const { state } = useSession();

  return (
    <View style={[screenStyles.screen, { backgroundColor: colors.background }]}>
      {state.status === "signed-in" ? (
        <ChatsList source={state.source} />
      ) : null}
    </View>
  );
};

export default ChatsScreen;
