import { Stack, useRouter, useSegments } from "expo-router";
import type { NativeStackHeaderItem } from "expo-router/native-stack";
import { useTranslations } from "use-intl";

import {
  HeaderSearchProvider,
  useHeaderSearch,
} from "@/components/header-search";
import { MattersViewProvider, useMattersView } from "@/components/matters-view";
import { useNewChat } from "@/components/new-chat";
import { TasksViewProvider } from "@/components/tasks-view";
import { TimersViewProvider } from "@/components/timers-view";
import { useGlyphImage } from "@/components/ui/use-glyph-image";
import { useSession } from "@/connection/session-provider";
import { useAppColors } from "@/theme";

/** Signed out, only sign-in exists; signed in, only the app does. */
export const ProtectedScreens = () => {
  const segments: readonly string[] = useSegments();
  // A screen pushed over the tabs keeps the tab's search for the way back.
  const activeTab =
    segments[0] === "(tabs)" ? (segments[1] ?? "index") : undefined;
  return (
    <HeaderSearchProvider activeTab={activeTab}>
      <MattersViewProvider>
        <TasksViewProvider>
          <TimersViewProvider>
            <Screens />
          </TimersViewProvider>
        </TasksViewProvider>
      </MattersViewProvider>
    </HeaderSearchProvider>
  );
};

/**
 * The app's screens. The tabs share one header, the platform's own bar with
 * glass where the system has it, laid out as GitHub's app lays its out: the
 * person's button leading, to the settings; no title, as the tab bar already
 * says where one is; the tab's own action and search trailing, together. The
 * action is the tab's "+": a new conversation over the chats, a new task over
 * the tasks and a new matter over the matters, which also offer how to group
 * them. Search is the system's field, which the list under it filters by;
 * More has nothing to search.
 */
const Screens = () => {
  const { state } = useSession();
  const colors = useAppColors();
  const tabs = useTranslations("tabs");
  const header = useTranslations("header");
  const signedIn = state.status === "signed-in";
  const router = useRouter();
  const { searchBar, setQuery, setSearching, tab } = useHeaderSearch();
  const accountGlyph = useGlyphImage("circle-user-round");
  const closeGlyph = useGlyphImage("x");
  const tabItems = useTabHeaderItems(tab);

  // A screen opened from a tab has GitHub's bar: the bare back chevron and a
  // small title in the middle, never a large one.
  const pushedScreen = {
    contentStyle: { backgroundColor: colors.background },
    headerBackButtonDisplayMode: "minimal",
    headerShadowVisible: false,
    headerShown: true,
    headerStyle: { backgroundColor: colors.background },
    headerTintColor: colors.text,
    headerTitleStyle: { color: colors.text },
  } as const;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen
          name="(tabs)"
          options={{
            headerShadowVisible: false,
            headerShown: true,
            headerTintColor: colors.text,
            headerTransparent: true,
            // The system's own search button, which opens straight into the
            // field, as t3code's search does; the bar's trailing edge holds it.
            headerSearchBarOptions:
              tab === "more"
                ? undefined
                : {
                    allowToolbarIntegration: false,
                    autoCapitalize: "none",
                    hideWhenScrolling: false,
                    onClose: () => {
                      setSearching(false);
                    },
                    onChangeText: (event) => {
                      setQuery(event.nativeEvent.text);
                    },
                    onOpen: () => {
                      setSearching(true);
                    },
                    placeholder: header("search"),
                    placement: "integratedButton",
                    ref: searchBar,
                  },
            title: "",
            unstable_headerLeftItems: () =>
              accountGlyph === null
                ? []
                : [
                    {
                      icon: { source: accountGlyph, type: "image" },
                      label: tabs("settings"),
                      onPress: () => {
                        router.push("/settings");
                      },
                      type: "button",
                    },
                  ],
            unstable_headerRightItems: () => tabItems,
          }}
        />
        <Stack.Screen
          name="settings"
          options={{
            ...pushedScreen,
            presentation: "modal",
            title: tabs("settings"),
            unstable_headerRightItems: () =>
              closeGlyph === null
                ? []
                : [
                    {
                      icon: { source: closeGlyph, type: "image" },
                      label: tabs("close"),
                      onPress: () => {
                        router.back();
                      },
                      type: "button",
                    },
                  ],
          }}
        />
        <Stack.Screen name="thread/[threadId]" />
        <Stack.Screen
          name="matter/new"
          options={{
            ...pushedScreen,
            presentation: "formSheet",
            sheetAllowedDetents: [0.5, 1],
            sheetGrabberVisible: true,
          }}
        />
        <Stack.Screen name="timers/index" options={pushedScreen} />
        <Stack.Screen
          name="timers/new"
          options={{
            ...pushedScreen,
            presentation: "formSheet",
            sheetAllowedDetents: [0.75, 1],
            sheetGrabberVisible: true,
          }}
        />
        <Stack.Screen
          name="task/new"
          options={{
            ...pushedScreen,
            presentation: "formSheet",
            sheetAllowedDetents: [0.75, 1],
            sheetGrabberVisible: true,
          }}
        />
        <Stack.Screen
          name="law/index"
          options={{
            ...pushedScreen,
            title: tabs("law"),
          }}
        />
        <Stack.Screen name="law/[decisionId]" />
        <Stack.Screen
          name="matter/[workspaceId]/index"
          options={pushedScreen}
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

/** The header's action for a tab, if it has one. */
const useTabHeaderItems = (tab: string): NativeStackHeaderItem[] => {
  const chat = useTranslations("chat");
  const matters = useTranslations("matters");
  const tasks = useTranslations("tasks");
  const router = useRouter();
  const newChat = useNewChat();
  const { groupBy, setGroupBy } = useMattersView();
  const plusGlyph = useGlyphImage("plus");
  const groupGlyph = useGlyphImage("sliders-horizontal");

  if (tab === "index" && plusGlyph !== null) {
    return [
      {
        icon: { source: plusGlyph, type: "image" },
        label: chat("newChat"),
        onPress: newChat,
        type: "button",
      },
    ];
  }
  if (tab === "tasks" && plusGlyph !== null) {
    return [
      {
        icon: { source: plusGlyph, type: "image" },
        label: tasks("newTask"),
        onPress: () => {
          router.push("/task/new");
        },
        type: "button",
      },
    ];
  }
  if (tab === "matters" && plusGlyph !== null && groupGlyph !== null) {
    return [
      {
        icon: { source: plusGlyph, type: "image" },
        label: matters("newMatter"),
        onPress: () => {
          router.push("/matter/new");
        },
        type: "button",
      },
      {
        icon: { source: groupGlyph, type: "image" },
        label: matters("groupBy"),
        menu: {
          items: [
            {
              label: matters("groupClient"),
              onPress: () => {
                setGroupBy("client");
              },
              state: groupBy === "client" ? "on" : "off",
              type: "action",
            },
            {
              label: matters("noGrouping"),
              onPress: () => {
                setGroupBy("none");
              },
              state: groupBy === "none" ? "on" : "off",
              type: "action",
            },
          ],
          title: matters("groupBy"),
        },
        type: "menu",
      },
    ];
  }
  return [];
};
