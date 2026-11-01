import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import { SETTING_ORGANIZATION_DELETION_IDS } from "@/api/db/rls";

/**
 * Test-only removal of organization rows a suite seeded. Production deletes an
 * organization only through completeOrganizationDeletion, and the organization
 * delete guard trigger refuses every other delete. A suite that cleans up its
 * own fixtures names the rows here instead: one statement sets the
 * transaction-local permission the trigger reads (the comma-separated ids)
 * and deletes exactly those rows.
 *
 * For a raw driver, pass the placeholder that carries the joined ids, as in
 * `client.unsafe(ORGANIZATION_DELETION_FOR_TEST_SQL("$1"), [ids.join(",")])`.
 */
export const ORGANIZATION_DELETION_FOR_TEST_SQL = (
  idsPlaceholder: string,
): string =>
  `WITH allowed AS (SELECT pg_catalog.set_config('${SETTING_ORGANIZATION_DELETION_IDS}', ${idsPlaceholder}, true) AS ids) ` +
  `DELETE FROM public.organization WHERE id = ANY (pg_catalog.string_to_array((SELECT ids FROM allowed), ','))`;

type ExecutingDatabase = {
  execute: (query: SQLWrapper) => PromiseLike<unknown>;
};

/** Delete the named organization rows (and what cascades from them). */
export const deleteOrganizationsForTest = async (
  db: ExecutingDatabase,
  organizationIds: readonly string[],
): Promise<void> => {
  if (organizationIds.length === 0) {
    return;
  }
  await db.execute(
    sql`WITH allowed AS (SELECT pg_catalog.set_config(${SETTING_ORGANIZATION_DELETION_IDS}, ${organizationIds.join(",")}, true) AS ids) DELETE FROM public.organization WHERE id = ANY (pg_catalog.string_to_array((SELECT ids FROM allowed), ','))`,
  );
};
