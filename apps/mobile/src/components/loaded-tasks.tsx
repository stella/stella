import { use } from "react";

import { Result } from "better-result";
import { RefreshControl, SectionList, View } from "react-native";
import { useTimeZone, useTranslations } from "use-intl";

import { Text } from "@stll/ui/text";

import { EmptyCard, screenStyles } from "@/components/empty-state-screen";
import { useHeaderSearch } from "@/components/header-search";
import { RetryButton } from "@/components/retry-button";
import { TaskRow } from "@/components/task-row";
import { dayAt, groupByDue } from "@/state/tasks";
import type { TasksLoad, TaskSummary } from "@/state/tasks";
import { useAppColors } from "@/theme";

/**
 * The open tasks a load returned, under when they fall due, or why they
 * could not load, with pull-to-refresh either way. The header's search
 * filters them by name or matter.
 */
export const LoadedTasks = ({
  load,
  onReload,
  refreshing,
}: {
  load: Promise<TasksLoad>;
  onReload: () => void;
  refreshing: boolean;
}) => {
  const t = useTranslations("tasks");
  const { query } = useHeaderSearch();
  const colors = useAppColors();
  const timeZone = useTimeZone() ?? "UTC";
  const { loadedAt, result } = use(load);

  // The session provider is already returning to sign-in.
  if (Result.isError(result) && result.error._tag === "SignedOutError") {
    return null;
  }

  const tasks = Result.isOk(result) ? matching(result.value, query) : [];
  const empty = Result.isOk(result) ? (
    <EmptyCard description={t("emptyDescription")} title={t("emptyTitle")} />
  ) : (
    <EmptyCard description={t("loadFailed")} title={t("emptyTitle")}>
      <RetryButton label={t("retry")} onPress={onReload} />
    </EmptyCard>
  );

  return (
    <SectionList
      contentContainerStyle={screenStyles.content}
      // The header is the platform's translucent bar; the list scrolls under it.
      contentInsetAdjustmentBehavior="automatic"
      keyExtractor={(task) => task.id}
      ListEmptyComponent={empty}
      refreshControl={
        <RefreshControl
          onRefresh={onReload}
          refreshing={refreshing}
          tintColor={colors.muted}
        />
      }
      renderItem={({ item, section }) => (
        <TaskRow overdue={section.due === "overdue"} task={item} />
      )}
      renderSectionHeader={({ section }) => (
        <View className="pt-6 pb-1">
          <Text variant="headline">{t(`due.${section.due}`)}</Text>
        </View>
      )}
      sections={groupByDue(tasks, dayAt(loadedAt, timeZone))}
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
