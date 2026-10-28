import { use, useState } from "react";

import { Result } from "better-result";
import { RefreshControl, SectionList, StyleSheet, Text } from "react-native";
import { useTimeZone, useTranslations } from "use-intl";

import { ChatThreadRow } from "@/components/chat-thread-row";
import { EmptyCard, screenStyles } from "@/components/empty-state-screen";
import { PagingFooter, RetryButton } from "@/components/retry-button";
import type { PagingState } from "@/components/retry-button";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import type { Load } from "@/state/api-request";
import {
  appendThreadsPage,
  listChatThreads,
  sectionThreads,
} from "@/state/chat-threads";
import type { ChatThreadsPage } from "@/state/chat-threads";
import { useAppColors } from "@/theme";

/** The first page of threads, or why it could not load, with pull-to-refresh either way. */
export const LoadedChats = ({
  load,
  onReload,
  refreshing,
  search,
  source,
}: {
  load: Promise<Load<ChatThreadsPage>>;
  onReload: () => void;
  refreshing: boolean;
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
      firstPage={Result.isOk(result) ? result.value : undefined}
      // A refresh starts the timeline over from its new first page.
      key={loadedAt}
      loadedAt={loadedAt}
      onReload={onReload}
      refreshing={refreshing}
      search={search}
      source={source}
    />
  );
};

const ThreadTimeline = ({
  firstPage,
  loadedAt,
  onReload,
  refreshing,
  search,
  source,
}: {
  firstPage: ChatThreadsPage | undefined;
  loadedAt: number;
  onReload: () => void;
  refreshing: boolean;
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

  return (
    <SectionList
      contentContainerStyle={[screenStyles.content, styles.content]}
      // A chat found by a search opens on the first tap, the keyboard up.
      keyboardShouldPersistTaps="handled"
      keyExtractor={(thread) => thread.id}
      ListEmptyComponent={
        firstPage === undefined ? (
          <EmptyCard description={t("loadFailed")} title={t("emptyTitle")}>
            <RetryButton label={t("retry")} onPress={onReload} />
          </EmptyCard>
        ) : (
          <NoThreads search={search.trim()} />
        )
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
      renderItem={({ item, section }) => (
        <ChatThreadRow section={section.key} thread={item} />
      )}
      renderSectionHeader={({ section }) => (
        <Text style={[styles.sectionHeader, { color: colors.muted }]}>
          {t(`sections.${section.key}`)}
        </Text>
      )}
      sections={sectionThreads(threads, loadedAt, timeZone)}
      stickySectionHeadersEnabled={false}
    />
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

const styles = StyleSheet.create({
  // The screen's heading sits above the list, already padded.
  content: {
    paddingTop: 20,
  },
  sectionHeader: {
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.4,
    marginBottom: 8,
    textTransform: "uppercase",
  },
});
