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

/** The delegation intentionally adds byte collation; UUIDs need text first. */
export const canonicalParentLockStatement = (statement: string) =>
  statement
    .replace(
      'ORDER BY "organization"."id" FOR',
      'ORDER BY "organization"."id" COLLATE "C" FOR',
    )
    .replace(
      'ORDER BY "workspaces"."id" FOR',
      'ORDER BY "workspaces"."id"::text COLLATE "C" FOR',
    );

type LockForWriteOptions = {
  organizationIds: readonly SafeId<"organization">[];
  workspaceIds?: readonly SafeId<"workspace">[];
};

/** Frozen parent-lock SQL contract for delegation equivalence tests. */
export const referenceParentLocks = async (
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
