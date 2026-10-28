import { Suspense, use, useState, useTransition } from "react";

import { Result } from "better-result";
import { ActivityIndicator, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import {
  TASK_CLOSED_STATUSES,
  TASK_STATUS,
} from "@stll/api-contract/entity-options";
import type { TaskStatus } from "@stll/api-contract/entity-options";

import { useChanged } from "@/components/changes";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { writeFailure, WriteFailureNotice } from "@/components/write-failure";
import type { WriteFailure } from "@/components/write-failure";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import type { ApiError } from "@/state/api-request";
import { readTask, setTaskStatus } from "@/state/tasks";
import type { TaskDetail } from "@/state/tasks";
import { useAppColors } from "@/theme";

const CLOSED: ReadonlySet<string> = new Set(TASK_CLOSED_STATUSES);

const STATUS_KEYS: ReadonlySet<string> = new Set(Object.values(TASK_STATUS));

const isStatus = (status: string): status is TaskStatus =>
  STATUS_KEYS.has(status);

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
  const t = useTranslations("tasks");
  const matter = useTranslations("matter");
  const format = useFormatter();
  const { end } = useSession();
  const changed = useChanged();
  const loaded = use(load);
  const [status, setStatus] = useState(
    Result.isOk(loaded) ? (loaded.value.status ?? TASK_STATUS.OPEN) : null,
  );
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [saving, startSaving] = useTransition();

  if (Result.isError(loaded) || status === null) {
    return null;
  }
  const done = CLOSED.has(status);
  const next = done ? TASK_STATUS.OPEN : TASK_STATUS.DONE;
  const { dueDate } = loaded.value;

  const change = () => {
    startSaving(async () => {
      setFailure(null);
      const saved = await setTaskStatus({
        fetch,
        matterId,
        source,
        status: next,
        taskId,
      });
      if (Result.isOk(saved)) {
        setStatus(next);
        changed("tasks");
        return;
      }
      if (saved.error._tag === "SignedOutError") {
        end(source);
        return;
      }
      setFailure(writeFailure(saved.error));
    });
  };

  return (
    <View className="gap-3">
      <Text variant="caption">
        {[
          isStatus(status) ? matter(`status.${status}`) : status,
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
        label={done ? t("reopen") : t("markDone")}
        loading={saving}
        onPress={change}
        variant={done ? "outline" : "default"}
      />
      <WriteFailureNotice failure={failure} message={t("statusFailed")} />
    </View>
  );
};
