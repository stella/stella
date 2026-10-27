import { useState } from "react";

import { Stack, useRouter } from "expo-router";
import { useWindowDimensions, View } from "react-native";
import { useTranslations } from "use-intl";

import {
  HeaderSearchProvider,
  useHeaderSearch,
} from "@/components/header-search";
import { StellaWordmark } from "@/components/ui/stella-wordmark";
import { useGlyphImage } from "@/components/ui/use-glyph-image";
import { useSession } from "@/connection/session-provider";
import { useAppColors } from "@/theme";

/** Signed out, only sign-in exists; signed in, only the app does. */
export const ProtectedScreens = () => (
  <HeaderSearchProvider>
    <Screens />
  </HeaderSearchProvider>
);

/**
 * The app's screens. The tabs share t3code's header: the platform's own bar,
 * glass where the system has it, with the stella wordmark leading, and search
 * and settings trailing; search is the system's field, which the list under
 * it filters by.
 */
const Screens = () => {
  const { state } = useSession();
  const colors = useAppColors();
  const tabs = useTranslations("tabs");
  const header = useTranslations("header");
  const signedIn = state.status === "signed-in";
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { setQuery } = useHeaderSearch();
  const settingsGlyph = useGlyphImage("cog");
  const searchGlyph = useGlyphImage("search");
  // Search folds into a header button, as t3code's does, and opens the
  // system's field under the bar when pressed.
  const [searching, setSearching] = useState(false);

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen
          name="(tabs)"
          options={{
            headerShadowVisible: false,
            headerShown: true,
            headerTintColor: colors.text,
            // The wordmark leads, as a title the width of the bar would not.
            headerTitle: () => (
              <View style={{ width: Math.max(0, width - 140) }}>
                <StellaWordmark height={20} />
              </View>
            ),
            headerTransparent: true,
            headerSearchBarOptions: searching
              ? {
                  autoCapitalize: "none",
                  autoFocus: true,
                  hideWhenScrolling: false,
                  onCancelButtonPress: () => {
                    setQuery("");
                    setSearching(false);
                  },
                  onChangeText: (event) => {
                    setQuery(event.nativeEvent.text);
                  },
                  placeholder: header("search"),
                  placement: "stacked",
                }
              : undefined,
            title: "stella",
            // UIKit lays trailing items out from the edge inward.
            unstable_headerRightItems: () => [
              ...(searchGlyph === null
                ? []
                : [
                    {
                      icon: { source: searchGlyph, type: "image" as const },
                      label: header("search"),
                      onPress: () => {
                        setSearching(true);
                      },
                      type: "button" as const,
                    },
                  ]),
              ...(settingsGlyph === null
                ? []
                : [
                    {
                      icon: { source: settingsGlyph, type: "image" as const },
                      label: tabs("settings"),
                      onPress: () => {
                        router.push("/settings");
                      },
                      type: "button" as const,
                    },
                  ]),
            ],
          }}
        />
        <Stack.Screen name="settings" options={{ presentation: "modal" }} />
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
