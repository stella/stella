import { use, useState } from "react";

import { Result } from "better-result";
import { RefreshControl, SectionList, View } from "react-native";
import { useTimeZone, useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Text } from "@stll/ui/text";

import { ChatThreadRow } from "@/components/chat-thread-row";
import { EmptyCard, emptyListProps } from "@/components/empty-state-screen";
import { LoadFailedCard } from "@/components/load-failure";
import { PagingFooter } from "@/components/retry-button";
import type { PagingState } from "@/components/retry-button";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import type { ApiError, Load } from "@/state/api-request";
import { inboxSections } from "@/state/chat-runs";
import type { ActiveRunsState } from "@/state/chat-runs";
import { appendThreadsPage, listChatThreads } from "@/state/chat-threads";
import type { ChatThreadsPage } from "@/state/chat-threads";
import { useAppColors } from "@/theme";

/** The first page of threads, or why it could not load, with pull-to-refresh either way. */
export const LoadedChats = ({
  load,
  onReload,
  onRetryRuns,
  refreshing,
  runs,
  search,
  source,
}: {
  load: Promise<Load<ChatThreadsPage>>;
  onReload: () => void;
  onRetryRuns: () => void;
  refreshing: boolean;
  /** The person's unfinished runs, which lift their chats to the top. */
  runs: ActiveRunsState;
  /** The text this load's threads match; later pages ask for it too. */
  search: string;
  source: AccessTokenSource;
}) => {
  const { loadedAt, result } = use(load);

  // The session provider is already returning to sign-in.
  if (Result.isError(result) && result.error._tag === "SignedOutError") {
    return null;
  }

  return (
    <ThreadTimeline
      failure={Result.isError(result) ? result.error : undefined}
      firstPage={Result.isOk(result) ? result.value : undefined}
      // A refresh starts the timeline over from its new first page.
      key={loadedAt}
      loadedAt={loadedAt}
      onReload={onReload}
      onRetryRuns={onRetryRuns}
      refreshing={refreshing}
      runs={runs}
      search={search}
      source={source}
    />
  );
};

const ThreadTimeline = ({
  failure,
  firstPage,
  loadedAt,
  onReload,
  onRetryRuns,
  refreshing,
  runs,
  search,
  source,
}: {
  failure: ApiError | undefined;
  firstPage: ChatThreadsPage | undefined;
  loadedAt: number;
  onReload: () => void;
  onRetryRuns: () => void;
  refreshing: boolean;
  runs: ActiveRunsState;
  search: string;
  source: AccessTokenSource;
}) => {
  const t = useTranslations("chat");
  const colors = useAppColors();
  const { end } = useSession();
  const timeZone = useTimeZone() ?? "UTC";
  const [threads, setThreads] = useState(firstPage?.threads ?? []);
  const [cursor, setCursor] = useState(firstPage?.nextCursor ?? null);
  const [more, setMore] = useState<PagingState>("idle");

  const loadMore = async () => {
    if (cursor === null || more === "loading") {
      return;
    }
    setMore("loading");
    const next = await listChatThreads({ cursor, fetch, search, source });
    if (Result.isOk(next)) {
      setThreads((loaded) => appendThreadsPage(loaded, next.value.threads));
      setCursor(next.value.nextCursor);
      setMore("idle");
      return;
    }
    if (next.error._tag === "SignedOutError") {
      end(source);
      return;
    }
    setMore("failed");
  };

  const sections = inboxSections({
    now: loadedAt,
    runs: runs.status === "loaded" ? runs.runs : [],
    searching: search.trim() !== "",
    threads,
    timeZone,
  });

  return (
    <SectionList
      {...emptyListProps(sections.length === 0)}
      // The header is the platform's translucent bar; the list scrolls under it.
      contentInsetAdjustmentBehavior="automatic"
      // A chat found by a search opens on the first tap, the keyboard up.
      keyboardShouldPersistTaps="handled"
      keyExtractor={({ thread }) => thread.id}
      ListEmptyComponent={
        failure === undefined ? (
          <NoThreads search={search.trim()} />
        ) : (
          <LoadFailedCard
            error={failure}
            onRetry={onReload}
            retryLabel={t("retry")}
            title={t("loadFailed")}
          />
        )
      }
      ListHeaderComponent={
        runs.status === "failed" && failure === undefined ? (
          <RunsFailedNotice onRetry={onRetryRuns} />
        ) : undefined
      }
      ListFooterComponent={
        <PagingFooter
          label={t("loadMoreFailed")}
          onRetry={() => {
            void loadMore();
          }}
          state={more}
        />
      }
      onEndReached={() => {
        void loadMore();
      }}
      onEndReachedThreshold={0.5}
      refreshControl={
        <RefreshControl
          onRefresh={onReload}
          refreshing={refreshing}
          tintColor={colors.muted}
        />
      }
      renderItem={({ item: { day, runState, thread } }) => (
        <ChatThreadRow day={day} runState={runState} thread={thread} />
      )}
      renderSectionHeader={({ section }) => (
        <View className="pt-4 pb-1">
          <Text variant="section">{t(`sections.${section.key}`)}</Text>
        </View>
      )}
      sections={sections}
      stickySectionHeadersEnabled={false}
    />
  );
};

/**
 * The runs could not be read, so the list cannot say which chats wait on
 * the person; it says so rather than looking as if none do.
 */
const RunsFailedNotice = ({ onRetry }: { onRetry: () => void }) => {
  const t = useTranslations("chat");
  return (
    <View className="flex-row items-center gap-3 pt-3">
      <View className="flex-1">
        <Text variant="caption">{t("runsLoadFailed")}</Text>
      </View>
      <Button onPress={onRetry} size="sm" variant="outline">
        {t("retry")}
      </Button>
    </View>
  );
};

/** Nothing yet, or nothing that matches what was searched for. */
const NoThreads = ({ search }: { search: string }) => {
  const t = useTranslations("chat");
  if (search === "") {
    return (
      <EmptyCard description={t("emptyDescription")} title={t("emptyTitle")} />
    );
  }
  return (
    <EmptyCard
      description={t("noMatchesDescription", { search })}
      title={t("noMatchesTitle")}
    />
  );
};
