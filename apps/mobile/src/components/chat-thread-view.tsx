import { Suspense, use, useState, useTransition } from "react";

import { Result } from "better-result";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  View,
} from "react-native";
import { useTranslations } from "use-intl";

import { ChatMessage } from "@/components/chat-message";
import { EmptyCard } from "@/components/empty-state-screen";
import { PagingFooter, RetryButton } from "@/components/retry-button";
import type { PagingState } from "@/components/retry-button";
import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import type { Load } from "@/state/api-request";
import {
  prependOlderPage,
  readChatThread,
  readOlderChatMessages,
} from "@/state/chat-messages";
import type { ChatMessagesPage } from "@/state/chat-messages";
import { useAppColors } from "@/theme";

/** Loads one thread's latest messages, and again on every pull to refresh. */
export const ChatThreadView = ({
  source,
  threadId,
}: {
  source: AccessTokenSource;
  threadId: string;
}) => {
  const colors = useAppColors();
  const { end } = useSession();
  const loadThread = async (): Promise<Load<ChatMessagesPage>> => {
    const result = await readChatThread({ fetch, source, threadId });
    if (Result.isError(result) && result.error._tag === "SignedOutError") {
      end();
    }
    return { loadedAt: epochMilliseconds(), result };
  };
  const [load, setLoad] = useState(loadThread);
  const [refreshing, startRefresh] = useTransition();
  const reload = () => {
    startRefresh(() => {
      setLoad(loadThread());
    });
  };

  return (
    <Suspense
      fallback={<ActivityIndicator color={colors.accent} style={styles.fill} />}
    >
      <LoadedThread
        load={load}
        onReload={reload}
        refreshing={refreshing}
        source={source}
        threadId={threadId}
      />
    </Suspense>
  );
};

const LoadedThread = ({
  load,
  onReload,
  refreshing,
  source,
  threadId,
}: {
  load: Promise<Load<ChatMessagesPage>>;
  onReload: () => void;
  refreshing: boolean;
  source: AccessTokenSource;
  threadId: string;
}) => {
  const t = useTranslations("chat");
  const { loadedAt, result } = use(load);

  if (Result.isError(result)) {
    // The session provider is already returning to sign-in.
    return result.error._tag === "SignedOutError" ? null : (
      <View style={styles.padded}>
        <EmptyCard description={t("threadLoadFailed")} title={t("threadTitle")}>
          <RetryButton label={t("retry")} onPress={onReload} />
        </EmptyCard>
      </View>
    );
  }

  return (
    <ThreadMessages
      firstPage={result.value}
      // A refresh starts over from the thread's newest page.
      key={loadedAt}
      onReload={onReload}
      refreshing={refreshing}
      source={source}
      threadId={threadId}
    />
  );
};

/**
 * The thread newest at the bottom, as a chat reads. The list is inverted so
 * it opens on the latest message; scrolling up past the oldest loaded one
 * fetches the page before it.
 */
const ThreadMessages = ({
  firstPage,
  onReload,
  refreshing,
  source,
  threadId,
}: {
  firstPage: ChatMessagesPage;
  onReload: () => void;
  refreshing: boolean;
  source: AccessTokenSource;
  threadId: string;
}) => {
  const t = useTranslations("chat");
  const colors = useAppColors();
  const { end } = useSession();
  const [entries, setEntries] = useState(firstPage.entries);
  const [cursor, setCursor] = useState(firstPage.olderCursor);
  const [older, setOlder] = useState<PagingState>("idle");

  const loadOlder = async () => {
    if (cursor === null || older === "loading") {
      return;
    }
    setOlder("loading");
    const page = await readOlderChatMessages({
      before: cursor,
      fetch,
      source,
      threadId,
    });
    if (Result.isOk(page)) {
      setEntries((loaded) => prependOlderPage(loaded, page.value.entries));
      setCursor(page.value.olderCursor);
      setOlder("idle");
      return;
    }
    if (page.error._tag === "SignedOutError") {
      end();
      return;
    }
    setOlder("failed");
  };

  return (
    <FlatList
      contentContainerStyle={styles.content}
      data={entries.toReversed()}
      inverted
      keyExtractor={(entry) => entry.id}
      ListEmptyComponent={
        <EmptyCard
          description={t("threadEmptyDescription")}
          title={t("threadTitle")}
        />
      }
      // Inverted, the footer sits above the oldest message.
      ListFooterComponent={
        <PagingFooter
          label={t("loadOlderFailed")}
          onRetry={() => {
            void loadOlder();
          }}
          state={older}
        />
      }
      onEndReached={() => {
        void loadOlder();
      }}
      onEndReachedThreshold={0.5}
      refreshControl={
        <RefreshControl
          onRefresh={onReload}
          refreshing={refreshing}
          tintColor={colors.muted}
        />
      }
      renderItem={({ item }) => <ChatMessage entry={item} />}
    />
  );
};

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    gap: 16,
    padding: 16,
  },
  fill: {
    flex: 1,
  },
  padded: {
    flex: 1,
    padding: 20,
  },
});
