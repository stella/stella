/**
 * Task-list filters shared by the API (HTTP list route and the MCP
 * `list_tasks` tool) and web.
 */

/** Whose tasks a list returns: the caller's own assignments, or every task. */
export const TASK_ASSIGNEE_FILTER = {
  ME: "me",
  ANY: "any",
} as const;
export type TaskAssigneeFilter =
  (typeof TASK_ASSIGNEE_FILTER)[keyof typeof TASK_ASSIGNEE_FILTER];
export const TASK_ASSIGNEE_FILTERS = [
  TASK_ASSIGNEE_FILTER.ME,
  TASK_ASSIGNEE_FILTER.ANY,
] as const satisfies readonly TaskAssigneeFilter[];
