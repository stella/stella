import { createScopedDb } from "@/api/db";
import { rlsDb } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";

export const createRootScopedDb = ({
  organizationId,
  userId,
  workspaceIds,
}: {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceIds: SafeId<"workspace">[];
}) =>
  // This helper exists only because some modules are not allowed
  // to import the RLS database handle directly.
  createScopedDb(rlsDb, workspaceIds, organizationId, userId);
