import { Stack, useRouter, useSegments } from "expo-router";
import type { Href } from "expo-router";
import { useTranslations } from "use-intl";

import { ChangesProvider } from "@/components/changes";
import {
  HeaderSearchProvider,
  useHeaderSearch,
} from "@/components/header-search";
import { MattersViewProvider, useMattersView } from "@/components/matters-view";
import { useNewChat } from "@/components/new-chat";
import { PushRegistration } from "@/components/push-registration";
import { SelectionProvider, useSelection } from "@/components/selection";
import { TimerActivitySync } from "@/components/timer-activity-sync";
import { barGlyph } from "@/components/ui/bar-glyph";
import { useSession } from "@/connection/session-provider";
import { DraftRecovery } from "@/features/dictation/draft-recovery";
import { useDictationRecorder } from "@/features/dictation/identity";
import { DictationSessionBoundary } from "@/features/dictation/session-boundary";
import { KeyCommands } from "@/native/key-commands";
import type { KeyCommand } from "@/native/key-commands";
import { LayoutMetricsProvider } from "@/native/layout-metrics";
import { useAppColors } from "@/theme";

/** Signed out, only sign-in exists; signed in, only the app does. */
export const ProtectedScreens = () => {
  const dictationRecorder = useDictationRecorder();
  const segments: readonly string[] = useSegments();
  // A screen pushed over the tabs keeps the tab's search for the way back.
  const activeTab =
    segments[0] === "(tabs)" ? (segments[1] ?? "index") : undefined;
  return (
    <LayoutMetricsProvider>
      <HeaderSearchProvider activeTab={activeTab}>
        <MattersViewProvider>
          <ChangesProvider>
            <SelectionProvider>
              <TimerActivitySync />
              <PushRegistration />
              <DictationSessionBoundary />
              <DraftRecovery recorder={dictationRecorder} />
              <Screens />
            </SelectionProvider>
          </ChangesProvider>
        </MattersViewProvider>
      </HeaderSearchProvider>
    </LayoutMetricsProvider>
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
 * More has nothing to search. Every button draws a lucide glyph from the
 * asset catalog (`barGlyph`), which the bar has as it is built.
 */
const Screens = () => {
  const { state } = useSession();
  const colors = useAppColors();
  const tabs = useTranslations("tabs");
  const header = useTranslations("header");
  const matters = useTranslations("matters");
  const signedIn = state.status === "signed-in";
  const router = useRouter();
  const { searchBar, setQuery, setSearching, tab } = useHeaderSearch();
  const { groupBy, setGroupBy } = useMattersView();
  const tabAction = useTabAction(tab);

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

  const shortcuts = useShortcuts(tabAction);

  return (
    <KeyCommands commands={shortcuts.commands} onCommand={shortcuts.run}>
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
              ...(tab === "more"
                ? {}
                : {
                    headerSearchBarOptions: {
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
                  }),
              title: "",
            }}
          >
            <Stack.Toolbar placement="left">
              <Stack.Toolbar.Button
                onPress={() => {
                  router.push("/settings");
                }}
              >
                {barGlyph("circle-user-round")}
                <Stack.Toolbar.Label>{tabs("settings")}</Stack.Toolbar.Label>
              </Stack.Toolbar.Button>
            </Stack.Toolbar>
            <Stack.Toolbar placement="right">
              {tabAction === undefined ? null : (
                <Stack.Toolbar.Button onPress={tabAction.onPress}>
                  {barGlyph("plus")}
                  <Stack.Toolbar.Label>{tabAction.label}</Stack.Toolbar.Label>
                </Stack.Toolbar.Button>
              )}
              {tab === "matters" ? (
                <Stack.Toolbar.Menu title={matters("groupBy")}>
                  {barGlyph("sliders-horizontal")}
                  <Stack.Toolbar.MenuAction
                    isOn={groupBy === "client"}
                    onPress={() => {
                      setGroupBy("client");
                    }}
                  >
                    {matters("groupClient")}
                  </Stack.Toolbar.MenuAction>
                  <Stack.Toolbar.MenuAction
                    isOn={groupBy === "none"}
                    onPress={() => {
                      setGroupBy("none");
                    }}
                  >
                    {matters("noGrouping")}
                  </Stack.Toolbar.MenuAction>
                </Stack.Toolbar.Menu>
              ) : null}
            </Stack.Toolbar>
          </Stack.Screen>
          <Stack.Screen
            name="settings"
            options={{
              ...pushedScreen,
              presentation: "modal",
              title: tabs("settings"),
            }}
          >
            <Stack.Toolbar placement="right">
              <Stack.Toolbar.Button
                onPress={() => {
                  router.back();
                }}
              >
                {barGlyph("x")}
                <Stack.Toolbar.Label>{tabs("close")}</Stack.Toolbar.Label>
              </Stack.Toolbar.Button>
            </Stack.Toolbar>
          </Stack.Screen>
          <Stack.Screen name="thread/[threadId]" />
          <Stack.Screen
            name="palette"
            options={{
              contentStyle: { backgroundColor: colors.background },
              presentation: "formSheet",
              sheetAllowedDetents: [0.75, 1],
              sheetGrabberVisible: true,
            }}
          />
          <Stack.Screen
            name="matter/new"
            options={{
              ...pushedScreen,
              presentation: "formSheet",
              sheetAllowedDetents: [0.5, 1],
              sheetGrabberVisible: true,
            }}
          />
          <Stack.Screen
            name="scan"
            options={{
              ...pushedScreen,
              presentation: "formSheet",
              sheetAllowedDetents: [0.75, 1],
              sheetGrabberVisible: true,
            }}
          />
          <Stack.Screen
            name="dictation"
            options={{ ...pushedScreen, presentation: "modal" }}
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
    </KeyCommands>
  );
};

/** Where ⌘1 to ⌘4 go. */
const TAB_ROUTES: ReadonlyMap<string, Href> = new Map([
  ["tab.chat", "/"],
  ["tab.tasks", "/tasks"],
  ["tab.matters", "/matters"],
  ["tab.more", "/more"],
]);

/**
 * A hardware keyboard's shortcuts, as t3code gives an iPad: ⌘N for the
 * open tab's "+", ⌘F to search it, ⌘K for the command palette, ⌘\ to put
 * the list beside a selection away, ⌘1 to ⌘4 for the tabs, ⌘, for the
 * settings and Escape to close what is open over them.
 */
function useShortcuts(primary: TabAction | undefined): {
  commands: readonly KeyCommand[];
  run: (id: string) => void;
} {
  const t = useTranslations("shortcuts");
  const tabs = useTranslations("tabs");
  const router = useRouter();
  const { searchBar } = useHeaderSearch();
  const selection = useSelection();

  const commands: KeyCommand[] = [
    ...(primary === undefined
      ? []
      : [
          {
            id: "new",
            input: "n",
            modifiers: ["command"] as const,
            title: primary.label,
          },
        ]),
    { id: "search", input: "f", modifiers: ["command"], title: t("search") },
    { id: "palette", input: "k", modifiers: ["command"], title: t("palette") },
    { id: "list", input: "\\", modifiers: ["command"], title: t("toggleList") },
    { id: "tab.chat", input: "1", modifiers: ["command"], title: tabs("chat") },
    {
      id: "tab.tasks",
      input: "2",
      modifiers: ["command"],
      title: tabs("tasks"),
    },
    {
      id: "tab.matters",
      input: "3",
      modifiers: ["command"],
      title: tabs("matters"),
    },
    { id: "tab.more", input: "4", modifiers: ["command"], title: tabs("more") },
    {
      id: "settings",
      input: ",",
      modifiers: ["command"],
      title: tabs("settings"),
    },
    { id: "close", input: "escape", modifiers: [], title: tabs("close") },
  ];

  const run = (id: string) => {
    if (id === "new") {
      primary?.onPress();
    } else if (id === "search") {
      searchBar.current?.focus();
    } else if (id === "list") {
      selection.toggleList();
    } else if (id === "palette") {
      router.push("/palette");
    } else if (id === "settings") {
      router.push("/settings");
    } else if (id === "close") {
      if (router.canGoBack()) {
        router.back();
      }
    } else {
      const route = TAB_ROUTES.get(id);
      if (route !== undefined) {
        router.navigate(route);
      }
    }
  };

  return { commands, run };
}

/** A tab's "+": what it starts, and starting it. */
type TabAction = { label: string; onPress: () => void };

/** The header's "+" for a tab, if it has one; ⌘N presses it too. */
function useTabAction(tab: string): TabAction | undefined {
  const chat = useTranslations("chat");
  const matters = useTranslations("matters");
  const tasks = useTranslations("tasks");
  const router = useRouter();
  const newChat = useNewChat();

  if (tab === "index") {
    return { label: chat("newChat"), onPress: newChat };
  }
  if (tab === "tasks") {
    return {
      label: tasks("newTask"),
      onPress: () => {
        router.push("/task/new");
      },
    };
  }
  if (tab === "matters") {
    return {
      label: matters("newMatter"),
      onPress: () => {
        router.push("/matter/new");
      },
    };
  }
  return undefined;
}
