import { panic } from "better-result";
import { sql } from "drizzle-orm";

import { SETTING_ORGANIZATION_ID } from "@/api/db/rls";
import type { RootDatabase, Transaction } from "@/api/db/root";
import type { RlsDatabaseMarker } from "@/api/db/scoped";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateSavepoint } from "@/api/lib/db/aggregate-lock";
import { executedRows } from "@/api/lib/db/executed-rows";
import { brandPersistedOrganizationId } from "@/api/lib/safe-id-boundaries";
import { isRecord } from "@/api/lib/type-guards";

/**
 * The owner connection reaches `contacts` inside one organization only: the
 * table forces row security on its owner, and the owner's policy admits the
 * rows of the organization the transaction names in `app.organization_id`.
 * This module is the one place owner-connection code names that
 * organization; `scripts/ownership/owner-organization-scope.ts` lists the
 * modules that may import it.
 *
 * `withOwnerOrganizationScope` runs `run` in a transaction (a savepoint when
 * `handle` already is one) whose organization setting is `organizationId`,
 * then hands the enclosing transaction its own setting back. The owner role
 * stays the current role: nothing else the transaction reads changes, and
 * other organizations' contacts stay unreadable and unwritable through it.
 *
 * Only the table owner may enter: the handle is the owner database or one of
 * its transactions (an RLS-marked application database does not typecheck),
 * and the savepoint refuses any other current role, so an application-role
 * transaction, tenantless or not, never gains an organization here. A
 * transaction that already names an organization keeps it: entering a
 * different one is refused.
 */

/** The owner database, or an owner transaction to scope a savepoint of. */
type OwnerScopeHandle =
  Pick<RootDatabase, "transaction"> | Pick<Transaction, "transaction">;

/** Application databases carry the RLS marker; they are not owner handles. */
type NotRlsMarked = { readonly [Key in keyof RlsDatabaseMarker]?: never };

type OwnerScopeState = {
  previous: SafeId<"organization"> | "";
};

/**
 * One statement: proves the transaction runs as the owner of the `contacts`
 * table its search path resolves (the table the owner policy reads), reads
 * the enclosing setting, and names `organizationId` only when both allow it.
 * The subquery reads the setting before the outer projection writes it.
 */
const enterOwnerScope = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
): Promise<OwnerScopeState> => {
  const [row] = executedRows(
    await tx.execute(
      sql`SELECT
        state.organization_id,
        state.is_owner,
        CASE
          WHEN state.is_owner AND state.organization_id IN ('', ${organizationId})
          THEN pg_catalog.set_config(${SETTING_ORGANIZATION_ID}, ${organizationId}, true)
        END AS entered
      FROM (
        SELECT
          coalesce(pg_catalog.current_setting(${SETTING_ORGANIZATION_ID}, true), '') AS organization_id,
          coalesce(
            current_user = (
              SELECT pg_catalog.pg_get_userbyid(relation.relowner)
              FROM pg_catalog.pg_class relation
              WHERE relation.oid = pg_catalog.to_regclass('contacts')
            ),
            false
          ) AS is_owner
        OFFSET 0
      ) AS state`,
    ),
  );
  if (!isRecord(row) || typeof row["organization_id"] !== "string") {
    return panic("Organization setting read returned an invalid row");
  }
  if (row["is_owner"] !== true) {
    return panic(
      "The owner organization scope runs only as the contacts table owner",
    );
  }
  const setting = row["organization_id"];
  if (setting !== "" && setting !== organizationId) {
    return panic(
      "An organization-scoped transaction cannot enter another organization",
    );
  }
  return {
    previous: setting === "" ? "" : brandPersistedOrganizationId(setting),
  };
};

export const withOwnerOrganizationScope = async <T>(
  handle: OwnerScopeHandle & NotRlsMarked,
  organizationId: SafeId<"organization">,
  run: (tx: Transaction) => Promise<T>,
): Promise<T> => {
  // Only a transaction exposes rollback; a database opens a fresh one, whose
  // setting ends with it.
  const enclosing = "rollback" in handle;
  // A savepoint of an enclosing transaction, or a fresh transaction. A failed
  // statement rolls the savepoint and its setting back together; a completed
  // run hands an enclosing transaction its own setting back.
  return await withAggregateSavepoint<Transaction, T>(handle, async (tx) => {
    const { previous } = await enterOwnerScope(tx, organizationId);
    const value = await run(tx);
    if (enclosing && previous !== organizationId) {
      await tx.execute(
        sql`SELECT pg_catalog.set_config(${SETTING_ORGANIZATION_ID}, ${previous}, true)`,
      );
    }
    return value;
  });
};
