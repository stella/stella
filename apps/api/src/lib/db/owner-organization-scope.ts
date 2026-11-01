import { panic } from "better-result";
import { type SQL, sql } from "drizzle-orm";

import { SETTING_ORGANIZATION_ID } from "@/api/db/rls";
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
 * organization.
 *
 * `withOwnerOrganizationScope` runs `run` in a transaction (a savepoint when
 * `handle` already is one) whose organization setting is `organizationId`,
 * then restores the enclosing transaction's setting, so the owner work
 * around it keeps the scope it had. The owner role stays the current role:
 * nothing else the transaction reads changes, and other organizations'
 * contacts stay unreadable and unwritable through it.
 *
 * A transaction that already names an organization keeps it: entering a
 * different one there is refused, so a tenant transaction never reaches
 * another tenant's contacts through this helper.
 */

type OwnerScopeTransaction = {
  execute: (query: SQL) => PromiseLike<unknown>;
};

/** The owner database, or an owner transaction to scope a savepoint of. */
type OwnerScopeHandle<Tx extends OwnerScopeTransaction> = {
  transaction: <Value>(run: (tx: Tx) => Promise<Value>) => Promise<Value>;
};

const readOrganizationSetting = async (
  tx: OwnerScopeTransaction,
): Promise<SafeId<"organization"> | ""> => {
  const [row] = executedRows(
    await tx.execute(
      sql`SELECT coalesce(pg_catalog.current_setting(${SETTING_ORGANIZATION_ID}, true), '') AS organization_id`,
    ),
  );
  const setting = isRecord(row) ? row["organization_id"] : undefined;
  if (typeof setting !== "string") {
    return panic("Organization setting read returned an invalid row");
  }
  return setting === "" ? "" : brandPersistedOrganizationId(setting);
};

/** `setting` is an organization id, or the empty setting it hands back. */
const writeOrganizationSetting = async (
  tx: OwnerScopeTransaction,
  setting: SafeId<"organization"> | "",
) => {
  await tx.execute(
    sql`SELECT pg_catalog.set_config(${SETTING_ORGANIZATION_ID}, ${setting}, true)`,
  );
};

export const withOwnerOrganizationScope = async <
  Tx extends OwnerScopeTransaction,
  T,
>(
  handle: OwnerScopeHandle<Tx>,
  organizationId: SafeId<"organization">,
  run: (tx: Tx) => Promise<T>,
): Promise<T> =>
  // A savepoint of an enclosing transaction, or a fresh transaction. A failed
  // statement rolls the savepoint and its setting back together; a completed
  // run hands the enclosing transaction its own setting back.
  await withAggregateSavepoint(handle, async (tx) => {
    const previous = await readOrganizationSetting(tx);
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
