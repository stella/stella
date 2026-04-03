import { createScopedDb } from "@/api/db";
import type { ScopedDb } from "@/api/db";
import { db } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";

type CreateRootScopedDbOptions = {
  organizationId: SafeId<"organization">;
  workspaceIds: SafeId<"workspace">[];
};

export const createRootScopedDb = ({
  organizationId,
  workspaceIds,
}: CreateRootScopedDbOptions): ScopedDb =>
  createScopedDb(db, workspaceIds, organizationId);
