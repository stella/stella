import { Stack, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { KeyboardAvoidingView, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslations } from "use-intl";

import { ChatThreadView } from "@/components/chat-thread-view";
import { screenStyles } from "@/components/empty-state-screen";
import { useSession } from "@/connection/session-provider";
import { useAppColors } from "@/theme";

/**
 * One chat thread, opened from the Chat tab, which passes its title along so
 * the header shows it before the messages load. A new conversation arrives
 * `fresh`, under an id the phone chose. The message box rides above the
 * keyboard; the view sits under the header, so the keyboard's offset counts
 * from there.
 */
const ThreadScreen = () => {
  const colors = useAppColors();
  const t = useTranslations("chat");
  const headerHeight = useHeaderHeight();
  const { state } = useSession();
  const { fresh, threadId, title } = useLocalSearchParams<{
    fresh?: string;
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
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={headerHeight}
        style={screenStyles.screen}
      >
        {state.status === "signed-in" ? (
          <ChatThreadView
            fresh={fresh === "1"}
            source={state.source}
            threadId={threadId}
          />
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

export default ThreadScreen;
