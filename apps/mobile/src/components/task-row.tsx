import { Link, useRouter } from "expo-router";
import { Pressable, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { TASK_STATUS } from "@stll/api-contract/entity-options";
import { Text } from "@stll/ui/text";

import { useLayout, useSelection } from "@/components/selection";
import { SwipeRow } from "@/components/swipe-row";
import { useTaskStatus } from "@/components/use-task-status";
import { WriteFailureNotice } from "@/components/write-failure";
import type { AccessTokenSource } from "@/connection/session";
import { CircleCheckIcon, CircleIcon, RotateCcwIcon } from "@/icons.gen";
import type { TaskSummary } from "@/state/tasks";
import { useUiColors } from "@/theme";

/**
 * One open task: its name, then its matter and the day it is due, the day
 * in the destructive colour once it has passed. Tapping it opens the task
 * over its matter, as a matter's own list does, or beside the list where
 * the window has two columns. Swiping it marks it done, or open again once
 * done; holding it offers that too, or opening its matter.
 */
export const TaskRow = ({
  overdue,
  source,
  task,
}: {
  overdue: boolean;
  source: AccessTokenSource;
  task: TaskSummary;
}) => {
  const t = useTranslations("tasks");
  const matter = useTranslations("matter");
  const format = useFormatter();
  const router = useRouter();
  const layout = useLayout();
  const { change, closed, failure, saving } = useTaskStatus({
    matterId: task.matterId,
    source,
    status: task.status ?? TASK_STATUS.OPEN,
    taskId: task.id,
  });
  const statusLabel = closed ? t("reopen") : t("markDone");
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
    <SwipeRow
      action={
        saving
          ? null
          : {
              icon: closed ? RotateCcwIcon : CircleCheckIcon,
              label: statusLabel,
              name: "changeStatus",
              run: change,
            }
      }
    >
      {(accessibility) => (
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
              {...accessibility}
              accessibilityRole="button"
              accessibilityState={{ selected: open }}
              className={`border-border active:bg-accent flex-row gap-3 border-b py-3 ${open ? "bg-accent" : ""}`}
            >
              <View className="pt-0.5">
                {closed ? (
                  <CircleCheckIcon color={ui.successForeground} size={18} />
                ) : (
                  <CircleIcon color={ui.mutedForeground} size={18} />
                )}
              </View>
              <View className="flex-1 gap-0.5">
                <Text numberOfLines={2} variant="rowTitle">
                  {task.name === null ||
                  task.name === undefined ||
                  task.name === ""
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
                          overdue
                            ? { color: ui.destructiveForeground }
                            : undefined
                        }
                        variant="caption"
                      >
                        {due}
                      </Text>
                    </>
                  )}
                </Text>
                <WriteFailureNotice
                  failure={failure}
                  message={t("statusFailed")}
                />
              </View>
            </Pressable>
          </Link.Trigger>
          <Link.Menu>
            <Link.MenuAction
              disabled={saving}
              icon={closed ? "arrow.uturn.backward.circle" : "checkmark.circle"}
              onPress={change}
            >
              {statusLabel}
            </Link.MenuAction>
            <Link.MenuAction
              icon="folder"
              onPress={() => {
                router.push({
                  pathname: "/matter/[workspaceId]",
                  params: { name: task.matterName, workspaceId: task.matterId },
                });
              }}
            >
              {t("openMatter")}
            </Link.MenuAction>
          </Link.Menu>
        </Link>
      )}
    </SwipeRow>
  );
};
