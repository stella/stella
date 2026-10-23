import type { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import * as v from "valibot";

import type { lockMatterStewardship } from "@/api/lib/db/aggregate-lock";
import { executedRows } from "@/api/lib/db/executed-rows";
import { withWorkspaceCreation } from "@/api/lib/workspaces/create-workspace-row";
import type {
  NormalizedWorkspaceCreationRow,
  WorkspaceCreationRow,
} from "@/api/lib/workspaces/create-workspace-row";

type LegacyWorkspaceFixtureOptions<T> = {
  tx: Parameters<typeof lockMatterStewardship>[0]["tx"];
  insert: () => Promise<T>;
};

/** Historical migration fixtures cannot use a protocol that did not exist yet. */
export const withLegacyWorkspaceFixture = async <T>({
  tx,
  insert,
}: LegacyWorkspaceFixtureOptions<T>): Promise<T> => {
  const metadata = executedRows(
    await tx.execute(sql`
    SELECT to_regclass('workspaces') IS NOT NULL AS present, EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = to_regclass('workspaces') AND attname = 'visibility'
        AND NOT attisdropped
    ) AS has_visibility
  `),
  );
  const state = v.parse(
    v.object({ present: v.boolean(), has_visibility: v.boolean() }),
    metadata.at(0),
  );
  if (!state.present || state.has_visibility) {
    panic(
      "Historical matter fixture requires an existing pre-visibility schema",
    );
  }
  return await insert();
};

type PgliteWorkspaceCreationOptions<T> = {
  database: PGlite;
  rows: readonly WorkspaceCreationRow[];
  insert: (rows: NormalizedWorkspaceCreationRow[]) => Promise<T>;
};

/** Keeps raw migration SQL on the same connection as the creation owner. */
export const withPgliteWorkspaceCreation = async <T>({
  database,
  rows,
  insert,
}: PgliteWorkspaceCreationOptions<T>): Promise<T> =>
  await withWorkspaceCreation({
    tx: drizzle({ client: database }),
    rows,
    insert,
  });
