import { Stack } from "expo-router";
import { useTranslations } from "use-intl";

import { useSession } from "@/connection/session-provider";
import { useAppColors } from "@/theme";

/** Signed out, only sign-in exists; signed in, only the app does. */
export const ProtectedScreens = () => {
  const { state } = useSession();
  const colors = useAppColors();
  const tabs = useTranslations("tabs");
  const signedIn = state.status === "signed-in";

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="thread/[threadId]" />
        <Stack.Screen
          name="matter/[workspaceId]/index"
          options={{
            contentStyle: { backgroundColor: colors.background },
            headerBackTitle: tabs("matters"),
            headerLargeTitle: true,
            headerLargeTitleShadowVisible: false,
            headerShadowVisible: false,
            headerShown: true,
            headerStyle: { backgroundColor: colors.background },
            headerTintColor: colors.accent,
            headerTitleStyle: { color: colors.text },
          }}
        />
        <Stack.Screen
          name="matter/[workspaceId]/[entityId]"
          options={{
            contentStyle: { backgroundColor: colors.card },
            presentation: "formSheet",
            sheetAllowedDetents: [0.5, 1],
            sheetGrabberVisible: true,
          }}
        />
      </Stack.Protected>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
    </Stack>
  );
};
