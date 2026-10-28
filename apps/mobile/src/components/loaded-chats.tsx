import { use, useState } from "react";

import { Result } from "better-result";
import { RefreshControl, SectionList, StyleSheet, Text } from "react-native";
import { useTimeZone, useTranslations } from "use-intl";

import { ChatThreadRow } from "@/components/chat-thread-row";
import {
  EmptyCard,
  ScreenHeading,
  screenStyles,
} from "@/components/empty-state-screen";
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
  source,
}: {
  load: Promise<Load<ChatThreadsPage>>;
  onReload: () => void;
  refreshing: boolean;
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
      source={source}
    />
  );
};

const ThreadTimeline = ({
  firstPage,
  loadedAt,
  onReload,
  refreshing,
  source,
}: {
  firstPage: ChatThreadsPage | undefined;
  loadedAt: number;
  onReload: () => void;
  refreshing: boolean;
  source: AccessTokenSource;
}) => {
  const t = useTranslations("chat");
  const tabs = useTranslations("tabs");
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
    const next = await listChatThreads({ cursor, fetch, source });
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
      contentContainerStyle={screenStyles.content}
      keyExtractor={(thread) => thread.id}
      ListEmptyComponent={
        firstPage === undefined ? (
          <EmptyCard description={t("loadFailed")} title={t("emptyTitle")}>
            <RetryButton label={t("retry")} onPress={onReload} />
          </EmptyCard>
        ) : (
          <EmptyCard
            description={t("emptyDescription")}
            title={t("emptyTitle")}
          />
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
      ListHeaderComponent={
        <ScreenHeading description={t("description")} title={tabs("chat")} />
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

const styles = StyleSheet.create({
  sectionHeader: {
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.4,
    marginBottom: 8,
    textTransform: "uppercase",
  },
});
