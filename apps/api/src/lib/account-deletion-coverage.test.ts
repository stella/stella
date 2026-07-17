import { describe, expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

import * as authSchema from "@/api/db/auth-schema";
import * as schema from "@/api/db/schema";
import { ACCOUNT_DELETION_MANUAL_TABLES } from "@/api/lib/account-deletion-steps";

// ── Account-deletion FK coverage guard ──────────────────────────────────
//
// `verifyAndDeleteUser` (delete-account.ts) never hard-deletes the `user`
// row itself — it's a soft delete (anonymize + `deletedAt`). But every
// *other* table that references `user` needs an explicit decision: either
// the database cleans it up automatically (`onDelete: "cascade"` or
// `"set null"`), or a step in `account-deletion-steps.ts` deletes /
// reassigns / nulls the user's rows there, or the reference is
// deliberately retained forever (documented in
// `ACCOUNT_DELETION_KNOWN_GAPS` below).
//
// The risk this guards against: someone adds a new table with a foreign
// key to `user`, forgets to wire it into account deletion, and the table
// silently accumulates orphaned rows tied to deleted accounts. This test
// enumerates every direct FK to `user` from Drizzle's schema metadata (no
// live DB needed — see `getTableConfig`) and fails if a new, unhandled one
// shows up.

type UserForeignKey = {
  tableName: string;
  columnName: string;
  onDelete: string | undefined;
};

type KnownGap = {
  table: string;
  column: string;
  onDelete: string;
  /**
   * Why this FK is not (yet) covered by a deletion step. Every entry here
   * was a pre-existing state at the time this guard was introduced —
   * confirm with a human whether it's an intentional, permanent retention
   * (audit/billing/authorship-attribution records, following the "user row
   * retained for historical attribution" pattern documented in
   * delete-account.ts) before treating it as settled.
   */
  note: string;
};

/**
 * Tables with a direct FK to `user` that intentionally have no deletion
 * step and are not DB-cascaded. Each entry must still reference `user`
 * (checked below) so this list cannot silently accumulate stale rows for
 * tables that were fixed or renamed.
 *
 * TODO(account-deletion): every entry below needs a human decision — see
 * the final report of the PR that introduced this guard for full FK
 * details and a proposed classification per table. Either:
 *   (a) add a deletion/anonymization step in account-deletion-steps.ts and
 *       remove the entry here, or
 *   (b) confirm the retention is intentional and leave it here with a
 *       clear reason (already the case for all current entries).
 */
const ACCOUNT_DELETION_KNOWN_GAPS: readonly KnownGap[] = [
  {
    table: "account_deletion_requests",
    column: "user_id",
    onDelete: "restrict",
    note: "The account-deletion audit/tracking record itself, inserted by verifyAndDeleteUser in the same transaction it belongs to. Not user-owned data to purge — expected to persist referencing the (soft-deleted) user.",
  },
  {
    table: "case_law_matter_links",
    column: "linked_by",
    onDelete: "restrict",
    note: "Provenance of who linked a case-law citation to a matter (workspace-owned record, not personal data). Likely intentional per the historical-attribution pattern, unconfirmed.",
  },
  {
    table: "clauses",
    column: "created_by",
    onDelete: "restrict",
    note: "Clause authorship attribution (workspace-owned content). Likely intentional per the historical-attribution pattern, unconfirmed.",
  },
  {
    table: "playbook_definition_versions",
    column: "created_by",
    onDelete: "restrict",
    note: "Playbook version authorship attribution. Likely intentional per the historical-attribution pattern, unconfirmed.",
  },
  {
    table: "style_sets",
    column: "created_by",
    onDelete: "restrict",
    note: "Style set authorship attribution. Likely intentional per the historical-attribution pattern, unconfirmed.",
  },
  {
    table: "template_fills",
    column: "user_id",
    onDelete: "restrict",
    note: 'Template-fill usage record — schema comment marks the table "Template Fills (analytics)"; it holds counters, not document content. Likely intentional retention, unconfirmed.',
  },
  {
    table: "template_recipes",
    column: "created_by",
    onDelete: "restrict",
    note: "Template recipe authorship attribution. Likely intentional per the historical-attribution pattern, unconfirmed.",
  },
  {
    table: "template_versions",
    column: "created_by",
    onDelete: "restrict",
    note: "Template version authorship attribution. Likely intentional per the historical-attribution pattern, unconfirmed.",
  },
  {
    table: "templates",
    column: "created_by",
    onDelete: "restrict",
    note: "Template authorship attribution. Likely intentional per the historical-attribution pattern, unconfirmed.",
  },
  {
    table: "usage_events",
    column: "user_id",
    onDelete: "restrict",
    note: "Billing/usage-metering event, needed for invoicing and audit history — comparable to account_deletion_requests. Likely intentional retention, unconfirmed.",
  },
];

const gapKey = (table: string, column: string) => `${table}.${column}`;

const isAutoCoveredByDb = (onDelete: string | undefined): boolean =>
  onDelete === "cascade" || onDelete === "set null";

// `is()` is drizzle-orm's own runtime type guard (checks the entity-kind
// tag drizzle stamps on table instances), so this narrows `unknown` to
// `PgTable` without an unsafe type assertion.
const isPgTable = (value: unknown): value is PgTable => is(value, PgTable);

const allSchemaExports: Record<string, unknown> = {
  ...authSchema,
  ...schema,
};

const userTableName = getTableConfig(authSchema.user).name;

/**
 * Every direct foreign key in the schema whose referenced table is `user`.
 * Enumerated purely from Drizzle table metadata — no DB connection needed.
 */
const findUserForeignKeys = (): UserForeignKey[] => {
  const results: UserForeignKey[] = [];

  for (const value of Object.values(allSchemaExports)) {
    if (!isPgTable(value)) {
      continue;
    }

    const config = getTableConfig(value);
    for (const foreignKey of config.foreignKeys) {
      const reference = foreignKey.reference();
      const referencedTableName = getTableConfig(reference.foreignTable).name;
      if (referencedTableName !== userTableName) {
        continue;
      }

      for (const column of reference.columns) {
        results.push({
          tableName: config.name,
          columnName: column.name,
          onDelete: foreignKey.onDelete,
        });
      }
    }
  }

  return results;
};

describe("account deletion FK coverage", () => {
  test("enumeration finds at least the known user-referencing tables", () => {
    // Sanity check for the enumeration itself: if this ever finds zero FKs,
    // the schema walk below is broken (e.g. a schema barrel changed shape)
    // and every other assertion in this file would pass vacuously.
    const userForeignKeys = findUserForeignKeys();
    expect(userForeignKeys.length).toBeGreaterThan(30);
    expect(
      userForeignKeys.some(
        (fk) => fk.tableName === "session" && fk.columnName === "user_id",
      ),
    ).toBe(true);
  });

  test("every direct FK to the user table is DB-cascaded, manually handled, or a tracked known gap", () => {
    const userForeignKeys = findUserForeignKeys();
    const manualTableNames = new Set(
      ACCOUNT_DELETION_MANUAL_TABLES.map((table) => getTableConfig(table).name),
    );
    const knownGapKeys = new Set(
      ACCOUNT_DELETION_KNOWN_GAPS.map((gap) => gapKey(gap.table, gap.column)),
    );

    const uncovered = userForeignKeys.filter((fk) => {
      if (isAutoCoveredByDb(fk.onDelete)) {
        return false;
      }
      if (manualTableNames.has(fk.tableName)) {
        return false;
      }
      return !knownGapKeys.has(gapKey(fk.tableName, fk.columnName));
    });

    if (uncovered.length === 0) {
      return;
    }

    const details = uncovered
      .map(
        (fk) =>
          `  - table "${fk.tableName}" references user via FK column "${fk.columnName}" with onDelete: ${
            fk.onDelete ? `"${fk.onDelete}"` : "no action"
          }`,
      )
      .join("\n");

    throw new Error(
      `Found ${uncovered.length} table(s) with an unhandled foreign key to the user table:\n${details}\n\n` +
        "For each: add a deletion step in apps/api/src/lib/account-deletion-steps.ts " +
        "(call it from verifyAndDeleteUser in apps/api/src/lib/delete-account.ts), and list the " +
        "table in that step's `*_TABLES` constant so it is picked up by ACCOUNT_DELETION_MANUAL_TABLES. " +
        'If cascading/nulling the FK at the DB level is correct instead, change its onDelete to "cascade" ' +
        'or "set null" in the schema. If the reference should be permanently retained (e.g. an audit or ' +
        "billing record), add it to ACCOUNT_DELETION_KNOWN_GAPS in account-deletion-coverage.test.ts with a " +
        "documented reason instead of leaving it unhandled.",
    );
  });

  test("every table in ACCOUNT_DELETION_MANUAL_TABLES still has a foreign key to the user table", () => {
    const userForeignKeys = findUserForeignKeys();
    const tablesWithUserFk = new Set(userForeignKeys.map((fk) => fk.tableName));

    const staleEntries = ACCOUNT_DELETION_MANUAL_TABLES.filter(
      (table) => !tablesWithUserFk.has(getTableConfig(table).name),
    );

    if (staleEntries.length === 0) {
      return;
    }

    const names = staleEntries
      .map((table) => getTableConfig(table).name)
      .join(", ");
    throw new Error(
      `ACCOUNT_DELETION_MANUAL_TABLES lists table(s) [${names}] that no longer have a foreign ` +
        "key to the user table. Remove the stale entry from its step's `*_TABLES` constant in " +
        "account-deletion-steps.ts, or confirm the FK was intentionally dropped elsewhere.",
    );
  });

  test("ACCOUNT_DELETION_KNOWN_GAPS only lists FKs that are still actually uncovered", () => {
    const userForeignKeys = findUserForeignKeys();
    const manualTableNames = new Set(
      ACCOUNT_DELETION_MANUAL_TABLES.map((table) => getTableConfig(table).name),
    );

    const staleGaps = ACCOUNT_DELETION_KNOWN_GAPS.filter((gap) => {
      const stillUncovered = userForeignKeys.some(
        (fk) =>
          fk.tableName === gap.table &&
          fk.columnName === gap.column &&
          !isAutoCoveredByDb(fk.onDelete) &&
          !manualTableNames.has(fk.tableName),
      );
      return !stillUncovered;
    });

    if (staleGaps.length === 0) {
      return;
    }

    const names = staleGaps
      .map((gap) => gapKey(gap.table, gap.column))
      .join(", ");
    throw new Error(
      `ACCOUNT_DELETION_KNOWN_GAPS lists FK(s) [${names}] that are no longer uncovered gaps ` +
        "(the FK is now cascade/set-null, a manual step handles the table, or the FK no longer " +
        "exists). Remove the stale entry from ACCOUNT_DELETION_KNOWN_GAPS in " +
        "account-deletion-coverage.test.ts.",
    );
  });
});
