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
import {
  appendThreadsPage,
  listChatThreads,
  nextChatsPage,
} from "@/state/chat-threads";
import type {
  ChatListCursors,
  ChatListPage,
  ChatThreadSummary,
} from "@/state/chat-threads";
import { useAppColors } from "@/theme";

const NO_MORE_PAGES: ChatListCursors = { pinned: null, unpinned: null };

/** The threads one load has shown so far, and where it continues. */
type Timeline = {
  readonly loadedAt: number;
  readonly threads: readonly ChatThreadSummary[];
  readonly cursors: ChatListCursors;
  readonly more: PagingState;
};

/** One load of the chats list, with the text its threads match; later pages ask for it too. */
export type ChatsLoad = Load<ChatListPage> & { readonly search: string };

/** The first page of threads, or why it could not load, with pull-to-refresh either way. */
export const LoadedChats = ({
  load,
  onReload,
  onRetryRuns,
  refreshing,
  runs,
  source,
}: {
  load: Promise<ChatsLoad>;
  onReload: () => void;
  onRetryRuns: () => void;
  refreshing: boolean;
  /** The person's unfinished runs, which lift their chats to the top. */
  runs: ActiveRunsState;
  source: AccessTokenSource;
}) => {
  const { loadedAt, result, search } = use(load);

  // The session provider is already returning to sign-in.
  if (Result.isError(result) && result.error._tag === "SignedOutError") {
    return null;
  }

  return (
    <ThreadTimeline
      failure={Result.isError(result) ? result.error : undefined}
      firstPage={Result.isOk(result) ? result.value : undefined}
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
  firstPage: ChatListPage | undefined;
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
  // The pages read past the load's first ones belong to that load: a new
  // load, such as the one a chat marked here starts, shows from its own
  // first pages again, in place, so the list keeps its scroll.
  const [paged, setPaged] = useState<Timeline | null>(null);
  const timeline: Timeline =
    paged?.loadedAt === loadedAt
      ? paged
      : {
          cursors: firstPage?.cursors ?? NO_MORE_PAGES,
          loadedAt,
          more: "idle",
          threads: firstPage?.threads ?? [],
        };
  const { more, threads } = timeline;
  /** Changes this load's timeline; a newer load's is never overwritten by an older one's page. */
  const update = (change: (current: Timeline) => Timeline) => {
    setPaged((current) => {
      if (current !== null && current.loadedAt > loadedAt) {
        return current;
      }
      return change(current?.loadedAt === loadedAt ? current : timeline);
    });
  };

  const loadMore = async () => {
    const page = nextChatsPage(timeline.cursors);
    if (page === null || more === "loading") {
      return;
    }
    update((current) => ({ ...current, more: "loading" }));
    const next = await listChatThreads({
      cursor: page.cursor,
      fetch,
      pinState: page.pinState,
      search,
      source,
    });
    if (Result.isOk(next)) {
      update((current) => ({
        cursors: page.after(next.value.nextCursor),
        loadedAt: current.loadedAt,
        more: "idle",
        threads: appendThreadsPage(current.threads, next.value.threads),
      }));
      return;
    }
    if (next.error._tag === "SignedOutError") {
      end(source);
      return;
    }
    update((current) => ({ ...current, more: "failed" }));
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
      renderItem={({ item }) => <ChatThreadRow row={item} source={source} />}
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
