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

import { StellaMark } from "@stll/ui/stella-mark";
import { Text } from "@stll/ui/text";

import { ChatComposer } from "@/components/chat-composer";
import { ChatDraftDocuments } from "@/components/chat-draft-document";
import { ChatInputCard } from "@/components/chat-input-card";
import type { InputNotice } from "@/components/chat-input-card";
import { ChatMessage } from "@/components/chat-message";
import { EmptyCard, screenStyles } from "@/components/empty-state-screen";
import { PagingFooter, RetryButton } from "@/components/retry-button";
import type { PagingState } from "@/components/retry-button";
import { ThreadMatter } from "@/components/thread-matter";
import { useChatTurn } from "@/components/use-chat-turn";
import type { LiveTurn } from "@/components/use-chat-turn";
import { useMarkChatReadWhileOpen } from "@/components/use-mark-chat-read";
import { WriteFailureNotice } from "@/components/write-failure";
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
import {
  isSamePendingInput,
  showsPendingInput,
} from "@/state/chat-pending-input";
import type { PendingAnswer } from "@/state/chat-pending-input";
import { answerEntry } from "@/state/chat-stream";
import { useAppColors } from "@/theme";

const EMPTY_PAGE: ChatMessagesPage = {
  entries: [],
  olderCursor: null,
  activeTurnId: null,
  usedAnonymization: false,
  pendingInput: null,
};

/**
 * Loads one thread's latest messages, and again on every pull to refresh. A
 * `fresh` thread is one this phone just named; the server creates it with
 * its first message, so there is nothing to load yet.
 */
