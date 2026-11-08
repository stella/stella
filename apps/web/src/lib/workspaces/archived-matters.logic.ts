import { panic } from "better-result";

import {
  type VisibleWorkspaceStatus,
  WORKSPACE_STATUS,
  workspaceAcceptsWrites,
  type WorkspaceStatus,
} from "@stll/api-contract/workspace-status";

export type MatterListStatus = VisibleWorkspaceStatus;

export const isMatterInStatusView = (
  status: WorkspaceStatus,
  view: MatterListStatus,
) => status === view;

export const matterRouteView = (status: WorkspaceStatus) => {
  switch (status) {
    case WORKSPACE_STATUS.active:
      return "active";
    case WORKSPACE_STATUS.archived:
      return "archived-read-only";
    case WORKSPACE_STATUS.deleting:
      return "unavailable";
    default:
      status satisfies never;
      return panic(`Unhandled workspace status: ${String(status)}`);
  }
};

export const matterCardDragMode = (
  status: WorkspaceStatus,
  canReassignClient: boolean,
): "client-group" | "none" =>
  workspaceAcceptsWrites(status) && canReassignClient ? "client-group" : "none";
