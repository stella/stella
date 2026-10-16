import { sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { MatterVisibility } from "@stll/api-contract";

import { SETTING_WORKSPACE_IDS } from "@/api/db/rls";
import type { Transaction } from "@/api/db/root";
import { workspaces } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { lockMatterStewardship } from "@/api/lib/db/aggregate-lock";

type NewWorkspaceRow = {
  id: SafeId<"workspace">;
  clientId: string | null;
  name: string;
  reference: string;
  visibility: MatterVisibility;
  billingReference?: string | null;
  color?: string | null;
  leadUserId?: string | null;
};

/**
 * Create a matter in the scoped transaction through the database
 * (`stella_create_workspace`). The database takes the organization and the
 * creating member from the transaction settings, checks that the client and
 * the lead belong to that organization, and assigns the creator when the
 * access rule would not reach the new matter otherwise. A transaction scoped
 * to an explicit list of matters sees only that list, so the new matter joins
 * the list too.
 */
export const createWorkspaceInTransaction = async (
  tx: Pick<Transaction, "execute">,
  {
    id,
    clientId,
    name,
    reference,
    visibility,
    billingReference = null,
    color = null,
    leadUserId = null,
  }: NewWorkspaceRow,
): Promise<void> => {
  await tx.execute(
    sql`SELECT public.stella_create_workspace(
      ${id}::uuid,
      ${clientId}::uuid,
      ${name},
      ${reference},
      ${billingReference},
      ${color},
      ${leadUserId},
      ${visibility}
    )`,
  );
  // The setting is a Postgres array literal: {id1,id2}.
  await tx.execute(
    sql`SELECT set_config(
      ${SETTING_WORKSPACE_IDS},
      array_append(
        current_setting(${SETTING_WORKSPACE_IDS}, true)::text[],
        ${id}
      )::text,
      true
    )`,
  );
};

export type WorkspaceCreationRow = typeof workspaces.$inferInsert;
export type NormalizedWorkspaceCreationRow = WorkspaceCreationRow & {
  id: SafeId<"workspace">;
};

type WorkspaceCreationOptions<T> = {
  tx: Parameters<typeof lockMatterStewardship>[0]["tx"];
  rows: readonly WorkspaceCreationRow[];
  /** Additional members granted assignments in this same creation batch. */
  candidateUserIds?: readonly string[] | undefined;
  insert: (rows: NormalizedWorkspaceCreationRow[]) => Promise<T>;
};

/**
 * The system creation boundary. Mint every ID and acquire the complete batch
 * prefix before any INSERT; callers cannot leave proof acquisition to a later
 * assignment. Scoped creation uses the same prefix inside stella_create_workspace.
 */
export const withWorkspaceCreation = async <T>({
  tx,
  rows,
  candidateUserIds = [],
  insert,
}: WorkspaceCreationOptions<T>): Promise<T> => {
  const normalized = rows.map((row) => ({
    ...row,
    id: row.id ?? createSafeId<"workspace">(),
  }));
  const groups = Map.groupBy(normalized, (row) => row.organizationId);
  await lockMatterStewardship({
    tx,
    requests: [...groups].map((group) => ({
      organizationId: group[0],
      workspaceIds: group[1].map((row) => row.id),
      userIds: [
        ...new Set([
          ...candidateUserIds,
          ...group[1].flatMap((row) =>
            row.leadUserId === null || row.leadUserId === undefined
              ? []
              : [row.leadUserId],
          ),
        ]),
      ],
    })),
    mode: "update",
  });
  return await insert(normalized);
};

type InsertWorkspaceRowsOptions = {
  tx: Pick<PgAsyncDatabase<PgQueryResultHKT>, "execute" | "insert">;
  rows: readonly WorkspaceCreationRow[];
  onConflict?: "ignore";
  candidateUserIds?: readonly string[] | undefined;
};

/** Root seeds and fixtures preserve their row shape through the creation owner. */
export const insertWorkspaceRowsInTransaction = async ({
  tx,
  rows,
  onConflict,
  candidateUserIds,
}: InsertWorkspaceRowsOptions) => {
  if (rows.length === 0) {
    return [];
  }
  return await withWorkspaceCreation({
    tx,
    rows,
    candidateUserIds,
    insert: async (normalized) => {
      // audit: skip - Application creators record audit events in their owning transaction; system seeds and fixtures are bootstrap data.
      const query = tx.insert(workspaces).values(normalized);
      return onConflict === "ignore"
        ? await query.onConflictDoNothing().returning()
        : await query.returning();
    },
  });
};
