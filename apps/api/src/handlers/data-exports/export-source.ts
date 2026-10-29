// The database and object-store side of an organisation data export.
//
// Every read runs through the requester's membership-scoped handle: for an
// organisation owner or admin, RLS (`stella_authorized_workspaces`) admits
// every client matter of the organisation plus the requester's own personal
// matters, and nothing of another organisation. The export therefore never
// needs a row-level-security bypass.
//
// Personal matters (no client) are never exported: an organisation export
// is visible to every owner and admin, and a personal matter belongs to one
// member. `isOrganizationMatter` is applied to every matter read.
//
// The export is low-priority work, so it reads gently: every query is one
// keyset page (by id, on an indexed tenant column) in its own short
// transaction, child rows are read for one page of parents at a time, and
// `pace()` runs between pages. Nothing holds a lock or a long transaction.
// File bytes are streamed, never read whole.

import { panic } from "better-result";
import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  clauseCategories,
  clauses,
  clauseVariants,
  clauseVersions,
  contactRelationships,
  contacts,
  entities,
  entityVersions,
  expenses,
  fields,
  invoiceLines,
  invoicePayments,
  invoices,
  sellerProfiles,
  taskAssignees,
  templateCategories,
  templates,
  templateVersions,
  timeEntries,
  workspaceContacts,
  workspaces,
} from "@/api/db/schema";
import { int8ToSafeNumber } from "@/api/db/sql-client";
import type {
  ExportFileRef,
  ExportSource,
  FileRead,
  RecordBytes,
  RecordTable,
  SourceDocument,
  SourceDocumentFile,
  SourceMatter,
  SourceMatterSummary,
  SourceOrganizationRecords,
  SourceTemplateFile,
} from "@/api/handlers/data-exports/build-export";
import type { DataExportVersionScope } from "@/api/handlers/data-exports/manifest-schema";
import { dataExportRecordScope } from "@/api/handlers/data-exports/record-scopes";
import {
  CLAUSE_CATEGORY_COLUMNS,
  CLAUSE_COLUMNS,
  CLAUSE_VARIANT_COLUMNS,
  CLAUSE_VERSION_COLUMNS,
  CONTACT_COLUMNS,
  CONTACT_RELATIONSHIP_COLUMNS,
  EXPENSE_COLUMNS,
  exportedColumnNames,
  INVOICE_COLUMNS,
  INVOICE_LINE_COLUMNS,
  INVOICE_PAYMENT_COLUMNS,
  MATTER_COLUMNS,
  MATTER_CONTACT_COLUMNS,
  projectRecord,
  SELLER_PROFILE_COLUMNS,
  TASK_ASSIGNEE_COLUMNS,
  TASK_COLUMNS,
  TEMPLATE_CATEGORY_COLUMNS,
  TEMPLATE_COLUMNS,
  TEMPLATE_VERSION_COLUMNS,
  TIME_ENTRY_COLUMNS,
} from "@/api/handlers/data-exports/records";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { createFileKey } from "@/api/lib/files/utils";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { openS3ObjectStream } from "@/api/lib/s3";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";

const dataExportReadFileFailed = failureSink({
  event: "data_export.read_file",
  expected: [],
});

/** Rows per query: small enough that each transaction is brief. */
const DATA_EXPORT_PAGE_SIZE = 500;

const FOLDER_KIND = "folder";
const TASK_KIND = "task";
const DELETING_STATUS = "deleting";

const groupBy = <T>(rows: readonly T[], key: (row: T) => string) => {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = grouped.get(k);
    if (list === undefined) {
      grouped.set(k, [row]);
      continue;
    }
    list.push(row);
  }
  return grouped;
};

const table = (
  map: Readonly<Record<string, "export" | "omit">>,
  rows: readonly Record<string, unknown>[],
  extra: (row: Record<string, unknown>) => Record<string, unknown> = () => ({}),
): RecordTable => ({
  columns: exportedColumnNames(map),
  rows: rows.map((row) => ({ ...projectRecord(row, map), ...extra(row) })),
});

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
};

/** Client matters only: personal matters stay out of organisation exports. */
const isOrganizationMatter = isNotNull(workspaces.clientId);

// Keyset condition on a uuid id column; the cursor is the last id read.
const after = (column: AnyColumn, afterId: string | null) =>
  afterId === null ? undefined : sql<boolean>`${column} > ${afterId}`;

