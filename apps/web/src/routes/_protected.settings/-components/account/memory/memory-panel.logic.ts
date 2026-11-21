import {
  workspaceAcceptsWrites,
  type WorkspaceStatus,
} from "@stll/api-contract/workspace-status";

type CanManageMatterMemoryOptions = {
  canManage: boolean;
  status: WorkspaceStatus | undefined;
};

export const canManageMatterMemory = ({
  canManage,
  status,
}: CanManageMatterMemoryOptions): boolean =>
  canManage && workspaceAcceptsWrites(status);