export const ChatThreadView = ({
  fresh,
  matterId,
  shareId,
  source,
  threadId,
}: {
  fresh: boolean;
  /** The thread's matter; the server refuses a matter's thread read without it. */
  matterId: string | undefined;
  /** A share from another app a new conversation starts with. */
  shareId: string | undefined;
  source: AccessTokenSource;
  threadId: string;
}) => {
  const colors = useAppColors();
  const { end } = useSession();
  const loadThread = async (): Promise<Load<ChatMessagesPage>> => {
    const result = await readChatThread({ fetch, matterId, source, threadId });
    if (Result.isError(result) && result.error._tag === "SignedOutError") {
      end(source);
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
    <ThreadMatter value={matterId}>
      <Suspense
        fallback={
          <ActivityIndicator color={colors.accent} style={styles.fill} />
        }
      >
        <LoadedThread
          load={load}
          matterId={matterId}
          onReload={reload}
          refreshing={refreshing}
          shareId={shareId}
          source={source}
          threadId={threadId}
        />
      </Suspense>
    </ThreadMatter>
  );
};

const LoadedThread = ({
  load,
  matterId,
  onReload,
  refreshing,
  shareId,
  source,
  threadId,
}: {
  load: Promise<Load<ChatMessagesPage>>;
  matterId: string | undefined;
  onReload: () => void;
  refreshing: boolean;
  shareId: string | undefined;
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
      shareId={shareId}
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
 * stored thread is loaded again in its place. A turn that waits for the
 * person ends the thread with what it waits for, answered right there.
 */
const ThreadMessages = ({
  firstPage,
  matterId,
  onReload,
  refreshing,
  shareId,
  source,
  threadId,
}: {
  firstPage: ChatMessagesPage;
  matterId: string | undefined;
  onReload: () => void;
  refreshing: boolean;
  shareId: string | undefined;
  source: AccessTokenSource;
  threadId: string;
}) => {
  const t = useTranslations("chat");
  const colors = useAppColors();
  const { end } = useSession();
  const [entries, setEntries] = useState(firstPage.entries);
  const [cursor, setCursor] = useState(firstPage.olderCursor);
  const [older, setOlder] = useState<PagingState>("idle");
  const [anonymized, setAnonymized] = useState(firstPage.usedAnonymization);
  const [pending, setPending] = useState(firstPage.pendingInput);
  const [inputNotice, setInputNotice] = useState<InputNotice>();
  const turn = useChatTurn({
    activeTurnId: firstPage.activeTurnId,
    anonymized,
    matterId,
    onSettled: async () => {
      const latest = await readChatThread({
        fetch,
        matterId,
        source,
        threadId,
      });
      if (Result.isOk(latest)) {
        setEntries((loaded) => prependOlderPage(latest.value.entries, loaded));
        setAnonymized(latest.value.usedAnonymization);
        setPending(latest.value.pendingInput);
        setInputNotice(undefined);
        return true;
      }
      if (latest.error._tag === "SignedOutError") {
        end(source);
      }
      // Otherwise the answer stays as it streamed until the next refresh.
      return false;
    },
    source,
    threadId,
  });
  const { live } = turn;
  const markFailure = useMarkChatReadWhileOpen({
    answer: live?.answer.status === "streaming" ? "streaming" : "settled",
    matterId,
    revision: entries.at(-1)?.id ?? null,
    source,
    threadId,
  });
  // A turn that resumes a paused message adds to it, so the stored message
  // stays; any other live turn stands in for its stored copy.
  const shown = entries.filter(
    (entry) =>
      entry.id === live?.continues ||
      (entry.id !== live?.answer.messageId && entry.id !== live?.question?.id),
  );

  /**
   * Answers what the paused turn waits for. When the server does not take
   * the answer, the thread is read again: a turn answered elsewhere no
   * longer waits for this one, and the run that answer started is followed;
   * a turn still waiting keeps its card, which says the answer failed.
   */
  const answer = (reply: PendingAnswer) => {
    if (pending === null || pending.type === "elsewhere") {
      return;
    }
    const asked = pending;
    setInputNotice(undefined);
    turn.answer(asked, reply, {
      onAccepted: () => {
        setPending(null);
      },
      onRefused: () => {
        void (async () => {
          const latest = await readChatThread({
            fetch,
            matterId,
            source,
            threadId,
          });
          if (Result.isError(latest)) {
            if (latest.error._tag === "SignedOutError") {
              end(source);
              return;
            }
            setInputNotice("failed");
            return;
          }
          const { activeTurnId, entries: stored, pendingInput } = latest.value;
          setEntries((loaded) => prependOlderPage(stored, loaded));
          setAnonymized(latest.value.usedAnonymization);
          setPending(pendingInput);
          if (isSamePendingInput(asked, pendingInput)) {
            setInputNotice("failed");
            return;
          }
          setInputNotice("alreadyAnswered");
          if (activeTurnId !== null) {
            turn.follow(activeTurnId, asked.messageId);
          }
        })();
      },
    });
  };

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
      end(source);
      return;
    }
    setOlder("failed");
  };

  // A conversation with nothing in it yet is the web's new chat: the mark,
  // the greeting and the message box together, centred, not a card over a
  // box at the bottom.
  if (shown.length === 0 && live === null && cursor === null) {
    return (
      <View style={styles.fill}>
        <View style={[screenStyles.readable, styles.landing]}>
          <View style={styles.greeting}>
            <StellaMark size={28} />
            <Text className="text-center" variant="title">
              {t("greeting")}
            </Text>
            <Text className="text-center" variant="caption">
              {t("greetingSubtitle")}
            </Text>
          </View>
          {/* The composer says why a send was refused, as in a thread. A
              share starts only an empty conversation, so only this one
              takes it. */}
          <ChatComposer
            busy={turn.busy}
            canStop={turn.canStop}
            onSend={turn.send}
            onStop={turn.stop}
            sendError={turn.sendError}
            shareId={shareId}
          />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.fill}>
      <FlatList
        contentContainerStyle={styles.content}
        data={[...shown].reverse()}
        inverted
        keyExtractor={(entry) => entry.id}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
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
          <View style={styles.live}>
            {live === null ? null : (
              <LiveTurnView accepted={turn.canStop} turn={live} />
            )}
            {showsPendingInput(
              live === null
                ? null
                : {
                    streaming: live.answer.status === "streaming",
                    continues: live.continues,
                  },
            ) ? (
              <ChatInputCard
                busy={turn.busy}
                notice={inputNotice}
                onAnswer={answer}
                pending={pending}
                source={source}
                threadId={threadId}
              />
            ) : null}
          </View>
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
        renderItem={({ item }) =>
          item.drafts.length === 0 ? (
            <ChatMessage entry={item} />
          ) : (
            // The drafts the answer wrote follow it, each opening its pages.
            <View style={styles.live}>
              <ChatMessage entry={item} />
              <ChatDraftDocuments drafts={item.drafts} />
            </View>
          )
        }
      />
      <View style={screenStyles.readable}>
        {markFailure === null ? null : (
          <View style={styles.markFailure}>
            <WriteFailureNotice
              failure={markFailure}
              message={t("markReadFailed")}
            />
          </View>
        )}
        <ChatComposer
          busy={turn.busy}
          canStop={turn.canStop}
          onSend={turn.send}
          onStop={turn.stop}
          sendError={turn.sendError}
          shareId={undefined}
        />
      </View>
    </View>
  );
};

/**
 * The turn answering now: the message sent from here, and the answer as it
 * arrives. Until the server has `accepted` the message, its files are still
 * going up.
 */
const LiveTurnView = ({
  accepted,
  turn,
}: {
  accepted: boolean;
  turn: LiveTurn;
}) => {
  const colors = useAppColors();
  const t = useTranslations("chat");
  const answer: ChatEntry = answerEntry(turn.answer, turn.startedAt);
  const { status } = turn.answer;
  const note = {
    streaming: undefined,
    finished: undefined,
    stopped: t("answerStopped"),
    // The stored thread is read next, and says what the turn waits for.
    "needs-input": t("answerAwaitingInput"),
    failed: t("answerFailed"),
  }[status];
  const uploading =
    !accepted &&
    status === "streaming" &&
    (turn.question?.files.length ?? 0) > 0;

  return (
    <View style={styles.live}>
      {turn.question === undefined ? null : (
        <ChatMessage entry={turn.question} uploading={uploading} />
      )}
      {answer.blocks.length === 0 ? null : (
        <ChatMessage entry={answer} live={status === "streaming"} />
      )}
      {status === "streaming" ? (
        <View style={styles.working}>
          <ActivityIndicator color={colors.muted} size="small" />
          <Text style={[styles.notice, { color: colors.muted }]}>
            {uploading ? t("attachmentUploading") : t("answerWorking")}
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
    ...screenStyles.readable,
    flexGrow: 1,
    gap: 16,
    padding: 16,
  },
  fill: {
    flex: 1,
  },
  greeting: {
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
  },
  landing: {
    flex: 1,
    gap: 24,
    justifyContent: "center",
  },
  live: {
    gap: 16,
  },
  markFailure: {
    paddingHorizontal: 16,
    paddingTop: 8,
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