type PagedReader = {
  db: ScopedDb;
  organizationId: SafeId<"organization">;
  /**
   * Every row of a keyset query, one page per short transaction.
   * `readPage` must order by the id it pages on and apply the page limit.
   */
  readAll: <Row extends { id: string }>(
    readPage: (afterId: string | null) => Promise<Row[]>,
  ) => Promise<Row[]>;
  /** Child rows for many parents, one bounded `IN` list at a time. */
  readForParents: <Id, Row>(
    parentIds: readonly Id[],
    readChunk: (ids: Id[]) => Promise<Row[]>,
  ) => Promise<Row[]>;
};

type CreateExportSourceArgs = {
  db: ScopedDb;
  organizationId: SafeId<"organization">;
  signal: AbortSignal;
  /** Awaited between database pages. */
  pace: () => Promise<void>;
};

const createPagedReader = ({
  db,
  organizationId,
  signal,
  pace,
}: CreateExportSourceArgs): PagedReader => ({
  db,
  organizationId,
  readAll: async (readPage) => {
    const rows: Awaited<ReturnType<typeof readPage>> = [];
    let afterId: string | null = null;
    for (;;) {
      signal.throwIfAborted();
      // Keyset pages are sequential by design, each in its own short transaction; the loop ends at the first short page
      const page = await readPage(afterId);
      rows.push(...page);
      const last = page.at(-1);
      if (page.length < DATA_EXPORT_PAGE_SIZE || last === undefined) {
        return rows;
      }
      afterId = last.id;
      await pace();
    }
  },
  readForParents: async (parentIds, readChunk) => {
    const rows: Awaited<ReturnType<typeof readChunk>> = [];
    for (const ids of chunk(parentIds, DATA_EXPORT_PAGE_SIZE)) {
      signal.throwIfAborted();
      // One bounded child read per parent page, sequential to keep load low
      rows.push(...(await readChunk(ids)));
      await pace();
    }
    return rows;
  },
});

const listMatters = async (
  { db, organizationId, readAll, readForParents }: PagedReader,
  scope: DataExportVersionScope,
): Promise<SourceMatterSummary[]> => {
  const readMatterRowsPage = async (cursor: string | null) =>
    await db(
      async (tx) =>
        await tx
          .select({
            id: workspaces.id,
            name: workspaces.name,
            reference: workspaces.reference,
            status: workspaces.status,
            createdAt: workspaces.createdAt,
          })
          .from(workspaces)
          .where(
            and(
              eq(workspaces.organizationId, organizationId),
              ne(workspaces.status, DELETING_STATUS),
              isOrganizationMatter,
              after(workspaces.id, cursor),
            ),
          )
          .orderBy(asc(workspaces.id))
          .limit(DATA_EXPORT_PAGE_SIZE),
    );
  const matterRows = await readAll(readMatterRowsPage);
  const fileBytes = sql<number>`COALESCE(SUM((${fields.content}->>'sizeBytes')::bigint), 0)::bigint`;
  const sizeRows = await readForParents(
    matterRows.map((row) => row.id),
    async (ids) =>
      await db(
        async (tx) =>
          await tx
            .select({
              workspaceId: fields.workspaceId,
              bytes: fileBytes.mapWith(Number),
            })
            .from(fields)
            .innerJoin(
              entityVersions,
              and(
                eq(entityVersions.id, fields.entityVersionId),
                eq(entityVersions.workspaceId, fields.workspaceId),
              ),
            )
            .innerJoin(
              entities,
              and(
                eq(entities.id, entityVersions.entityId),
                eq(entities.workspaceId, entityVersions.workspaceId),
              ),
            )
            .where(
              and(
                inArray(fields.workspaceId, ids),
                isNull(entityVersions.deletedAt),
                inArray(entities.kind, ["document", "message"]),
                // Sized for what the export will carry.
                scope === "current"
                  ? eq(entities.currentVersionId, entityVersions.id)
                  : undefined,
                sql`${fields.content}->>'type' = 'file'`,
              ),
            )
            .groupBy(fields.workspaceId),
      ),
  );
  const bytesByMatter = new Map(
    sizeRows.map((row) => [String(row.workspaceId), row.bytes]),
  );
  return matterRows.map((row) => ({
    ...row,
    id: String(row.id),
    estimatedBytes: bytesByMatter.get(String(row.id)) ?? 0,
  }));
};

