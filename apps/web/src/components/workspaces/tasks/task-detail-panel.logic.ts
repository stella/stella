import { panic } from "better-result";

import type { TaskStatus } from "@stll/api-contract";

import { toSafeId } from "@/lib/safe-id";

import type { ListItemType, TaskPriority } from "./task-detail-constants";
import type { WorkType } from "./task-metadata";

type TaskDetailIdentity = {
  workspaceId: string;
  taskId: string;
};

export const getTaskDetailInstanceKey = ({
  workspaceId,
  taskId,
}: TaskDetailIdentity) => `${workspaceId}:${taskId}`;

type TaskUpdateValueByType = {
  dueDate: string | null;
  listItemType: ListItemType;
  name: string;
  priority: TaskPriority;
  status: {
    status: TaskStatus;
    workflowReason?: string;
  };
};

type TaskUpdateType = keyof TaskUpdateValueByType;

export type TaskUpdate = {
  [Type in TaskUpdateType]: {
    taskId: string;
    type: Type;
    value: TaskUpdateValueByType[Type];
  };
}[TaskUpdateType];

export const taskUpdateBody = (update: TaskUpdate) => {
  switch (update.type) {
    case "dueDate":
      return { dueDate: update.value };
    case "listItemType":
      return { listItemType: update.value };
    case "name":
      return { name: update.value };
    case "priority":
      return { priority: update.value };
    case "status":
      return update.value;
    default: {
      update satisfies never;
      return panic(`Unhandled update: ${String(update)}`);
    }
  }
};

export const taskUpdateClearsWorkflowReason = (update: TaskUpdate) =>
  update.type === "status" && update.value.workflowReason !== undefined;

type WorkflowUpdateValueByType = {
  hardDeadline: {
    hardDeadlineDate: string | null;
    reason?: string;
  };
  owner: {
    ownerUserId: string | null;
    reason?: string;
  };
  type: WorkType;
  workingTargetDate: string | null;
};

type WorkflowUpdateType = keyof WorkflowUpdateValueByType;

export type WorkflowUpdate = {
  [Type in WorkflowUpdateType]: {
    type: Type;
    value: WorkflowUpdateValueByType[Type];
  };
}[WorkflowUpdateType];

export const workflowUpdateBody = (update: WorkflowUpdate) => {
  switch (update.type) {
    case "hardDeadline":
      return update.value;
    case "owner":
      return {
        ...update.value,
        ownerUserId:
          update.value.ownerUserId === null
            ? null
            : toSafeId<"user">(update.value.ownerUserId),
      };
    case "type":
      return { type: update.value };
    case "workingTargetDate":
      return { workingTargetDate: update.value };
    default: {
      update satisfies never;
      return panic(`Unhandled update: ${String(update)}`);
    }
  }
};

export const workflowUpdateClearsReason = (update: WorkflowUpdate) =>
  (update.type === "hardDeadline" || update.type === "owner") &&
  update.value.reason !== undefined;

export const getTaskStatusUpdate = (
  taskId: string,
  status: TaskStatus,
  workflowReason: string,
): TaskUpdate => {
  const reason = workflowReason.trim();
  return {
    taskId,
    type: "status",
    value: {
      status,
      ...(status === "cancelled" && reason ? { workflowReason: reason } : {}),
    },
  };
};
