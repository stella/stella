import { use } from "react";

import {
  ActivityIndicator,
  RefreshControl,
  SectionList,
  View,
} from "react-native";
import { useTimeZone, useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Text } from "@stll/ui/text";

import { EmptyCard, emptyListProps } from "@/components/empty-state-screen";
import { useHeaderSearch } from "@/components/header-search";
import { LoadFailedCard } from "@/components/load-failure";
import { RoleFailureNotice } from "@/components/role";
import { TaskRow } from "@/components/task-row";
import type { AccessTokenSource } from "@/connection/session";
import { dayAt, groupByDue } from "@/state/tasks";
import type { TasksLoad, TaskSummary, TasksView } from "@/state/tasks";
import { useAppColors } from "@/theme";

/**
 * The tasks a load returned, under when they fall due, or why they could
 * not load, with pull-to-refresh either way and the next page at the end.
 * The header's search filters them by name or matter.
 */
export const LoadedTasks = ({
  load,
  loadingMore,
  onLoadMore,
  onReload,
  refreshing,
  showMatter,
  source,
  view,
}: {
  load: Promise<TasksLoad>;
  loadingMore: boolean;
  onLoadMore: (current: TasksLoad) => void;
  onReload: () => void;
  refreshing: boolean;
  showMatter: boolean;
  source: AccessTokenSource;
  view: TasksView;
}) => {
  const t = useTranslations("tasks");
  const { query } = useHeaderSearch();
  const colors = useAppColors();
  const timeZone = useTimeZone() ?? "UTC";
  const current = use(load);

  // The session provider is already returning to sign-in.
  if (current.error?._tag === "SignedOutError") {
    return null;
  }

  const tasks = matching(current.tasks, query);
  // The tab's first view keeps its own words; any other names what it shows.
  const mineOpen =
    view.whose === "mine" &&
    view.show === "open" &&
    view.matterId === undefined;
  const empty =
    current.tasks.length === 0 && current.error !== null ? (
      <LoadFailedCard
        error={current.error}
        onRetry={onReload}
        retryLabel={t("retry")}
        title={t("loadFailed")}
      />
    ) : (
      <EmptyCard
        description={
          mineOpen ? t("emptyDescription") : t("emptyFilteredDescription")
        }
        title={mineOpen ? t("emptyTitle") : t("emptyFilteredTitle")}
      />
    );

  const footer = (() => {
    if (current.tasks.length === 0) {
      return null;
    }
    if (loadingMore) {
      return <ActivityIndicator className="py-6" color={colors.muted} />;
    }
    if (current.error !== null) {
      return (
        <View className="items-center gap-2 py-6">
          <Text variant="caption">{t("loadMoreFailed")}</Text>
          <Button
            onPress={() => {
              onLoadMore(current);
            }}
            size="sm"
            variant="outline"
          >
            {t("retry")}
          </Button>
        </View>
      );
    }
    return current.nextCursor === null ? null : (
      <View className="items-center py-6">
        <Button
          onPress={() => {
            onLoadMore(current);
          }}
          size="sm"
          variant="outline"
        >
          {t("loadMore")}
        </Button>
      </View>
    );
  })();

  return (
    <SectionList
      {...emptyListProps(tasks.length === 0)}
      // The header is the platform's translucent bar; the list scrolls under it.
      contentInsetAdjustmentBehavior="automatic"
      keyExtractor={(task) => task.id}
      ListEmptyComponent={empty}
      // Why a role that could not be read offers no changes here.
      ListHeaderComponent={<RoleFailureNotice />}
      ListFooterComponent={footer ?? undefined}
      refreshControl={
        <RefreshControl
          onRefresh={onReload}
          refreshing={refreshing}
          tintColor={colors.muted}
        />
      }
      renderItem={({ item, section }) => (
        <TaskRow
          overdue={section.due === "overdue"}
          showMatter={showMatter}
          source={source}
          task={item}
        />
      )}
      renderSectionHeader={({ section }) => (
        <View className="pt-6 pb-1">
          <Text variant="headline">{t(`due.${section.due}`)}</Text>
        </View>
      )}
      sections={groupByDue(tasks, dayAt(current.loadedAt, timeZone))}
      stickySectionHeadersEnabled={false}
    />
  );
};

/** The tasks whose name, matter or matter reference contains what was searched for. */
function matching(
  tasks: readonly TaskSummary[],
  query: string,
): readonly TaskSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") {
    return tasks;
  }
  return tasks.filter((task) =>
    [task.name, task.matterName, task.matterReference].some(
      (field) => field?.toLocaleLowerCase().includes(needle) === true,
    ),
  );
}