/** Folders, documents with their versions and file fields, and tasks. */
const readMatterEntities = async (
  { db, readAll, readForParents }: PagedReader,
  workspaceId: SafeId<"workspace">,
  scope: DataExportVersionScope,
) => {
  const readEntityRowsPage = async (cursor: string | null) =>
    await db(
      async (tx) =>
        await tx
          .select()
          .from(entities)
          .where(
            and(
              eq(entities.workspaceId, workspaceId),
              after(entities.id, cursor),
            ),
          )
          .orderBy(asc(entities.id))
          .limit(DATA_EXPORT_PAGE_SIZE),
    );
  const entityRows = await readAll(readEntityRowsPage);
  const documentRows = entityRows.filter(
    (row) => row.kind === "document" || row.kind === "message",
  );
  const currentVersionIds = new Set(
    documentRows.flatMap((row) =>
      row.currentVersionId === null ? [] : [String(row.currentVersionId)],
    ),
  );
  const versionRows = await readForParents(
    documentRows.map((row) => row.id),
    async (entityIds) =>
      await db(
        async (tx) =>
          await tx
            .select({
              id: entityVersions.id,
              entityId: entityVersions.entityId,
              versionNumber: entityVersions.versionNumber,
              stamp: entityVersions.stamp,
              label: entityVersions.label,
              description: entityVersions.description,
              createdAt: entityVersions.createdAt,
              createdBy: entityVersions.createdBy,
            })
            .from(entityVersions)
            .where(
              and(
                eq(entityVersions.workspaceId, workspaceId),
                inArray(entityVersions.entityId, entityIds),
                isNull(entityVersions.deletedAt),
              ),
            ),
      ),
  );
  const exportedVersions =
    scope === "current"
      ? versionRows.filter((row) => currentVersionIds.has(String(row.id)))
      : versionRows;
  const fileRows = await readForParents(
    exportedVersions.map((row) => row.id),
    async (versionIds) =>
      await db(
        async (tx) =>
          await tx
            .select({
              id: fields.id,
              entityVersionId: fields.entityVersionId,
              content: fields.content,
            })
            .from(fields)
            .where(
              and(
                eq(fields.workspaceId, workspaceId),
                inArray(fields.entityVersionId, versionIds),
                sql`${fields.content}->>'type' = 'file'`,
              ),
            ),
      ),
  );
  return { entityRows, documentRows, exportedVersions, fileRows };
};

/** Contact links, task assignees and time entries for one matter. */
const readMatterRecords = async (
  { db, organizationId, readAll, readForParents }: PagedReader,
  workspaceId: SafeId<"workspace">,
  taskIds: readonly SafeId<"entity">[],
) => {
  const readContactLinksPage = async (cursor: string | null) =>
    await db(
      async (tx) =>
        await tx
          .select({
            id: workspaceContacts.id,
            link: workspaceContacts,
            displayName: contacts.displayName,
          })
          .from(workspaceContacts)
          .innerJoin(contacts, eq(contacts.id, workspaceContacts.contactId))
          .where(
            and(
              eq(workspaceContacts.workspaceId, workspaceId),
              after(workspaceContacts.id, cursor),
            ),
          )
          .orderBy(asc(workspaceContacts.id))
          .limit(DATA_EXPORT_PAGE_SIZE),
    );
  const contactLinks = await readAll(readContactLinksPage);
  const assignees = await readForParents(
    taskIds,
    async (ids) =>
      await db(
        async (tx) =>
          await tx
            .select()
            .from(taskAssignees)
            .where(
              and(
                eq(taskAssignees.workspaceId, workspaceId),
                inArray(taskAssignees.entityId, ids),
              ),
            ),
      ),
  );
  const readTimeEntryRowsPage = async (cursor: string | null) =>
    await db(
      async (tx) =>
        await tx
          .select()
          .from(timeEntries)
          .where(
            and(
              eq(timeEntries.organizationId, organizationId),
              dataExportRecordScope(timeEntries, workspaceId),
              after(timeEntries.id, cursor),
            ),
          )
          .orderBy(asc(timeEntries.id))
          .limit(DATA_EXPORT_PAGE_SIZE),
    );
  const timeEntryRows = await readAll(readTimeEntryRowsPage);
  const expenseRows = await readAll(
    async (cursor) =>
      await db(
        async (tx) =>
          await tx
            .select()
            .from(expenses)
            .where(
              and(
                eq(expenses.organizationId, organizationId),
                dataExportRecordScope(expenses, workspaceId),
                after(expenses.id, cursor),
              ),
            )
            .orderBy(asc(expenses.id))
            .limit(DATA_EXPORT_PAGE_SIZE),
      ),
  );
  return { contactLinks, assignees, timeEntryRows, expenseRows };
};

