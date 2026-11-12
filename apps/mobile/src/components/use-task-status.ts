import { useOptimisticWrite } from "@/components/use-optimistic-write";
import type { AccessTokenSource } from "@/connection/session";
import { isTaskClosed, nextTaskStatus, setTaskStatus } from "@/state/tasks";

/**
 * The one way the app changes a task's status, wherever the task shows: its
 * sheet's button, and its row's swipe and menu. Done, or open again once
 * finished, shown at once and undone if it does not save.
 */
export const useTaskStatus = ({
  from,
  matterId,
  source,
  status,
  taskId,
}: {
  /** The load the status came from. */
  from: object;
  matterId: string;
  source: AccessTokenSource;
  /** The status as the last load reported it. */
  status: string;
  taskId: string;
}) => {
  const { failure, saving, value, write } = useOptimisticWrite({
    from,
    kind: "tasks",
    reported: status,
    source,
  });
  const next = nextTaskStatus(value);
  const change = () => {
    write(
      next,
      async () =>
        await setTaskStatus({ fetch, matterId, source, status: next, taskId }),
    );
  };
  return {
    change,
    closed: isTaskClosed(value),
    failure,
    saving,
    status: value,
  };
};
