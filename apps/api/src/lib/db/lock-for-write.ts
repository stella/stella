import { sql } from "drizzle-orm";
import * as v from "valibot";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  brandPersistedOrganizationId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";

const parentRowSchema = v.object({ id: v.string() });

/**
 * Write locks follow organization -> workspace -> entity -> child rows,
 * sorting ids within each level. Acquire the foreign-key parents before
 * locking a source or replacing a projection; lifecycle deletion owns those
 * parents before cascading to the same children.
 */
type LockForWriteOptions = {
  organizationIds: readonly SafeId<"organization">[];
  workspaceIds?: readonly SafeId<"workspace">[];
};

/** Only returned parents remain live; omit sources whose parents disappeared. */
export const lockForWrite = async (
  tx: Pick<Transaction, "execute">,
  { organizationIds, workspaceIds = [] }: LockForWriteOptions,
) => {
  const organizations = [...new Set(organizationIds)].toSorted();
  const matters = [...new Set(workspaceIds)].toSorted();
  // Sort immutable primary keys before acquiring row locks. Each level is
  // one round-trip even when a projection batch spans many sources.
  const organizationRows =
    organizations.length === 0
      ? []
      : await tx.execute(sql`
    SELECT id FROM ${organization}
    WHERE ${organization.id} IN (${sql.join(
      organizations.map((id) => sql`${id}`),
      sql`, `,
    )})
    ORDER BY ${organization.id} FOR KEY SHARE
  `);
  const workspaceRows =
    matters.length === 0
      ? []
      : await tx.execute(sql`
    SELECT id FROM ${workspaces}
    WHERE ${workspaces.id} IN (${sql.join(
      matters.map((id) => sql`${id}`),
      sql`, `,
    )})
    ORDER BY ${workspaces.id} FOR KEY SHARE
  `);
  return {
    organizationIds: new Set(
      executedRows(organizationRows).map((row) =>
        brandPersistedOrganizationId(v.parse(parentRowSchema, row).id),
      ),
    ),
    workspaceIds: new Set(
      executedRows(workspaceRows).map((row) =>
        brandPersistedWorkspaceId(v.parse(parentRowSchema, row).id),
      ),
    ),
  };
};
