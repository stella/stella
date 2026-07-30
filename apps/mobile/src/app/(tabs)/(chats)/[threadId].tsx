import { useRef, type ReactNode } from "react";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  View,
} from "react-native";

import type { ChatMessage } from "@stll/api/types";

import { ActionButton } from "@/components/action-button";
import { useActiveOrganizationId } from "@/features/auth/auth-session-boundary";
import { mergeMobileChatThreadPages } from "@/features/chats/chat-thread-pages";
import {
  mobileChatThreadOptions,
  type MobileChatThreadRef,
} from "@/features/chats/chat-thread-query";
import { mobileMessage } from "@/i18n/messages";
import { useAppColors } from "@/theme";

const firstParam = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

export default function ChatThreadScreen() {
  const colors = useAppColors();
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const didInitialScroll = useRef(false);
  const activeOrganizationId = useActiveOrganizationId();
  const params = useLocalSearchParams<{
    scope?: string | string[];
    threadId?: string | string[];
    title?: string | string[];
    workspaceId?: string | string[];
  }>();
  const threadId = firstParam(params.threadId) ?? "";
  const workspaceId = firstParam(params.workspaceId);
  const ref: MobileChatThreadRef =
    firstParam(params.scope) === "workspace" && workspaceId !== undefined
      ? { scope: "workspace", threadId, workspaceId }
      : { scope: "global", threadId };
  const query = useInfiniteQuery(
    mobileChatThreadOptions(activeOrganizationId, ref),
  );
  const messages = mergeMobileChatThreadPages(query.data?.pages);
  let emptyContent: ReactNode;

  if (query.isPending) {
    emptyContent = (
      <ActivityIndicator accessibilityLabel={mobileMessage("loading")} />
    );
  } else if (query.isError) {
    emptyContent = (
      <>
        <Text style={{ color: colors.danger }}>
          {mobileMessage("loadError")}
        </Text>
        <ActionButton
          label={mobileMessage("retry")}
          onPress={() => {
            query.refetch().catch(() => undefined);
          }}
          variant="secondary"
        />
      </>
    );
  } else {
    emptyContent = (
      <Text style={{ color: colors.muted }}>{mobileMessage("noThreads")}</Text>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          headerLargeTitle: false,
          title:
            firstParam(params.title)?.trim() || mobileMessage("openThread"),
        }}
      />
      <FlatList
        contentContainerStyle={styles.content}
        data={messages}
        ref={listRef}
        keyExtractor={(message) => message.id}
        ListEmptyComponent={<View style={styles.empty}>{emptyContent}</View>}
        ListHeaderComponent={
          query.hasNextPage ? (
            <View style={styles.olderMessages}>
              <ActionButton
                disabled={query.isFetchingNextPage}
                label={mobileMessage("loadEarlier")}
                loading={query.isFetchingNextPage}
                onPress={() => {
                  query.fetchNextPage().catch(() => undefined);
                }}
                variant="secondary"
              />
              {query.isFetchNextPageError ? (
                <Text style={{ color: colors.danger }}>
                  {mobileMessage("loadError")}
                </Text>
              ) : null}
            </View>
          ) : null
        }
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        onContentSizeChange={() => {
          if (!didInitialScroll.current && messages.length > 0) {
            listRef.current?.scrollToEnd({ animated: false });
            didInitialScroll.current = true;
          }
        }}
        renderItem={({ item }) => {
          const text = item.parts
            .filter((part) => part.type === "text")
            .map((part) => part.content)
            .join("\n\n")
            .trim();
          if (text.length === 0) {
            return null;
          }

          return (
            <View
              style={[
                styles.message,
                {
                  alignSelf: item.role === "user" ? "flex-end" : "stretch",
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                },
              ]}
            >
              <Text selectable style={{ color: colors.text }}>
                {text}
              </Text>
            </View>
          );
        }}
        style={{ backgroundColor: colors.background }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: 12,
    padding: 16,
  },
  empty: {
    alignItems: "center",
    gap: 16,
    justifyContent: "center",
    minHeight: 240,
  },
  message: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: "88%",
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  olderMessages: {
    alignItems: "center",
    gap: 8,
  },
});
