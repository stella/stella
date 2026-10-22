type MatterMemoryStatus = "active" | "archived" | "deleting";

type CanManageMatterMemoryOptions = {
  canManage: boolean;
  status: MatterMemoryStatus | undefined;
};

export const canManageMatterMemory = ({
  canManage,
  status,
}: CanManageMatterMemoryOptions): boolean => canManage && status === "active";
