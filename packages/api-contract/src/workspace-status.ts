import { panic } from "better-result";

export const WORKSPACE_STATUS = {
  active: "active",
  deleting: "deleting",
  archived: "archived",
} as const;

export const WORKSPACE_STATUSES = [
  WORKSPACE_STATUS.active,
  WORKSPACE_STATUS.deleting,
  WORKSPACE_STATUS.archived,
] as const;

export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

// Total over the domain: a new status is a compile error until it decides
// whether its workspace stays readable.
const WORKSPACE_STATUS_VISIBILITY = {
  active: "visible",
  archived: "visible",
  deleting: "hidden",
} as const satisfies Record<WorkspaceStatus, "visible" | "hidden">;

export type VisibleWorkspaceStatus = {
  [
    TStatus in WorkspaceStatus
  ]: (typeof WORKSPACE_STATUS_VISIBILITY)[TStatus] extends "visible"
    ? TStatus
    : never;
}[WorkspaceStatus];

const isVisibleWorkspaceStatus = (
  status: WorkspaceStatus,
): status is VisibleWorkspaceStatus =>
  WORKSPACE_STATUS_VISIBILITY[status] === "visible";

export const VISIBLE_WORKSPACE_STATUSES = WORKSPACE_STATUSES.filter(
  isVisibleWorkspaceStatus,
);

/** Only an active workspace accepts new writes; an absent status accepts none. */
export const workspaceAcceptsWrites = (
  status: WorkspaceStatus | null | undefined,
): boolean => {
  switch (status) {
    case WORKSPACE_STATUS.active:
      return true;
    case WORKSPACE_STATUS.archived:
    case WORKSPACE_STATUS.deleting:
    case null:
    case undefined:
      return false;
    default:
      status satisfies never;
      return panic(`Unhandled workspace status: ${String(status)}`);
  }
};

/** Active and archived workspaces are readable; a deleting or absent one is not. */
export const workspaceIsVisible = (
  status: WorkspaceStatus | null | undefined,
): boolean =>
  status !== null && status !== undefined && isVisibleWorkspaceStatus(status);
