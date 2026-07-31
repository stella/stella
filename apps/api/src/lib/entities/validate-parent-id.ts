import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { entities } from "@/api/db/schema";
import type { EntityKind } from "@/api/db/schema-validators";
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

  return getParentValidationError(parent);
};

export const validateParentIdForInsert = async ({
  tx,
  parentId,
  workspaceId,
}: ValidateParentIdOptions): Promise<string | null> => {
  const parentRows = await tx
    .select({ kind: entities.kind })
    .from(entities)
    .where(
      and(eq(entities.id, parentId), eq(entities.workspaceId, workspaceId)),
    )
    .limit(1)
    .for("update");

  return getParentValidationError(parentRows.at(0));
};

const getParentValidationError = (
  parent: { kind: EntityKind } | undefined,
): string | null => {
  if (!parent) {
    return "Parent entity not found in this workspace";
  }
  if (parent.kind !== "folder") {
    return "Parent entity must be a folder";
  }

  return null;
};