/** Invoice children follow the selected invoice, including lines billed across matters. */
const readInvoiceRecords = async (
  { db, organizationId, readAll, readForParents }: PagedReader,
  workspaceId: SafeId<"workspace"> | null,
) => {
  const readInvoiceRowsPage = async (cursor: string | null) =>
    await db(
      async (tx) =>
        await tx
          .select()
          .from(invoices)
          .where(
            and(
              eq(invoices.organizationId, organizationId),
              dataExportRecordScope(invoices, workspaceId),
              after(invoices.id, cursor),
            ),
          )
          .orderBy(asc(invoices.id))
          .limit(DATA_EXPORT_PAGE_SIZE),
    );
  const invoiceRows = await readAll(readInvoiceRowsPage);
  const lineRows = await readForParents(
    invoiceRows.map((row) => row.id),
    async (invoiceIds) =>
      await db(
        async (tx) =>
          await tx
            .select()
            .from(invoiceLines)
            .where(
              and(
                eq(invoiceLines.organizationId, organizationId),
                inArray(invoiceLines.invoiceId, invoiceIds),
              ),
            ),
      ),
  );
  const paymentRows = await readForParents(
    invoiceRows.map((row) => row.id),
    async (invoiceIds) =>
      await db(
        async (tx) =>
          await tx
            .select()
            .from(invoicePayments)
            .where(
              and(
                eq(invoicePayments.organizationId, organizationId),
                inArray(invoicePayments.invoiceId, invoiceIds),
              ),
            ),
      ),
  );
  return { invoiceRows, lineRows, paymentRows };
};

const invoiceRecords = (
  records: Awaited<ReturnType<typeof readInvoiceRecords>>,
) => {
  const lines = groupBy(
    records.lineRows.toSorted((a, b) => a.position - b.position),
    (row) => row.invoiceId,
  );
  const payments = groupBy(
    records.paymentRows.toSorted((a, b) => compareCodeUnit(a.id, b.id)),
    (row) => row.invoiceId,
  );
  return table(INVOICE_COLUMNS, records.invoiceRows, (row) => ({
    lines: arrayOrEmpty(lines.get(String(row["id"]))).map((line) =>
      projectRecord(line, INVOICE_LINE_COLUMNS),
    ),
    payments: arrayOrEmpty(payments.get(String(row["id"]))).map((payment) =>
      projectRecord(payment, INVOICE_PAYMENT_COLUMNS),
    ),
  }));
};

type MatterEntityRows = Awaited<ReturnType<typeof readMatterEntities>>;

const assembleDocuments = ({
  documentRows,
  exportedVersions,
  fileRows,
}: MatterEntityRows): SourceDocument[] => {
  const files = fileRows
    .toSorted((a, b) => (a.id < b.id ? -1 : 1))
    .flatMap((row) =>
      row.content.type === "file"
        ? [
            {
              versionId: String(row.entityVersionId),
              file: {
                fieldId: String(row.id),
                fileId: row.content.id,
                fileName: row.content.fileName,
                mimeType: row.content.mimeType,
                sizeBytes: row.content.sizeBytes,
                sha256: row.content.sha256Hex,
              } satisfies SourceDocumentFile,
            },
          ]
        : [],
    );
  const filesByVersion = groupBy(files, (entry) => entry.versionId);
  const versionsByEntity = groupBy(exportedVersions, (row) =>
    String(row.entityId),
  );
  const documents: SourceDocument[] = [];
  for (const row of documentRows) {
    if (row.kind !== "document" && row.kind !== "message") {
      continue;
    }
    documents.push({
      id: String(row.id),
      kind: row.kind,
      parentId: row.parentId === null ? null : String(row.parentId),
      name: row.name,
      docSequence: row.docSequence,
      currentVersionId:
        row.currentVersionId === null ? null : String(row.currentVersionId),
      createdAt: row.createdAt,
      createdBy: row.createdBy,
      updatedAt: row.updatedAt,
      lastEditedBy: row.lastEditedBy,
      versions: arrayOrEmpty(versionsByEntity.get(String(row.id))).map(
        (version) => ({
          id: String(version.id),
          versionNumber: version.versionNumber,
          stamp: version.stamp,
          label: version.label,
          description: version.description,
          createdAt: version.createdAt,
          createdBy: version.createdBy,
          files: arrayOrEmpty(filesByVersion.get(String(version.id))).map(
            (entry) => entry.file,
          ),
        }),
      ),
    });
  }
  return documents;
};

