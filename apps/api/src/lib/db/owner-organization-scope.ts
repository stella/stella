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
 * The enclosing setting, after proving the transaction runs as the owner of
 * the `contacts` table its search path resolves (the table the owner policy
 * reads).
 */
const readOwnerScopeState = async (
  tx: Transaction,
): Promise<OwnerScopeState> => {
  const [row] = executedRows(
    await tx.execute(
      sql`SELECT
        coalesce(pg_catalog.current_setting(${SETTING_ORGANIZATION_ID}, true), '') AS organization_id,
        coalesce(
          current_user = (
            SELECT pg_catalog.pg_get_userbyid(relation.relowner)
            FROM pg_catalog.pg_class relation
            WHERE relation.oid = pg_catalog.to_regclass('contacts')
          ),
          false
        ) AS is_owner`,
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
  return {
    previous: setting === "" ? "" : brandPersistedOrganizationId(setting),
  };
};

/** `setting` is an organization id, or the empty setting it hands back. */
const writeOrganizationSetting = async (
  tx: Transaction,
  setting: SafeId<"organization"> | "",
) => {
  await tx.execute(
    sql`SELECT pg_catalog.set_config(${SETTING_ORGANIZATION_ID}, ${setting}, true)`,
  );
};

export const withOwnerOrganizationScope = async <T>(
  handle: OwnerScopeHandle & NotRlsMarked,
  organizationId: SafeId<"organization">,
  run: (tx: Transaction) => Promise<T>,
): Promise<T> =>
  // A savepoint of an enclosing transaction, or a fresh transaction. A failed
  // statement rolls the savepoint and its setting back together; a completed
  // run hands the enclosing transaction its own setting back.
  await withAggregateSavepoint<Transaction, T>(handle, async (tx) => {
    const { previous } = await readOwnerScopeState(tx);
    if (previous !== "" && previous !== organizationId) {
      return panic(
        "An organization-scoped transaction cannot enter another organization",
      );
    }
    await writeOrganizationSetting(tx, organizationId);
    const value = await run(tx);
    await writeOrganizationSetting(tx, previous);
    return value;
  });
