import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";

type ValidateParentIdOptions = {
  tx: Transaction;
  parentId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
};

export const validateParentId = async ({
  tx,
  parentId,
  workspaceId,
}: ValidateParentIdOptions): Promise<string | null> => {
  const parent = await tx.query.entities.findFirst({
    where: {
      id: { eq: parentId },
      workspaceId: { eq: workspaceId },
    },
    columns: { kind: true },
  });

  if (!parent) {
    return "Parent entity not found in this workspace";
  }
  if (parent.kind !== "folder") {
    return "Parent entity must be a folder";
  }

  return null;
};