const loadMatter = async (
  reader: PagedReader,
  matterId: string,
  scope: DataExportVersionScope,
): Promise<SourceMatter | null> => {
  const workspaceId = brandPersistedWorkspaceId(matterId);
  const matterRows = await reader.db(
    async (tx) =>
      await tx
        .select()
        .from(workspaces)
        .where(
          and(
            eq(workspaces.organizationId, reader.organizationId),
            eq(workspaces.id, workspaceId),
            ne(workspaces.status, DELETING_STATUS),
            isOrganizationMatter,
          ),
        ),
  );
  const matter = matterRows.at(0);
  if (matter === undefined) {
    return null;
  }
  const entityRows = await readMatterEntities(reader, workspaceId, scope);
  const taskRows = entityRows.entityRows.filter(
    (row) => row.kind === TASK_KIND,
  );
  const records = await readMatterRecords(
    reader,
    workspaceId,
    taskRows.map((row) => row.id),
  );
  const assigneesByTask = groupBy(records.assignees, (row) =>
    String(row.entityId),
  );
  const billing = await readInvoiceRecords(reader, workspaceId);
  return {
    summary: {
      id: String(matter.id),
      name: matter.name,
      reference: matter.reference,
      status: matter.status,
      createdAt: matter.createdAt,
      estimatedBytes: entityRows.fileRows.reduce(
        (sum, row) =>
          sum + (row.content.type === "file" ? row.content.sizeBytes : 0),
        0,
      ),
    },
    record: {
      ...projectRecord(matter, MATTER_COLUMNS),
      contacts: records.contactLinks.map(({ link, displayName }) => ({
        ...projectRecord(link, MATTER_CONTACT_COLUMNS),
        displayName,
      })),
    },
    folders: entityRows.entityRows
      .filter((row) => row.kind === FOLDER_KIND)
      .map((row) => ({
        id: String(row.id),
        parentId: row.parentId === null ? null : String(row.parentId),
        name: row.name,
      })),
    documents: assembleDocuments(entityRows),
    tasks: table(TASK_COLUMNS, taskRows, (row) => ({
      assignees: arrayOrEmpty(assigneesByTask.get(String(row["id"]))).map(
        (assignee) => projectRecord(assignee, TASK_ASSIGNEE_COLUMNS),
      ),
    })),
    timeEntries: table(TIME_ENTRY_COLUMNS, records.timeEntryRows),
    expenses: table(EXPENSE_COLUMNS, records.expenseRows),
    invoices: invoiceRecords(billing),
  };
};

type ScopedTransaction = Parameters<Parameters<ScopedDb>[0]>[0];

/** One organisation-scoped table, every row, paged by id. */
const readOrganizationTable = async <Row extends { id: string }>(
  { db, readAll }: PagedReader,
  readPage: (tx: ScopedTransaction, afterId: string | null) => Promise<Row[]>,
): Promise<Row[]> =>
  await readAll(
    async (afterId) => await db(async (tx) => await readPage(tx, afterId)),
  );

const readOrganizationReferenceRows = async (reader: PagedReader) => {
  const { organizationId } = reader;
  const sellerProfilesRows = await readOrganizationTable(
    reader,
    async (tx, cursor) =>
      await tx
        .select()
        .from(sellerProfiles)
        .where(
          and(
            eq(sellerProfiles.organizationId, organizationId),
            after(sellerProfiles.id, cursor),
          ),
        )
        .orderBy(asc(sellerProfiles.id))
        .limit(DATA_EXPORT_PAGE_SIZE),
  );
  const clauseCategoriesRows = await readOrganizationTable(
    reader,
    async (tx, cursor) =>
      await tx
        .select()
        .from(clauseCategories)
        .where(
          and(
            eq(clauseCategories.organizationId, organizationId),
            after(clauseCategories.id, cursor),
          ),
        )
        .orderBy(asc(clauseCategories.id))
        .limit(DATA_EXPORT_PAGE_SIZE),
  );
  const templateCategoriesRows = await readOrganizationTable(
    reader,
    async (tx, cursor) =>
      await tx
        .select()
        .from(templateCategories)
        .where(
          and(
            eq(templateCategories.organizationId, organizationId),
            after(templateCategories.id, cursor),
          ),
        )
        .orderBy(asc(templateCategories.id))
        .limit(DATA_EXPORT_PAGE_SIZE),
  );
  return { sellerProfilesRows, clauseCategoriesRows, templateCategoriesRows };
};

