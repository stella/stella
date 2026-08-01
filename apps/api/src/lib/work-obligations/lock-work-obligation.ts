import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { workObligations } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type LockWorkObligationOptions = {
  entityId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
};

/** Lock the parent workflow row before any event or task-compatibility write. */
export const lockWorkObligation = async (
  tx: Transaction,
  { entityId, workspaceId }: LockWorkObligationOptions,
) => {
  const rows = await tx
    .select()
    .from(workObligations)
    .where(
      and(
        eq(workObligations.entityId, entityId),
        eq(workObligations.workspaceId, workspaceId),
      ),
    )
    .limit(1)
    .for("update");

  return rows.at(0);
};
