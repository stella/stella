import { Link, useRouter } from "expo-router";
import { Pressable, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { TASK_STATUS } from "@stll/api-contract/entity-options";

import { useChanged } from "@/components/changes";
import { useLayout, useSelection } from "@/components/selection";
import { Text } from "@/components/ui/text";
import { useSession } from "@/connection/session-provider";
import { CircleIcon } from "@/icons.gen";
import { setTaskStatus } from "@/state/tasks";
import type { TaskSummary } from "@/state/tasks";
import { useUiColors } from "@/theme";

/**
 * One open task: its name, then its matter and the day it is due, the day
 * in the destructive colour once it has passed. Tapping it opens the task
 * over its matter, as a matter's own list does, or beside the list where
 * the window has two columns. Holding it offers what is done most without
 * opening it: mark it done, or open its matter.
 */
export const TaskRow = ({
  overdue,
  task,
}: {
  overdue: boolean;
  task: TaskSummary;
}) => {
  const t = useTranslations("tasks");
  const matter = useTranslations("matter");
  const format = useFormatter();
  const router = useRouter();
  const layout = useLayout();
  const { state } = useSession();
  const changed = useChanged();
  const selection = useSelection();
  const open = layout.usesSplitView && selection.task?.entityId === task.id;
  const ui = useUiColors();
  const due =
    task.dueDate === null || task.dueDate === undefined
      ? undefined
      : t("dueOn", {
          // A calendar day: read at noon so no time zone moves it.
          day: format.dateTime(new Date(`${task.dueDate}T12:00:00`), {
            day: "numeric",
            month: "short",
          }),
        });

  return (
    <Link
      asChild
      href={{
        pathname: "/matter/[workspaceId]/[entityId]",
        params: { entityId: task.id, workspaceId: task.matterId },
      }}
      onPress={(event) => {
        if (layout.usesSplitView) {
          event.preventDefault();
          selection.select("task", {
            entityId: task.id,
            workspaceId: task.matterId,
          });
        }
      }}
    >
      <Link.Trigger>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: open }}
          className={`border-border active:bg-accent flex-row gap-3 border-b py-3 ${open ? "bg-accent" : ""}`}
        >
          <View className="pt-0.5">
            <CircleIcon color={ui.mutedForeground} size={18} />
          </View>
          <View className="flex-1 gap-0.5">
            <Text numberOfLines={2} variant="rowTitle">
              {task.name === null || task.name === undefined || task.name === ""
                ? matter("untitled")
                : task.name}
            </Text>
            <Text numberOfLines={1} variant="caption">
              {task.matterName}
              {due === undefined ? null : (
                <>
                  {" · "}
                  <Text
                    style={
                      overdue ? { color: ui.destructiveForeground } : undefined
                    }
                    variant="caption"
                  >
                    {due}
                  </Text>
                </>
              )}
            </Text>
          </View>
        </Pressable>
      </Link.Trigger>
      <Link.Menu>
        <Link.MenuAction
          icon="checkmark.circle"
          onPress={() => {
            if (state.status !== "signed-in") {
              return;
            }
            void (async () => {
              const saved = await setTaskStatus({
                fetch,
                matterId: task.matterId,
                source: state.source,
                status: TASK_STATUS.DONE,
                taskId: task.id,
              });
              if (saved.isOk()) {
                changed("tasks");
              }
            })();
          }}
          title={t("markDone")}
        />
        <Link.MenuAction
          icon="folder"
          onPress={() => {
            router.push({
              pathname: "/matter/[workspaceId]",
              params: { name: task.matterName, workspaceId: task.matterId },
            });
          }}
          title={t("openMatter")}
        />
      </Link.Menu>
    </Link>
  );
};