const readOrganizationRows = async (reader: PagedReader) => {
  const { organizationId } = reader;
  const readContactRowsPage = async (
    tx: ScopedTransaction,
    cursor: string | null,
  ) =>
    await tx
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.organizationId, organizationId),
          after(contacts.id, cursor),
        ),
      )
      .orderBy(asc(contacts.id))
      .limit(DATA_EXPORT_PAGE_SIZE);
  const contactRows = await readOrganizationTable(reader, readContactRowsPage);
  const readRelationshipRowsPage = async (
    tx: ScopedTransaction,
    cursor: string | null,
  ) =>
    await tx
      .select()
      .from(contactRelationships)
      .where(
        and(
          eq(contactRelationships.organizationId, organizationId),
          after(contactRelationships.id, cursor),
        ),
      )
      .orderBy(asc(contactRelationships.id))
      .limit(DATA_EXPORT_PAGE_SIZE);
  const relationshipRows = await readOrganizationTable(
    reader,
    readRelationshipRowsPage,
  );
  const readClauseRowsPage = async (
    tx: ScopedTransaction,
    cursor: string | null,
  ) =>
    await tx
      .select()
      .from(clauses)
      .where(
        and(
          eq(clauses.organizationId, organizationId),
          after(clauses.id, cursor),
        ),
      )
      .orderBy(asc(clauses.id))
      .limit(DATA_EXPORT_PAGE_SIZE);
  const clauseRows = await readOrganizationTable(reader, readClauseRowsPage);
  const readTemplateRowsPage = async (
    tx: ScopedTransaction,
    cursor: string | null,
  ) =>
    await tx
      .select()
      .from(templates)
      .where(
        and(
          eq(templates.organizationId, organizationId),
          after(templates.id, cursor),
        ),
      )
      .orderBy(asc(templates.id))
      .limit(DATA_EXPORT_PAGE_SIZE);
  const templateRows = await readOrganizationTable(
    reader,
    readTemplateRowsPage,
  );
  const readUnassignedRowsPage = async (
    tx: ScopedTransaction,
    cursor: string | null,
  ) =>
    await tx
      .select()
      .from(timeEntries)
      .where(
        and(
          eq(timeEntries.organizationId, organizationId),
          dataExportRecordScope(timeEntries, null),
          after(timeEntries.id, cursor),
        ),
      )
      .orderBy(asc(timeEntries.id))
      .limit(DATA_EXPORT_PAGE_SIZE);
  const unassignedRows = await readOrganizationTable(
    reader,
    readUnassignedRowsPage,
  );
  return {
    contactRows,
    relationshipRows,
    clauseRows,
    templateRows,
    unassignedRows,
  };
};

const readOrganizationChildren = async (
  { db, organizationId, readForParents }: PagedReader,
  clauseIds: readonly SafeId<"clause">[],
  templateIds: readonly SafeId<"template">[],
) => {
  const clauseVersionRows = await readForParents(
    clauseIds,
    async (ids) =>
      await db(
        async (tx) =>
          await tx
            .select()
            .from(clauseVersions)
            .where(
              and(
                eq(clauseVersions.organizationId, organizationId),
                inArray(clauseVersions.clauseId, ids),
              ),
            ),
      ),
  );
  const clauseVariantRows = await readForParents(
    clauseIds,
    async (ids) =>
      await db(
        async (tx) =>
          await tx
            .select()
            .from(clauseVariants)
            .where(
              and(
                eq(clauseVariants.organizationId, organizationId),
                inArray(clauseVariants.clauseId, ids),
              ),
            ),
      ),
  );
  const templateVersionRows = await readForParents(
    templateIds,
    async (ids) =>
      await db(
        async (tx) =>
          await tx
            .select()
            .from(templateVersions)
            .where(
              and(
                eq(templateVersions.organizationId, organizationId),
                inArray(templateVersions.templateId, ids),
              ),
            ),
      ),
  );
  return {
    clauseVersionRows: clauseVersionRows.toSorted(
      (a, b) => a.version - b.version,
    ),
    clauseVariantRows: clauseVariantRows.toSorted(
      (a, b) => a.sortOrder - b.sortOrder,
    ),
    templateVersionRows: templateVersionRows.toSorted(
      (a, b) => a.version - b.version,
    ),
  };
};

// Expanded text size of a row. Unlike the stored size, which is compressed,
// it tracks what loading and serialising the row costs.
const expandedTextBytes = (recordTable: PgTable) =>
  sql`octet_length(${recordTable}.*::text)`;

// Sizes come back as bigint text so no byte count is rounded on the way.
const OrganizationBytesRow = v.object({ bytes: v.string() });
const MatterBytesRow = v.object({
  workspace_id: v.string(),
  bytes: v.string(),
});

