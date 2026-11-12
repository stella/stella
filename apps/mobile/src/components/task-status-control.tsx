import { Suspense, use, useState } from "react";

import { Result } from "better-result";
import { ActivityIndicator, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { isTaskStatus, TASK_STATUS } from "@stll/api-contract/entity-options";
import { Button } from "@stll/ui/button";
import { Text } from "@stll/ui/text";

import { TaskAssignees } from "@/components/task-assignees";
import { useTaskStatus } from "@/components/use-task-status";
import { WriteFailureNotice } from "@/components/write-failure";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import type { ApiError } from "@/state/api-request";
import { readTask } from "@/state/tasks";
import type { TaskDetail } from "@/state/tasks";
import { useAppColors } from "@/theme";

/**
 * A task's status and due day under its sheet's title, with the one change
 * a phone makes most: done, or open again. The tasks list loads afresh after
 * either.
 */
export const TaskStatusControl = ({
  matterId,
  source,
  taskId,
}: {
  matterId: string;
  source: AccessTokenSource;
  taskId: string;
}) => {
  const colors = useAppColors();
  const { end } = useSession();
  const [load] = useState(async () => {
    const result = await readTask({ fetch, matterId, source, taskId });
    if (Result.isError(result) && result.error._tag === "SignedOutError") {
      end(source);
    }
    return result;
  });

  return (
    <Suspense fallback={<ActivityIndicator color={colors.muted} />}>
      <LoadedTaskStatus
        load={load}
        matterId={matterId}
        source={source}
        taskId={taskId}
      />
    </Suspense>
  );
};

const LoadedTaskStatus = ({
  load,
  matterId,
  source,
  taskId,
}: {
  load: Promise<Result<TaskDetail, ApiError>>;
  matterId: string;
  source: AccessTokenSource;
  taskId: string;
}) => {
  const loaded = use(load);
  if (Result.isError(loaded)) {
    return null;
  }
  return (
    <TaskStatusBody
      matterId={matterId}
      source={source}
      task={loaded.value}
      taskId={taskId}
    />
  );
};

const TaskStatusBody = ({
  matterId,
  source,
  task,
  taskId,
}: {
  matterId: string;
  source: AccessTokenSource;
  task: TaskDetail;
  taskId: string;
}) => {
  const t = useTranslations("tasks");
  const matter = useTranslations("matter");
  const format = useFormatter();
  const { assignees, dueDate, status: reported } = task;
  const { change, closed, failure, saving, status } = useTaskStatus({
    from: task,
    matterId,
    source,
    status: reported ?? TASK_STATUS.OPEN,
    taskId,
  });

  return (
    <View className="gap-3">
      <Text variant="caption">
        {[
          isTaskStatus(status) ? matter(`status.${status}`) : status,
          dueDate === null || dueDate === undefined
            ? undefined
            : t("dueOn", {
                // A calendar day: read at noon so no time zone moves it.
                day: format.dateTime(new Date(`${dueDate}T12:00:00`), {
                  day: "numeric",
                  month: "long",
                }),
              }),
        ]
          .filter((part) => part !== undefined)
          .join(" · ")}
      </Text>
      <Button
        disabled={saving}
        loading={saving}
        onPress={change}
        variant={closed ? "outline" : "default"}
      >
        {closed ? t("reopen") : t("markDone")}
      </Button>
      <WriteFailureNotice failure={failure} message={t("statusFailed")} />
      <TaskAssignees
        initial={assignees}
        matterId={matterId}
        source={source}
        taskId={taskId}
      />
    </View>
  );
};
