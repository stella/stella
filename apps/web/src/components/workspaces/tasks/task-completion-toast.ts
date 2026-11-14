import { TASK_STATUS } from "@stll/api-contract";
import type { TaskStatus } from "@stll/api-contract";
import { stellaToast } from "@stll/ui/toast";

import { getTranslator } from "@/i18n/translator";

type TaskStatusChange = {
  /** The status as last read; `undefined` when the task is not loaded here. */
  currentStatus: () => unknown;
  next: TaskStatus;
  /** `null` when another save was still pending, so it cannot be known. */
  previous: TaskStatus | null;
  restore: (status: TaskStatus) => void;
};

/**
 * A completed task leaves the agenda the moment the status saves, so the
 * change is confirmed with a way back to where it was. Undo leaves alone a
 * status someone has changed since.
 */
export const notifyTaskCompletion = ({
  currentStatus,
  next,
  previous,
  restore,
}: TaskStatusChange) => {
  if (next !== TASK_STATUS.DONE || previous === TASK_STATUS.DONE) {
    return;
  }
  const t = getTranslator();
  stellaToast.add({
    title: t("tasks.taskCompleted"),
    type: "success",
    ...(previous === null
      ? {}
      : {
          action: {
            label: t("common.undo"),
            onClick: () => {
              const current = currentStatus();
              if (current === undefined || current === next) {
                restore(previous);
              }
            },
          },
        }),
  });
};
