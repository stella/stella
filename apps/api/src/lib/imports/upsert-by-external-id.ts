import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { GetColumnData, SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

import type { Transaction } from "@/api/db/root";
import { contacts } from "@/api/db/schema";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { externalRefKey } from "@/api/lib/imports/external-ref";
import type { ExternalRef } from "@/api/lib/imports/external-ref";
import { enqueueContactSearchRepairs } from "@/api/lib/search/projection-repair-queue";

/**
 * Building blocks for an import that converges when re-run: a row carrying
 * an external ref is written with `INSERT ... ON CONFLICT` against the
 * table's `<table>_org_external_uidx`, so the second run updates the row the
 * first created when its change key differs. The key leads with `organization_id`, so a ref can only
 * ever match a row of the importing organization; callers run these inside
 * their scoped transaction, where RLS bounds the same rows again.
 *
 * Callers write the INSERT against their concrete table, which keeps the
 * values and the refreshed columns fully typed:
 *
 *   const conflict = externalRefConflict(contacts);
 *   tx.insert(contacts)
 *     .values(rows)
 *     .onConflictDoUpdate({
 *       target: conflict.target,
 *       targetWhere: conflict.targetWhere,
 *       set: { displayName: excluded(contacts.displayName), ... },
 *     })
 *     .returning({ id: contacts.id, outcome: upsertOutcome });
 */

type ExternalRefTable = PgTable & {
  id: AnyPgColumn;
  organizationId: AnyPgColumn;
  externalSource: AnyPgColumn;
  externalId: AnyPgColumn;
  externalChangeKey: AnyPgColumn;
};

/** The arbiter of an external-ref upsert: the partial unique index. */
const externalRefConflict = (table: ExternalRefTable) => ({
  target: [table.organizationId, table.externalSource, table.externalId],
  targetWhere: isNotNull(table.externalId),
  setWhere: sql`${table.externalChangeKey} IS DISTINCT FROM ${excluded(table.externalChangeKey)}`,
});

/** The incoming row's value for `column`, for an upsert's `set`. */
const excluded = (column: AnyPgColumn): SQL =>
  sql`excluded.${sql.identifier(column.name)}`;

const UPSERT_OUTCOMES = ["created", "updated"] as const;
type UpsertOutcome = (typeof UPSERT_OUTCOMES)[number];

/**
 * Whether the upsert inserted or updated the returned row. An inserted
 * tuple has no deleting transaction yet (`xmax = 0`); the conflict update
 * stamps its own.
 */
const upsertOutcome = sql<UpsertOutcome>`CASE WHEN xmax = 0 THEN 'created' ELSE 'updated' END`;

type ReadExternalRefIdsOptions<TTable extends ExternalRefTable> = {
  tx: Transaction;
  table: TTable;
  organizationId: SafeId<"organization">;
  refs: readonly ExternalRef[];
};

/**
 * Ids of the organization's rows that already carry one of `refs`, keyed by
 * `externalRefKey`. One indexed read for the whole batch, so a caller can
 * tell an update from a create before applying per-row rules (capacity,
 * duplicate checks) that only a create should consume.
 */
export const readExternalRefIds = async <TTable extends ExternalRefTable>({
  tx,
  table,
  organizationId,
  refs,
}: ReadExternalRefIdsOptions<TTable>): Promise<
  Map<string, GetColumnData<TTable["id"]>>
> => {
  const ids = new Map<string, GetColumnData<TTable["id"]>>();
  if (refs.length === 0) {
    return ids;
  }
  // The selected id keeps its concrete column type; FROM only needs the
  // table identity, without Drizzle's unresolved generic selection check.
  const queryTable: PgTable = table;
  const rows = await tx
    // The tuple IN predicate never matches a NULL ref, so both are text.
    .select({
      id: sql<GetColumnData<TTable["id"]>>`${table.id}`,
      source: sql<string>`${table.externalSource}`,
      externalId: sql<string>`${table.externalId}`,
    })
    .from(queryTable)
    .where(
      and(
        eq(table.organizationId, organizationId),
        sql`(${table.externalSource}, ${table.externalId}) IN (${sql.join(
          refs.map(({ source, id }) => sql`(${source}, ${id})`),
          sql`, `,
        )})`,
      ),
    );
  for (const row of rows) {
    ids.set(externalRefKey({ source: row.source, id: row.externalId }), row.id);
  }
  return ids;
};

type ExternalRefValuesOptions = {
  external: ExternalRef | null;
  externalChangeKey: string;
  importedAt: Date;
};

export const externalRefValues = ({
  external,
  externalChangeKey,
  importedAt,
}: ExternalRefValuesOptions) => ({
  externalSource: external?.source,
  externalId: external?.id,
  externalChangeKey: external === null ? undefined : externalChangeKey,
  importedAt: external === null ? undefined : importedAt,
});

type ImportedContactValues = typeof contacts.$inferInsert & {
  id: SafeId<"contact">;
};

type WriteImportedContactsOptions = {
  tx: Transaction;
  recordAuditEvent: AuditRecorder;
  importRequestId: SafeId<"contactImportRequest">;
  newRows: ImportedContactValues[];
  updateRows: ImportedContactValues[];
  importedAt: Date;
};

/** The caller holds the organization capacity fence through planning and writing. */
export const writeImportedContacts = async ({
  tx,
  recordAuditEvent,
  importRequestId,
  newRows,
  updateRows,
  importedAt,
}: WriteImportedContactsOptions) => {
  const written = {
    id: contacts.id,
    type: contacts.type,
    displayName: contacts.displayName,
  };
  const inserted =
    newRows.length === 0
      ? []
      : await tx
          .insert(contacts)
          .values(newRows)
          .onConflictDoNothing()
          .returning(written);
  const conflict = externalRefConflict(contacts);
  const upserted =
    updateRows.length === 0
      ? []
      : await tx
          .insert(contacts)
          .values(updateRows)
          .onConflictDoUpdate({
            target: conflict.target,
            targetWhere: conflict.targetWhere,
            setWhere: conflict.setWhere,
            set: {
              externalChangeKey: excluded(contacts.externalChangeKey),
              importedAt: excluded(contacts.importedAt),
              type: excluded(contacts.type),
              displayName: excluded(contacts.displayName),
              prefix: excluded(contacts.prefix),
              firstName: excluded(contacts.firstName),
              middleName: excluded(contacts.middleName),
              lastName: excluded(contacts.lastName),
              suffix: excluded(contacts.suffix),
              organizationName: excluded(contacts.organizationName),
              notes: excluded(contacts.notes),
              emails: excluded(contacts.emails),
              phones: excluded(contacts.phones),
              addresses: excluded(contacts.addresses),
              tags: excluded(contacts.tags),
              registrationNumber: excluded(contacts.registrationNumber),
              taxId: excluded(contacts.taxId),
              vatId: excluded(contacts.vatId),
              dateOfBirthYear: excluded(contacts.dateOfBirthYear),
              dateOfBirthMonth: excluded(contacts.dateOfBirthMonth),
              dateOfBirthDay: excluded(contacts.dateOfBirthDay),
              nationalityCodes: excluded(contacts.nationalityCodes),
              metadata: sql`COALESCE(${contacts.metadata}, '{}'::jsonb) || COALESCE(${excluded(contacts.metadata)}, '{}'::jsonb)`,
              updatedAt: importedAt,
            },
          })
          .returning({ ...written, outcome: upsertOutcome });
  const changed = [
    ...inserted.map((row) => ({ ...row, outcome: "created" as const })),
    ...upserted,
  ];
  const auditEvents = changed.map((contact) => ({
    action:
      contact.outcome === "created" ? AUDIT_ACTION.CREATE : AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.CONTACT,
    resourceId: contact.id,
    workspaceId: null,
    changes: {
      [contact.outcome === "created" ? "created" : "imported"]: {
        old: null,
        new: { type: contact.type, displayName: contact.displayName },
      },
    },
    metadata: { source: "import", importRequestId },
  })) satisfies AuditEvent[];
  if (auditEvents.length > 0) {
    await recordAuditEvent(tx, auditEvents);
    await enqueueContactSearchRepairs(
      tx,
      auditEvents.map(({ resourceId }) => resourceId),
    );
  }
  const updatedById = new Map(upserted.map((row) => [row.id, row]));
  return [
    ...inserted.map((row) => ({ ...row, outcome: "created" as const })),
    ...updateRows.map(
      (row) =>
        updatedById.get(row.id) ?? {
          id: row.id,
          type: row.type,
          displayName: row.displayName,
          outcome: "unchanged" as const,
        },
    ),
  ];
};