const measureRecords = async (
  { db, organizationId, readForParents }: PagedReader,
  matterIds: readonly string[],
): Promise<RecordBytes> => {
  // What `loadOrganizationRecords` reads, summed over its tables in one query.
  const organizationTables: readonly (readonly [PgTable, SQL | undefined])[] = [
    [
      invoices,
      and(
        eq(invoices.organizationId, organizationId),
        dataExportRecordScope(invoices, null),
      ),
    ],
    ...[invoiceLines, invoicePayments].map(
      (child) =>
        [
          child,
          and(
            eq(child.organizationId, organizationId),
            sql`EXISTS (SELECT 1 FROM ${invoices} WHERE ${invoices.id} = ${child.invoiceId} AND ${invoices.organizationId} = ${organizationId} AND ${dataExportRecordScope(invoices, null)})`,
          ),
        ] as const,
    ),
    [sellerProfiles, eq(sellerProfiles.organizationId, organizationId)],
    [clauseCategories, eq(clauseCategories.organizationId, organizationId)],
    [templateCategories, eq(templateCategories.organizationId, organizationId)],
    [contacts, eq(contacts.organizationId, organizationId)],
    [
      contactRelationships,
      eq(contactRelationships.organizationId, organizationId),
    ],
    [clauses, eq(clauses.organizationId, organizationId)],
    [clauseVersions, eq(clauseVersions.organizationId, organizationId)],
    [clauseVariants, eq(clauseVariants.organizationId, organizationId)],
    [templates, eq(templates.organizationId, organizationId)],
    [templateVersions, eq(templateVersions.organizationId, organizationId)],
    [
      timeEntries,
      and(
        eq(timeEntries.organizationId, organizationId),
        dataExportRecordScope(timeEntries, null),
      ),
    ],
  ];
  const organizationSum = sql.join(
    organizationTables.map(
      ([recordTable, where]) =>
        sql`(SELECT COALESCE(SUM(${expandedTextBytes(recordTable)}), 0) FROM ${recordTable} WHERE ${where ?? sql`true`})`,
    ),
    sql` + `,
  );
  const organizationRow = v.parse(
    OrganizationBytesRow,
    executedRows(
      await db(
        async (tx) =>
          await tx.execute(
            sql`SELECT (${organizationSum})::bigint::text AS bytes`,
          ),
      ),
    ).at(0),
  );
  const organizationBytes = int8ToSafeNumber(organizationRow.bytes);
  // What `loadMatter` reads, grouped by matter: one query per page of
  // matters over all of its tables.
  const matterTables: readonly (readonly [PgTable, PgColumn])[] = [
    [entities, entities.workspaceId],
    [entityVersions, entityVersions.workspaceId],
    [fields, fields.workspaceId],
    [taskAssignees, taskAssignees.workspaceId],
    [workspaceContacts, workspaceContacts.workspaceId],
    [timeEntries, timeEntries.workspaceId],
    [expenses, expenses.workspaceId],
    [invoices, invoices.workspaceId],
  ];
  const rows = await readForParents(
    matterIds.map((id) => brandPersistedWorkspaceId(id)),
    async (ids) => {
      const perRow = sql.join(
        matterTables.map(
          ([recordTable, workspaceColumn]) =>
            sql`SELECT ${workspaceColumn} AS workspace_id, ${expandedTextBytes(recordTable)} AS bytes FROM ${recordTable} WHERE ${inArray(workspaceColumn, ids)}`,
        ),
        sql` UNION ALL `,
      );
      const result = await db(
        async (tx) =>
          await tx.execute(
            sql`SELECT workspace_id::text AS workspace_id, COALESCE(SUM(bytes), 0)::bigint::text AS bytes FROM (${perRow} UNION ALL ${sql.join(
              [invoiceLines, invoicePayments].map(
                (child) =>
                  sql`SELECT ${invoices.workspaceId} AS workspace_id, ${expandedTextBytes(child)} AS bytes FROM ${child} INNER JOIN ${invoices} ON ${invoices.id} = ${child.invoiceId} WHERE ${inArray(invoices.workspaceId, ids)} AND ${child.organizationId} = ${organizationId}`,
              ),
              sql` UNION ALL `,
            )}) AS measured GROUP BY workspace_id`,
          ),
      );
      return v.parse(v.array(MatterBytesRow), executedRows(result));
    },
  );
  const matterBytes = new Map(
    rows.map((row) => [row.workspace_id, int8ToSafeNumber(row.bytes)] as const),
  );
  return { organizationBytes, matterBytes };
};

