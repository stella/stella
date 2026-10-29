import { useState } from "react";
import type { ComponentType } from "react";

import { useRouter } from "expo-router";
import { FlatList, View } from "react-native";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";
import { Text } from "@stll/ui/text";

import { useNewChat } from "@/components/new-chat";
import { useLayout, useSelection } from "@/components/selection";
import { usePaletteEntities } from "@/components/use-palette-entities";
import { useScan } from "@/components/use-scan";
import {
  AlarmClockIcon,
  CaseLawIcon,
  CogIcon,
  FolderIcon,
  FolderPlusIcon,
  ListTodoIcon,
  MessageSquareIcon,
  NewChatIcon,
  ScanTextIcon,
  SquareCheckIcon,
} from "@/icons.gen";
import { canScan } from "@/native/document-scanner";
import { KeyCommands } from "@/native/key-commands";
import { filterPalette, nextPaletteIndex } from "@/state/palette";
import type { PaletteItem } from "@/state/palette";
import { useUiColors } from "@/theme";

type Glyph = ComponentType<{ color: string; size: number }>;

type Runnable = PaletteItem & {
  readonly glyph: Glyph;
  readonly run: () => void;
};

/**
 * The command palette, as t3code opens one with ⌘K on an iPad: a field to
 * type in, and under it what the app can do and the matters and chats that
 * match, the first of them chosen. The arrows move the choice and Return
 * runs it; Escape, or ⌘K again, closes the palette. A matter or chat opens
 * beside its tab's list where the window has two columns.
 */
