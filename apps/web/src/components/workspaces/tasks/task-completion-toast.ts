import { TASK_STATUS } from "@stll/api-contract";
import type { TaskStatus } from "@stll/api-contract";
import { stellaToast } from "@stll/ui/toast";

import { getTranslator } from "@/i18n/translator";

type TaskStatusChange = {
  next: TaskStatus;
  previous: TaskStatus;
  restore: (status: TaskStatus) => void;
};

/**
 * A completed task leaves the agenda the moment the status saves, so the
 * change is confirmed with a way back to where it was.
 */
export const notifyTaskCompletion = ({
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
    action: { label: t("common.undo"), onClick: () => restore(previous) },
  });
};