const loadOrganizationRecords = async (
  reader: PagedReader,
  templateKeys: Map<string, string>,
): Promise<SourceOrganizationRecords> => {
  const rows = await readOrganizationRows(reader);
  const referenceRows = await readOrganizationReferenceRows(reader);
  const children = await readOrganizationChildren(
    reader,
    rows.clauseRows.map((row) => row.id),
    rows.templateRows.map((row) => row.id),
  );
  const versionsByClause = groupBy(children.clauseVersionRows, (row) =>
    String(row.clauseId),
  );
  const variantsByClause = groupBy(children.clauseVariantRows, (row) =>
    String(row.clauseId),
  );
  const versionsByTemplate = groupBy(children.templateVersionRows, (row) =>
    String(row.templateId),
  );
  const templateById = new Map(
    rows.templateRows.map((row) => [String(row.id), row]),
  );
  const templateFiles: SourceTemplateFile[] = [];
  for (const version of children.templateVersionRows) {
    const template = templateById.get(String(version.templateId));
    if (template === undefined) {
      continue;
    }
    templateKeys.set(String(version.id), version.s3Key);
    templateFiles.push({
      templateId: String(template.id),
      templateName: template.name,
      templateVersionId: String(version.id),
      version: version.version,
      fileName: template.fileName,
      // Versions do not record their size; the template's current size is
      // the planning estimate.
      sizeBytes: template.sizeBytes,
    });
  }
  return {
    sellerProfiles: table(
      SELLER_PROFILE_COLUMNS,
      referenceRows.sellerProfilesRows,
    ),
    clauseCategories: table(
      CLAUSE_CATEGORY_COLUMNS,
      referenceRows.clauseCategoriesRows,
    ),
    templateCategories: table(
      TEMPLATE_CATEGORY_COLUMNS,
      referenceRows.templateCategoriesRows,
    ),
    contacts: table(CONTACT_COLUMNS, rows.contactRows),
    contactRelationships: table(
      CONTACT_RELATIONSHIP_COLUMNS,
      rows.relationshipRows,
    ),
    clauses: table(CLAUSE_COLUMNS, rows.clauseRows, (row) => ({
      versions: arrayOrEmpty(versionsByClause.get(String(row["id"]))).map(
        (version) => projectRecord(version, CLAUSE_VERSION_COLUMNS),
      ),
      variants: arrayOrEmpty(variantsByClause.get(String(row["id"]))).map(
        (variant) => projectRecord(variant, CLAUSE_VARIANT_COLUMNS),
      ),
    })),
    templates: table(TEMPLATE_COLUMNS, rows.templateRows, (row) => ({
      versions: arrayOrEmpty(versionsByTemplate.get(String(row["id"]))).map(
        (version) => projectRecord(version, TEMPLATE_VERSION_COLUMNS),
      ),
    })),
    unassignedTimeEntries: table(TIME_ENTRY_COLUMNS, rows.unassignedRows),
    invoices: invoiceRecords(await readInvoiceRecords(reader, null)),
    templateFiles,
  };
};

const openKey = async (key: string, signal: AbortSignal): Promise<FileRead> => {
  const opened = await openS3ObjectStream({ key, signal }).then(
    (stream) => ({ type: "opened", stream }) as const,
    (error: unknown) => {
      // The requester sees the file under the manifest's problems; the
      // object key stays out of telemetry.
      observeFailure(error, {
        sink: dataExportReadFileFailed,
        ctx: { operation: "data_export.read_file" },
      });
      return { type: "failed" } as const;
    },
  );
  if (opened.type === "failed") {
    return { type: "failed" };
  }
  if (opened.stream === null) {
    return { type: "missing" };
  }
  return {
    type: "found",
    sizeBytes: opened.stream.sizeBytes,
    chunks: opened.stream.chunks,
  };
};

export const createExportSource = (
  args: CreateExportSourceArgs,
): ExportSource => {
  const reader = createPagedReader(args);
  const { organizationId, signal } = args;
  // Filled by `loadOrganizationRecords`; template bytes are addressed by
  // their stored key, which never leaves this module.
  const templateKeys = new Map<string, string>();
  // Planning and part 1 both need the organisation records; read them once
  // per attempt.
  let organizationRecords: Promise<SourceOrganizationRecords> | null = null;

  const readFile = async (ref: ExportFileRef): Promise<FileRead> => {
    switch (ref.type) {
      case "document":
        return await openKey(
          createFileKey({
            organizationId,
            workspaceId: brandPersistedWorkspaceId(ref.workspaceId),
            fileId: ref.fileId,
            mimeType: ref.mimeType,
          }),
          signal,
        );
      case "template": {
        const key = templateKeys.get(ref.templateVersionId);
        return key === undefined
          ? { type: "missing" }
          : await openKey(key, signal);
      }
      default:
        ref satisfies never;
        return panic("Unhandled export file reference");
    }
  };

  return {
    listMatters: async (scope) => await listMatters(reader, scope),
    loadMatter: async (matterId, scope) =>
      await loadMatter(reader, matterId, scope),
    measureRecords: async (matterIds) =>
      await measureRecords(reader, matterIds),
    loadOrganizationRecords: async () => {
      organizationRecords ??= loadOrganizationRecords(reader, templateKeys);
      return await organizationRecords;
    },
    readFile,
  };
};
