import {
  workspaceAcceptsWrites,
  type WorkspaceStatus,
} from "@stll/api-contract/workspace-status";

export const matterCardPreviewEnabled = (
  status: WorkspaceStatus,
  previewRequested: boolean,
) => workspaceAcceptsWrites(status) && previewRequested;
