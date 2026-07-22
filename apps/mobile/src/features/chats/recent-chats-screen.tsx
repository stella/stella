import { useInfiniteQuery } from "@tanstack/react-query";
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { ActionButton } from "@/components/action-button";
import { useActiveOrganizationId } from "@/features/auth/auth-session-boundary";
import { useAppColors } from "@/theme";

import { formatRecentChatDate } from "./recent-chat-date";
import {
  mergeRecentChatThreadPages,
  type RecentChatThread,
} from "./recent-chat-threads";
import { recentChatThreadsOptions } from "./recent-chat-threads-query";

export const RecentChatsScreen = () => {
  const activeOrganizationId = useActiveOrganizationId();
  const colors = useAppColors();
  const query = useInfiniteQuery(
    recentChatThreadsOptions(activeOrganizationId),
  );
  const threads = mergeRecentChatThreadPages(query.data?.pages);

  let emptyState: EmptyState;
  if (query.isPending) {
    emptyState = { type: "loading" };
  } else if (query.isError) {
    emptyState = {
      onRetry: () => {
        query.refetch().catch(() => undefined);
      },
      type: "error",
    };
  } else {
    emptyState = { type: "empty" };
  }

  let paginationState: PaginationState = { type: "idle" };
  if (query.isFetchingNextPage) {
    paginationState = { type: "loading" };
  } else if (query.isFetchNextPageError) {
    paginationState = {
      onRetry: () => {
        query.fetchNextPage().catch(() => undefined);
      },
      type: "error",
    };
  }

  return (
    <FlatList
      contentContainerStyle={[
        styles.content,
        threads.length === 0 ? styles.emptyContent : null,
      ]}
      contentInsetAdjustmentBehavior="automatic"
      data={threads}
      keyExtractor={(thread) => thread.id}
      ListEmptyComponent={<RecentChatsEmptyState state={emptyState} />}
      ListFooterComponent={<PaginationFooter state={paginationState} />}
      ListHeaderComponent={
        threads.length > 0 ? (
          <ListHeader refreshFailed={query.isRefetchError} />
        ) : null
      }
      onEndReached={() => {
        if (query.hasNextPage && !query.isFetchingNextPage) {
          query.fetchNextPage().catch(() => undefined);
        }
      }}
      onEndReachedThreshold={0.4}
      onRefresh={() => {
        query.refetch().catch(() => undefined);
      }}
      refreshing={query.isRefetching && !query.isFetchingNextPage}
      renderItem={({ item }) => <RecentChatRow thread={item} />}
      style={{ backgroundColor: colors.background }}
    />
  );
};

type EmptyState =
  | { type: "loading" }
  | { onRetry: () => void; type: "error" }
  | { type: "empty" };

const RecentChatsEmptyState = ({ state }: { state: EmptyState }) => {
  const colors = useAppColors();

  if (state.type === "loading") {
    return (
      <View style={styles.emptyState}>
        <ActivityIndicator accessibilityLabel="Loading conversations" />
        <Text style={[styles.emptyDescription, { color: colors.muted }]}>
          Loading recent conversations…
        </Text>
      </View>
    );
  }

  if (state.type === "error") {
    return (
      <View style={styles.emptyState}>
        <Text style={[styles.emptyTitle, { color: colors.text }]}>
          Conversations unavailable
        </Text>
        <Text style={[styles.emptyDescription, { color: colors.muted }]}>
          Check your connection and try again.
        </Text>
        <View style={styles.retryButton}>
          <ActionButton
            label="Retry"
            onPress={state.onRetry}
            variant="secondary"
          />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.emptyState}>
      <Text style={[styles.emptyTitle, { color: colors.text }]}>
        No conversations yet
      </Text>
      <Text style={[styles.emptyDescription, { color: colors.muted }]}>
        Conversations started on the web will appear here.
      </Text>
    </View>
  );
};

const ListHeader = ({ refreshFailed }: { refreshFailed: boolean }) => {
  const colors = useAppColors();

  return (
    <View style={styles.listHeader}>
      <Text style={[styles.description, { color: colors.muted }]}>
        Continue your most recently updated conversations.
      </Text>
      {refreshFailed ? (
        <View
          style={[
            styles.refreshError,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <Text selectable style={{ color: colors.danger }}>
            Could not refresh. Showing saved conversations.
          </Text>
        </View>
      ) : null}
    </View>
  );
};

const RecentChatRow = ({ thread }: { thread: RecentChatThread }) => {
  const colors = useAppColors();
  const context = thread.scope === "global" ? "General" : thread.workspaceName;

  return (
    <View
      style={[
        styles.row,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <View style={styles.metadata}>
        <Text
          numberOfLines={1}
          style={[styles.context, { color: colors.muted }]}
        >
          {context}
        </Text>
        <Text style={[styles.date, { color: colors.muted }]}>
          {formatRecentChatDate(thread.updatedAt)}
        </Text>
      </View>
      <Text
        numberOfLines={2}
        selectable
        style={[styles.title, { color: colors.text }]}
      >
        {thread.title.trim() || "Untitled conversation"}
      </Text>
    </View>
  );
};

type PaginationState =
  | { type: "idle" }
  | { type: "loading" }
  | { onRetry: () => void; type: "error" };

const PaginationFooter = ({ state }: { state: PaginationState }) => {
  const colors = useAppColors();

  if (state.type === "idle") {
    return null;
  }
  if (state.type === "loading") {
    return (
      <View style={styles.paginationFooter}>
        <ActivityIndicator accessibilityLabel="Loading more conversations" />
      </View>
    );
  }
  return (
    <View style={styles.paginationFooter}>
      <Text style={[styles.paginationError, { color: colors.danger }]}>
        More conversations could not be loaded.
      </Text>
      <View style={styles.retryButton}>
        <ActionButton
          label="Try again"
          onPress={state.onRetry}
          variant="secondary"
        />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  content: {
    gap: 12,
    paddingBottom: 32,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  context: {
    flex: 1,
    fontSize: 13,
    fontWeight: "600",
  },
  date: {
    fontSize: 13,
  },
  description: {
    fontSize: 16,
    lineHeight: 23,
  },
  emptyContent: {
    flexGrow: 1,
  },
  emptyDescription: {
    fontSize: 15,
    lineHeight: 22,
    maxWidth: 320,
    textAlign: "center",
  },
  emptyState: {
    alignItems: "center",
    flex: 1,
    gap: 12,
    justifyContent: "center",
    padding: 24,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: "600",
  },
  listHeader: {
    gap: 12,
    marginBottom: 4,
  },
  metadata: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
  },
  paginationError: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  paginationFooter: {
    alignItems: "center",
    gap: 10,
    minHeight: 72,
    paddingVertical: 14,
  },
  refreshError: {
    borderCurve: "continuous",
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
  },
  retryButton: {
    minWidth: 160,
  },
  row: {
    borderCurve: "continuous",
    borderRadius: 16,
    borderWidth: 1,
    gap: 8,
    padding: 16,
  },
  title: {
    fontSize: 17,
    fontWeight: "600",
    lineHeight: 23,
  },
});
