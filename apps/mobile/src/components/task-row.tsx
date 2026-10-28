import { useRouter } from "expo-router";
import { Pressable, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { Text } from "@/components/ui/text";
import { CircleIcon } from "@/icons.gen";
import type { TaskSummary } from "@/state/tasks";
import { useUiColors } from "@/theme";

/**
 * One open task: its name, then its matter and the day it is due, the day
 * in the destructive colour once it has passed. Tapping it opens the task
 * over its matter, as a matter's own list does.
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
    <Pressable
      accessibilityRole="button"
      className="border-border active:bg-accent flex-row gap-3 border-b py-3"
      onPress={() => {
        router.push({
          pathname: "/matter/[workspaceId]/[entityId]",
          params: { entityId: task.id, workspaceId: task.matterId },
        });
      }}
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
  );
};
