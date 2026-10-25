import { rootDb } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";

/**
 * Organization creation records the access state on the owner connection: it
 * runs before any organization scope exists, and the insert is idempotent.
 * Kept apart from the access-state rules so their readers open no pool.
 */
export const recordNewOrganizationAccessStateOnOwner = async (
  organizationId: SafeId<"organization">,
): Promise<void> =>
  await recordNewOrganizationAccessState(rootDb, {
    organizationId,
    now: new Date(),
  });
