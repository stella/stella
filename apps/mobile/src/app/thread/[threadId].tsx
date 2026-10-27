import { Stack, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslations } from "use-intl";

import { ChatThreadView } from "@/components/chat-thread-view";
import { screenStyles } from "@/components/empty-state-screen";
import { useSession } from "@/connection/session-provider";
import { useAppColors } from "@/theme";

/** One chat thread, opened from the Chat tab, which passes its title along so the header shows it before the messages load, and its matter, which the server asks for. */
const ThreadScreen = () => {
  const colors = useAppColors();
  const t = useTranslations("chat");
  const { state } = useSession();
  const { matterId, threadId, title } = useLocalSearchParams<{
    matterId?: string;
    threadId: string;
    title?: string;
  }>();

  return (
    <SafeAreaView
      edges={["bottom"]}
      style={[screenStyles.screen, { backgroundColor: colors.background }]}
    >
      <Stack.Screen
        options={{
          headerBackButtonDisplayMode: "minimal",
          headerShown: true,
          headerStyle: { backgroundColor: colors.card },
          headerTintColor: colors.accent,
          headerTitleStyle: { color: colors.text },
          title: title ?? t("threadTitle"),
        }}
      />
      {state.status === "signed-in" ? (
        <ChatThreadView
          matterId={matterId}
          source={state.source}
          threadId={threadId}
        />
      ) : null}
    </SafeAreaView>
  );
};

export default ThreadScreen;
