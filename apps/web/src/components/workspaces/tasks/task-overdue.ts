import { TASK_CLOSED_STATUSES } from "@stll/api-contract/entity-options";

import { localISODate } from "@/lib/local-iso-date";

/** Past its due date on the reader's calendar and not yet finished. */
export const isTaskOverdue = (dueDate: string, status: string | null) =>
  !TASK_CLOSED_STATUSES.some((closed) => closed === status) &&
  dueDate < localISODate();
