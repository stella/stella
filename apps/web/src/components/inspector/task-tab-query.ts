import type { TaskTab } from "@/components/inspector/inspector-store-types";
import { taskDetailOptions } from "@/lib/workspaces/queries/tasks";

/** A pending task tab carries a client placeholder id that the API rejects;
 *  fetch only after `resolvePendingTask` swaps in the real task id. */
export const taskTabDetailOptions = ({
  creationStatus,
  id,
  workspaceId,
}: Pick<TaskTab, "creationStatus" | "id" | "workspaceId">) => ({
  ...taskDetailOptions(workspaceId, id),
  enabled: creationStatus === "ready",
});