const PaletteScreen = () => {
  const t = useTranslations();
  const router = useRouter();
  const layout = useLayout();
  const selection = useSelection();
  const newChat = useNewChat();
  const scan = useScan(undefined, { replacing: true });
  const ui = useUiColors();
  const { chats, matters } = usePaletteEntities();
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState(0);

  // Leaves the palette first, so what opens next opens over the tabs.
  const closeThen = (next: () => void) => () => {
    router.back();
    next();
  };

  const actions: Runnable[] = [
    {
      glyph: NewChatIcon,
      key: "new-chat",
      kind: "action",
      run: closeThen(() => {
        newChat();
        if (layout.usesSplitView) {
          router.navigate("/");
        }
      }),
      terms: [t("tabs.chat")],
      title: t("chat.newChat"),
    },
    {
      glyph: SquareCheckIcon,
      key: "new-task",
      kind: "action",
      run: closeThen(() => {
        router.push("/task/new");
      }),
      terms: [t("tabs.tasks")],
      title: t("tasks.newTask"),
    },
    {
      glyph: FolderPlusIcon,
      key: "new-matter",
      kind: "action",
      run: closeThen(() => {
        router.push("/matter/new");
      }),
      terms: [t("tabs.matters")],
      title: t("matters.newMatter"),
    },
    {
      glyph: AlarmClockIcon,
      key: "start-timer",
      kind: "action",
      run: closeThen(() => {
        router.push("/timers/new");
      }),
      terms: [t("timers.title")],
      title: t("timers.startTimer"),
    },
    ...(canScan()
      ? [
          {
            glyph: ScanTextIcon,
            key: "scan",
            kind: "action",
            // The camera opens over the palette, which the scan's sheet then replaces.
            run: scan,
            terms: [],
            title: t("scan.title"),
          } as const,
        ]
      : []),
    {
      glyph: ListTodoIcon,
      key: "timers",
      kind: "action",
      run: closeThen(() => {
        router.push("/timers");
      }),
      terms: [],
      title: t("more.timers"),
    },
    {
      glyph: CaseLawIcon,
      key: "law",
      kind: "action",
      run: closeThen(() => {
        router.push("/law");
      }),
      terms: [],
      title: t("tabs.law"),
    },
    {
      glyph: CogIcon,
      key: "settings",
      kind: "action",
      run: closeThen(() => {
        router.push("/settings");
      }),
      terms: [],
      title: t("tabs.settings"),
    },
  ];

  const matterItems: Runnable[] = matters.map((matter) => ({
    detail: matter.client?.displayName,
    glyph: FolderIcon,
    key: `matter:${matter.id}`,
    kind: "matter",
    run: closeThen(() => {
      if (layout.usesSplitView) {
        selection.select("matter", {
          name: matter.name,
          workspaceId: matter.id,
        });
        router.navigate("/matters");
        return;
      }
      router.push({
        pathname: "/matter/[workspaceId]",
        params: { name: matter.name, workspaceId: matter.id },
      });
    }),
    terms: [matter.reference ?? "", matter.client?.displayName ?? ""],
    title: matter.name,
  }));

  const chatItems: Runnable[] = chats.map((chat) => {
    const title = chat.title === "" ? t("chat.untitled") : chat.title;
    return {
      detail: chat.matterName,
      glyph: MessageSquareIcon,
      key: `chat:${chat.id}`,
      kind: "chat",
      run: closeThen(() => {
        if (layout.usesSplitView) {
          selection.select("thread", {
            matterId: chat.matterId,
            threadId: chat.id,
            title,
          });
          router.navigate("/");
          return;
        }
        router.push({
          pathname: "/thread/[threadId]",
          params: {
            threadId: chat.id,
            title,
            ...(chat.matterId === undefined ? {} : { matterId: chat.matterId }),
          },
        });
      }),
      terms: [chat.matterName ?? ""],
      title,
    };
  });

  const runnable = new Map(
    [...actions, ...matterItems, ...chatItems].map((item) => [item.key, item]),
  );
  const results = filterPalette([...runnable.values()], query).flatMap(
    (item) => runnable.get(item.key) ?? [],
  );
  const current = Math.min(chosen, Math.max(results.length - 1, 0));

  return (
    <KeyCommands
      commands={[
        {
          id: "next",
          input: "down",
          modifiers: [],
          title: t("shortcuts.next"),
        },
        {
          id: "previous",
          input: "up",
          modifiers: [],
          title: t("shortcuts.previous"),
        },
        { id: "close", input: "escape", modifiers: [], title: t("tabs.close") },
        {
          id: "close",
          input: "k",
          modifiers: ["command"],
          title: t("tabs.close"),
        },
      ]}
      onCommand={(id) => {
        if (id === "close") {
          router.back();
        } else {
          setChosen(
            nextPaletteIndex(current, id === "next" ? 1 : -1, results.length),
          );
        }
      }}
    >
      <View className="bg-background flex-1">
        <View className="border-border border-b px-4 pt-5 pb-3">
          <Input
            accessibilityLabel={t("palette.placeholder")}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            onChangeText={(text) => {
              setQuery(text);
              setChosen(0);
            }}
            onSubmitEditing={() => {
              results[current]?.run();
            }}
            placeholder={t("palette.placeholder")}
            returnKeyType="go"
            value={query}
            type="search"
          />
        </View>
        <FlatList
          contentContainerStyle={{ paddingVertical: 8 }}
          data={results}
          keyboardShouldPersistTaps="handled"
          keyExtractor={(item) => item.key}
          ListEmptyComponent={
            <View className="items-center p-8">
              <Text variant="caption">
                {t("palette.noResults", { query: query.trim() })}
              </Text>
            </View>
          }
          renderItem={({ index, item }) => (
            <View className="px-2">
              <Button
                accessibilityState={{ selected: index === current }}
                onPress={item.run}
                size="row"
                variant="ghost"
              >
                <View className="flex-1 flex-row items-center gap-3 px-3 py-2.5">
                  <item.glyph color={ui.mutedForeground} size={18} />
                  <View className="flex-1">
                    <Text numberOfLines={1} variant="rowTitle">
                      {item.title}
                    </Text>
                    {item.detail === undefined || item.detail === "" ? null : (
                      <Text numberOfLines={1} variant="caption">
                        {item.detail}
                      </Text>
                    )}
                  </View>
                </View>
              </Button>
            </View>
          )}
        />
      </View>
    </KeyCommands>
  );
};

export default PaletteScreen;
