import {
  defineTextFieldSpec,
  deriveTextFieldPaths,
} from "@/api/mcp/text-field-spec";
import type { McpTextFieldSpec } from "@/api/mcp/tool-types";

// --- list_tasks text-field specs -----------------------------------------

/**
 * Shape `list_tasks`'s list branch redacts. Rows can span matters, so each
 * field is scoped to the row's own matter.
 */
type TaskListTextItem = {
  name: string;
  matterId: string;
  matterName: string;
  matterReference: string;
};
type TaskListTextPayload = { tasks: readonly TaskListTextItem[] };

export const TASK_LIST_TEXT_FIELD_SPECS: readonly McpTextFieldSpec<TaskListTextPayload>[] =
  [
    defineTextFieldSpec({
      path: "tasks[].name",
      items: (payload: TaskListTextPayload) => payload.tasks,
      scope: (item: TaskListTextItem) => item.matterId,
      read: (item: TaskListTextItem) => item.name,
      apply: (item: TaskListTextItem, value) => {
        item.name = value;
      },
    }),
    defineTextFieldSpec({
      path: "tasks[].matterName",
      items: (payload: TaskListTextPayload) => payload.tasks,
      scope: (item: TaskListTextItem) => item.matterId,
      read: (item: TaskListTextItem) => item.matterName,
      apply: (item: TaskListTextItem, value) => {
        item.matterName = value;
      },
    }),
    defineTextFieldSpec({
      path: "tasks[].matterReference",
      items: (payload: TaskListTextPayload) => payload.tasks,
      scope: (item: TaskListTextItem) => item.matterId,
      read: (item: TaskListTextItem) => item.matterReference,
      apply: (item: TaskListTextItem, value) => {
        item.matterReference = value;
      },
    }),
  ];

type TaskAssigneeTextItem = { name: string | null };
type TaskLinkTextItem = { entity: { name: string | null } };

/** Full shape `list_tasks`'s detail branch redacts, one task deep. */
type TaskDetailTextPayload = {
  task: {
    name: string;
    location: string | null;
    assignees: readonly TaskAssigneeTextItem[];
    links: readonly TaskLinkTextItem[];
  };
};

/**
 * Every redactable field on one task detail response: the task's own
 * name/location (P1: constant `workspaceId`, single item), plus its
 * assignees' names and linked entities' names.
 */
export const taskDetailTextFieldSpecs = (
  workspaceId: string,
): readonly McpTextFieldSpec<TaskDetailTextPayload>[] => [
  defineTextFieldSpec({
    path: "task.name",
    items: (payload) => [payload.task],
    scope: () => workspaceId,
    read: (item) => item.name,
    apply: (item, value) => {
      item.name = value;
    },
  }),
  defineTextFieldSpec({
    path: "task.location",
    items: (payload) => [payload.task],
    scope: () => workspaceId,
    read: (item) => item.location,
    apply: (item, value) => {
      item.location = value;
    },
  }),
  defineTextFieldSpec({
    path: "task.assignees[].name",
    items: (payload) => payload.task.assignees,
    scope: () => workspaceId,
    read: (item) => item.name,
    apply: (item, value) => {
      item.name = value;
    },
  }),
  defineTextFieldSpec({
    path: "task.links[].entity.name",
    items: (payload) => payload.task.links,
    scope: () => workspaceId,
    read: (item) => item.entity.name,
    apply: (item, value) => {
      item.entity.name = value;
    },
  }),
];

export const TASK_DETAIL_TEXT_FIELD_PATHS = deriveTextFieldPaths(
  taskDetailTextFieldSpecs(""),
);
