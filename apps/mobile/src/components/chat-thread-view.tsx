import { Suspense, use, useState, useTransition } from "react";

import { Result } from "better-result";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useTranslations } from "use-intl";

import { ChatComposer } from "@/components/chat-composer";
import { ChatMessage } from "@/components/chat-message";
import { EmptyCard } from "@/components/empty-state-screen";
import { PagingFooter, RetryButton } from "@/components/retry-button";
import type { PagingState } from "@/components/retry-button";
import { useChatTurn } from "@/components/use-chat-turn";
import type { LiveTurn } from "@/components/use-chat-turn";
import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import type { Load } from "@/state/api-request";
import {
  prependOlderPage,
  readChatThread,
  readOlderChatMessages,
} from "@/state/chat-messages";
import type { ChatEntry, ChatMessagesPage } from "@/state/chat-messages";
import { answerEntry } from "@/state/chat-stream";
import { useAppColors } from "@/theme";

const EMPTY_PAGE: ChatMessagesPage = {
  entries: [],
  olderCursor: null,
  activeTurnId: null,
};

/**
 * Loads one thread's latest messages, and again on every pull to refresh. A
 * `fresh` thread is one this phone just named; the server creates it with
 * its first message, so there is nothing to load yet.
 */
export const ChatThreadView = ({
  fresh,
  matterId,
  source,
  threadId,
}: {
  fresh: boolean;
  /** The thread's matter; the server refuses a matter's thread read without it. */
  matterId: string | undefined;
  source: AccessTokenSource;
  threadId: string;
}) => {
  const colors = useAppColors();
  const { end } = useSession();
  const loadThread = async (): Promise<Load<ChatMessagesPage>> => {
    const result = await readChatThread({ fetch, matterId, source, threadId });
    if (Result.isError(result) && result.error._tag === "SignedOutError") {
      end();
    }
    return { loadedAt: epochMilliseconds(), result };
  };
  const [load, setLoad] = useState(async (): Promise<Load<ChatMessagesPage>> =>
    fresh
      ? { loadedAt: epochMilliseconds(), result: Result.ok(EMPTY_PAGE) }
      : await loadThread(),
  );
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
        matterId={matterId}
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
  matterId,
  onReload,
  refreshing,
  source,
  threadId,
}: {
  load: Promise<Load<ChatMessagesPage>>;
  matterId: string | undefined;
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
      matterId={matterId}
      onReload={onReload}
      refreshing={refreshing}
      source={source}
      threadId={threadId}
    />
  );
};

/**
 * The thread newest at the bottom, as a chat reads, with the message box
 * under it. The list is inverted so it opens on the latest message;
 * scrolling up past the oldest loaded one fetches the page before it. A turn
 * answering now sits after the stored messages until it is over and the
 * stored thread is loaded again in its place.
 */
const ThreadMessages = ({
  firstPage,
  matterId,
  onReload,
  refreshing,
  source,
  threadId,
}: {
  firstPage: ChatMessagesPage;
  matterId: string | undefined;
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
  const turn = useChatTurn({
    activeTurnId: firstPage.activeTurnId,
    onSettled: async () => {
      const latest = await readChatThread({ fetch, source, threadId });
      if (Result.isOk(latest)) {
        setEntries((loaded) => prependOlderPage(latest.value.entries, loaded));
        return true;
      }
      if (latest.error._tag === "SignedOutError") {
        end();
      }
      // Otherwise the answer stays as it streamed until the next refresh.
      return false;
    },
    source,
    threadId,
  });
  const { live } = turn;
  const shown = entries.filter(
    (entry) =>
      entry.id !== live?.answer.messageId && entry.id !== live?.question?.id,
  );

  const loadOlder = async () => {
    if (cursor === null || older === "loading") {
      return;
    }
    setOlder("loading");
    const page = await readOlderChatMessages({
      before: cursor,
      fetch,
      matterId,
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
    <View style={styles.fill}>
      <FlatList
        contentContainerStyle={styles.content}
        data={[...shown].reverse()}
        inverted
        keyExtractor={(entry) => entry.id}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          live === null ? (
            <EmptyCard
              description={t("threadEmptyDescription")}
              title={t("threadTitle")}
            />
          ) : null
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
        // And the header below the newest.
        ListHeaderComponent={
          live === null ? null : <LiveTurnView turn={live} />
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
      {turn.sendFailed ? (
        <Text style={[styles.notice, { color: colors.muted }]}>
          {t("sendFailed")}
        </Text>
      ) : null}
      <ChatComposer
        busy={turn.busy}
        canStop={turn.canStop}
        onSend={turn.send}
        onStop={turn.stop}
      />
    </View>
  );
};

/** The turn answering now: the message sent from here, and the answer as it arrives. */
const LiveTurnView = ({ turn }: { turn: LiveTurn }) => {
  const colors = useAppColors();
  const t = useTranslations("chat");
  const answer: ChatEntry = answerEntry(turn.answer, turn.startedAt);
  const { status } = turn.answer;
  const note = {
    streaming: undefined,
    finished: undefined,
    stopped: t("answerStopped"),
    "needs-input": t("answerNeedsInput"),
    failed: t("answerFailed"),
  }[status];

  return (
    <View style={styles.live}>
      {turn.question === undefined ? null : (
        <ChatMessage entry={turn.question} />
      )}
      {answer.text === "" && answer.tools.length === 0 ? null : (
        <ChatMessage entry={answer} />
      )}
      {status === "streaming" ? (
        <View style={styles.working}>
          <ActivityIndicator color={colors.muted} size="small" />
          <Text style={[styles.notice, { color: colors.muted }]}>
            {t("answerWorking")}
          </Text>
        </View>
      ) : null}
      {note === undefined ? null : (
        <Text style={[styles.notice, { color: colors.muted }]}>{note}</Text>
      )}
    </View>
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
  live: {
    gap: 16,
  },
  notice: {
    fontSize: 13,
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  padded: {
    flex: 1,
    padding: 20,
  },
  working: {
    alignItems: "center",
    flexDirection: "row",
    gap: 4,
  },
});
