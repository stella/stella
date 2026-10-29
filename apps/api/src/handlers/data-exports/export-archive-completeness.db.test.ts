import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  and,
  asc,
  eq,
  getColumns,
  inArray,
  is,
  isNotNull,
  isNull,
  ne,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import type { PgColumn } from "drizzle-orm/pg-core";
import JSZip from "jszip";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";

import type { Transaction } from "@/api/db/root";
import * as schema from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import {
  buildDataExport,
  DATA_EXPORT_RECORD_BYTES_CAP,
  planDataExport,
} from "@/api/handlers/data-exports/build-export";
import type {
  ExportSink,
  ExportSource,
} from "@/api/handlers/data-exports/build-export";
import { createExportSource } from "@/api/handlers/data-exports/export-source";
import { partManifestSchema } from "@/api/handlers/data-exports/manifest-schema";
import type {
  ManifestRecordFile,
  PartManifest,
} from "@/api/handlers/data-exports/manifest-schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createRootMembershipScopedDb } from "@/api/lib/root-scoped-db";
import { seedDataExportCompleteness } from "@/api/tests/helpers/data-export-completeness";
import type { DataExportCompletenessFixture } from "@/api/tests/helpers/data-export-completeness";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const sourcePath = (fileName: string) => path.join(import.meta.dir, fileName);
const recordsPath = sourcePath("records.ts");
const exportSourcePath = sourcePath("export-source.ts");
const parseSource = (fileName: string) =>
  ts.createSourceFile(
    fileName,
    readFileSync(fileName, "utf-8"),
    ts.ScriptTarget.Latest,
    true,
  );
const recordsAst = parseSource(recordsPath);
const exportSourceAst = parseSource(exportSourcePath);

const columnMapTableNames = (): string[] => {
  const tableNames = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      ts.isSatisfiesExpression(node.initializer) &&
      ts.isTypeReferenceNode(node.initializer.type) &&
      ts.isIdentifier(node.initializer.type.typeName) &&
      node.initializer.type.typeName.text === "ColumnMap"
    ) {
      const tableType = node.initializer.type.typeArguments?.at(0);
      if (
        tableType !== undefined &&
        ts.isTypeQueryNode(tableType) &&
        ts.isIdentifier(tableType.exprName)
      ) {
        tableNames.add(tableType.exprName.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(recordsAst);
  return [...tableNames].toSorted();
};

const sourceReadTableNames = (): string[] => {
  const tableNames = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const argument = node.arguments.at(0);
      if (
        node.expression.name.text === "from" &&
        argument &&
        ts.isIdentifier(argument)
      ) {
        tableNames.add(argument.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(exportSourceAst);
  return [...tableNames].toSorted();
};

const recordRowsSchema = v.array(v.record(v.string(), v.unknown()));
type JsonRow = Record<string, unknown>;

const required = <Value>(
  value: Value | null | undefined,
  label: string,
): Value => {
  if (value === null || value === undefined) {
    throw new Error(`Archive is missing ${label}`);
  }
  return value;
};

const rowIds = (rows: readonly JsonRow[]): string[] =>
  rows.map((row) => v.parse(v.string(), row["id"])).toSorted();

const nestedRows = (rows: readonly JsonRow[], key: string): JsonRow[] =>
  rows.flatMap((row) => v.parse(recordRowsSchema, row[key]));

const sortIds = (values: readonly string[]): string[] => [...values].toSorted();

const composite = (row: JsonRow, keys: readonly string[]) =>
  keys.map((key) => v.parse(v.string(), row[key])).join("\u0000");

const memorySink = () => {
  const parts = new Map<string, Uint8Array[]>();
  const sink: ExportSink = {
    openPart: (fileName) => {
      const chunks: Uint8Array[] = [];
      parts.set(fileName, chunks);
      return {
        write: async (chunk) => {
          chunks.push(chunk);
        },
        close: async () => {},
      };
    },
  };
  return { parts, sink };
};

const foundFile = (data: Uint8Array) => ({
  type: "found" as const,
  sizeBytes: data.byteLength,
  chunks: (async function* () {
    yield data;
  })(),
});

const readRecordTable = async (
  zip: JSZip,
  ref: ManifestRecordFile,
): Promise<JsonRow[]> => {
  const file = required(zip.file(ref.json), ref.json);
  const rows = v.parse(
    recordRowsSchema,
    JSON.parse(await file.async("string")),
  );
  expect(rows).toHaveLength(ref.count);
  return rows;
};

const buildArchive = async (fixture: DataExportCompletenessFixture) => {
  const db = createRootMembershipScopedDb(
    { organizationId: fixture.organizationId, userId: fixture.userId },
    asTestRaw<RlsDatabase<Transaction>>(fixture.db),
  );
  const baseSource = createExportSource({
    db,
    organizationId: fixture.organizationId,
    signal: new AbortController().signal,
    pace: async () => {},
  });
  const source: ExportSource = {
    ...baseSource,
    readFile: async (ref) => {
      const data =
        ref.type === "document"
          ? fixture.documentFileBytes.get(ref.fileId)
          : new Uint8Array(32);
      return data === undefined ? { type: "missing" } : foundFile(data);
    },
  };
  const plan = (
    await planDataExport({
      source,
      partTargetBytes: Number.MAX_SAFE_INTEGER,
      recordBytesCap: DATA_EXPORT_RECORD_BYTES_CAP,
      scope: { versions: "all" },
      pace: async () => {},
    })
  ).unwrap();
  expect(plan.parts).toHaveLength(1);
  expect(plan.mattersTotal).toBe(2);

  const memory = memorySink();
  const manifest = await buildDataExport({
    exportId: "00000000-0000-4000-8000-000000000001",
    organization: {
      id: fixture.organizationId,
      name: "Export completeness organization",
    },
    requestedBy: fixture.userId,
    createdAt: new Date("2026-10-29T00:00:00.000Z"),
    scope: { versions: "all" },
    plan,
    completedParts: [],
    source,
    sink: memory.sink,
    pace: async () => {},
    signal: new AbortController().signal,
    onPartComplete: async () => {},
    beforePart: async () => {},
    now: () => new Date("2026-10-29T00:01:00.000Z"),
  });
  expect(manifest.parts).toHaveLength(1);
  const [, chunks] = required([...memory.parts.entries()].at(0), "built part");
  const zip = await JSZip.loadAsync(Buffer.concat(chunks));
  const plannedPart = required(plan.parts.at(0), "first planned part");
  const partFile = required(
    zip.file(plannedPart.paths.manifest),
    plannedPart.paths.manifest,
  );
  const part = v.parse(
    partManifestSchema,
    JSON.parse(await partFile.async("string")),
  );
  return { plan, part, zip };
};

type ArchiveMatterRows = {
  matter: PartManifest["matters"][number];
  matterRecord: { id: string; contacts: JsonRow[] };
  tasks: JsonRow[];
  timeEntries: JsonRow[];
  expenses: JsonRow[];
  invoices: JsonRow[];
};

type ArchiveRows = {
  part: PartManifest;
  actualIds: Record<string, readonly string[]>;
  templateVersionIds: string[];
  documentFileIds: string[];
  documentVersionCount: number;
  sellerProfiles: JsonRow[];
  clauseCategories: JsonRow[];
  templateCategories: JsonRow[];
};

const readArchiveRows = async (
  zip: JSZip,
  part: PartManifest,
): Promise<ArchiveRows> => {
  const organization = required(
    part.organizationRecords,
    "organization records",
  );
  const organizationRows = {
    contacts: await readRecordTable(zip, organization.contacts),
    contactRelationships: await readRecordTable(
      zip,
      organization.contactRelationships,
    ),
    clauses: await readRecordTable(zip, organization.clauses),
    templates: await readRecordTable(zip, organization.templates),
    unassignedTimeEntries: await readRecordTable(
      zip,
      organization.unassignedTimeEntries,
    ),
    invoices: await readRecordTable(zip, organization.invoices),
    sellerProfiles: await readRecordTable(zip, organization.sellerProfiles),
    clauseCategories: await readRecordTable(zip, organization.clauseCategories),
    templateCategories: await readRecordTable(
      zip,
      organization.templateCategories,
    ),
  };
  const matters: ArchiveMatterRows[] = await Promise.all(
    part.matters.map(async (matter) => ({
      matter,
      matterRecord: v.parse(
        v.object({ id: v.string(), contacts: recordRowsSchema }),
        JSON.parse(
          await required(
            zip.file(matter.records.matter),
            "matter record",
          ).async("string"),
        ),
      ),
      tasks: await readRecordTable(zip, matter.records.tasks),
      timeEntries: await readRecordTable(zip, matter.records.timeEntries),
      expenses: await readRecordTable(zip, matter.records.expenses),
      invoices: await readRecordTable(zip, matter.records.invoices),
    })),
  );
  const invoiceRows = [
    ...organizationRows.invoices,
    ...matters.flatMap(({ invoices: rows }) => rows),
  ];
  const taskRows = matters.flatMap(({ tasks }) => tasks);
  const expenseRows = matters.flatMap(({ expenses }) => expenses);
  const documents = part.matters.flatMap((matter) => matter.documents);
  const versions = documents.flatMap((document) => document.versions);
  const fileRefs = versions.flatMap((version) => version.files);
  const clauses = organizationRows.clauses;
  const templates = organizationRows.templates;
  const taskAssignees = nestedRows(taskRows, "assignees");
  const matterContacts = matters.flatMap(
    ({ matterRecord }) => matterRecord.contacts,
  );
  const actualIds: Record<string, readonly string[]> = {
    workspaces: part.matters.map((matter) => matter.id),
    fields: fileRefs.map((file) => file.fieldId),
    entities: [
      ...rowIds(taskRows),
      ...part.matters.flatMap((matter) =>
        matter.folders.map((folder) => folder.id),
      ),
      ...documents.map((document) => document.id),
    ],
    entityVersions: versions.map((version) => version.id),
    workspaceContacts: rowIds(matterContacts),
    taskAssignees: taskAssignees.map((row) =>
      composite(row, ["entityId", "userId", "role"]),
    ),
    timeEntries: rowIds([
      ...organizationRows.unassignedTimeEntries,
      ...matters.flatMap(({ timeEntries: rows }) => rows),
    ]),
    expenses: rowIds(expenseRows),
    invoices: rowIds(invoiceRows),
    invoiceLines: rowIds(nestedRows(invoiceRows, "lines")),
    invoicePayments: rowIds(nestedRows(invoiceRows, "payments")),
    contacts: rowIds(organizationRows.contacts),
    contactRelationships: rowIds(organizationRows.contactRelationships),
    clauses: rowIds(clauses),
    templates: rowIds(templates),
    sellerProfiles: rowIds(organizationRows.sellerProfiles),
    clauseCategories: rowIds(organizationRows.clauseCategories),
    templateCategories: rowIds(organizationRows.templateCategories),
    clauseVersions: rowIds(nestedRows(clauses, "versions")),
    clauseVariants: rowIds(nestedRows(clauses, "variants")),
    templateVersions: rowIds(nestedRows(templates, "versions")),
  };
  return {
    part,
    actualIds,
    templateVersionIds: organization.templateFiles.map(
      (file) => file.templateVersionId,
    ),
    documentFileIds: fileRefs.map((file) => file.fileId),
    documentVersionCount: versions.length,
    sellerProfiles: organizationRows.sellerProfiles,
    clauseCategories: organizationRows.clauseCategories,
    templateCategories: organizationRows.templateCategories,
  };
};

type DatabaseRows = {
  eligibleMatterIds: string[];
  expectedIds: Record<string, readonly string[]>;
  templateVersionIds: string[];
  documentFileIds: string[];
  documentVersionCount: number;
};

const readDocumentDatabaseRows = async (
  db: TestDatabase,
  eligibleMatterIds: readonly SafeId<"workspace">[],
) => {
  const documentRows = await db
    .select({ id: schema.entities.id })
    .from(schema.entities)
    .where(
      and(
        inArray(schema.entities.workspaceId, eligibleMatterIds),
        inArray(schema.entities.kind, ["document", "message"]),
      ),
    );
  const documentEntityIds = documentRows.map((row) => row.id);
  const entityVersionRows = await db
    .select({ id: schema.entityVersions.id })
    .from(schema.entityVersions)
    .where(inArray(schema.entityVersions.entityId, documentEntityIds));
  const fieldRows = await db
    .select({
      id: schema.fields.id,
      entityVersionId: schema.fields.entityVersionId,
      content: schema.fields.content,
    })
    .from(schema.fields)
    .where(
      inArray(
        schema.fields.entityVersionId,
        entityVersionRows.map((row) => row.id),
      ),
    );
  const fileFieldRows = fieldRows.filter((row) => row.content.type === "file");
  return { entityVersionRows, fileFieldRows };
};

const readOrganizationCategoryRows = async (
  db: TestDatabase,
  organizationId: SafeId<"organization">,
) => {
  const [sellerProfiles, clauseCategories, templateCategories] =
    await Promise.all([
      db
        .select({ id: schema.sellerProfiles.id })
        .from(schema.sellerProfiles)
        .where(eq(schema.sellerProfiles.organizationId, organizationId)),
      db
        .select({ id: schema.clauseCategories.id })
        .from(schema.clauseCategories)
        .where(eq(schema.clauseCategories.organizationId, organizationId)),
      db
        .select({ id: schema.templateCategories.id })
        .from(schema.templateCategories)
        .where(eq(schema.templateCategories.organizationId, organizationId)),
    ]);
  return { sellerProfiles, clauseCategories, templateCategories };
};

const readDatabaseRows = async (
  db: TestDatabase,
  fixture: DataExportCompletenessFixture,
): Promise<DatabaseRows> => {
  const eligibleMatterRows = await db
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.organizationId, fixture.organizationId),
        isNotNull(schema.workspaces.clientId),
        ne(schema.workspaces.status, "deleting"),
      ),
    );
  const eligibleMatterIds = eligibleMatterRows.map((row) => row.id);
  expect(eligibleMatterIds).toHaveLength(2);
  const organizationInvoices = await db
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.organizationId, fixture.organizationId),
        isNull(schema.invoices.workspaceId),
      ),
    );
  const matterInvoices = await db
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(
      and(
        eq(schema.invoices.organizationId, fixture.organizationId),
        inArray(schema.invoices.workspaceId, eligibleMatterIds),
      ),
    );
  const allInvoiceIds = [
    ...organizationInvoices.map((row) => row.id),
    ...matterInvoices.map((row) => row.id),
  ];
  const { sellerProfiles, clauseCategories, templateCategories } =
    await readOrganizationCategoryRows(db, fixture.organizationId);
  const [
    invoiceLineRows,
    invoicePaymentRows,
    contactRows,
    relationshipRows,
    clauseRows,
    clauseVersionRows,
    clauseVariantRows,
    templateRows,
    templateVersionRows,
    unassignedTimeRows,
    matterTimeRows,
    expenseRows,
    entityRows,
    matterContactRows,
    taskAssigneeRows,
  ] = await Promise.all([
    db
      .select({ id: schema.invoiceLines.id })
      .from(schema.invoiceLines)
      .where(
        and(
          eq(schema.invoiceLines.organizationId, fixture.organizationId),
          inArray(schema.invoiceLines.invoiceId, allInvoiceIds),
        ),
      ),
    db
      .select({ id: schema.invoicePayments.id })
      .from(schema.invoicePayments)
      .where(
        and(
          eq(schema.invoicePayments.organizationId, fixture.organizationId),
          inArray(schema.invoicePayments.invoiceId, allInvoiceIds),
        ),
      ),
    db
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(eq(schema.contacts.organizationId, fixture.organizationId)),
    db
      .select({ id: schema.contactRelationships.id })
      .from(schema.contactRelationships)
      .where(
        eq(schema.contactRelationships.organizationId, fixture.organizationId),
      ),
    db
      .select({ id: schema.clauses.id })
      .from(schema.clauses)
      .where(eq(schema.clauses.organizationId, fixture.organizationId)),
    db
      .select({ id: schema.clauseVersions.id })
      .from(schema.clauseVersions)
      .where(eq(schema.clauseVersions.organizationId, fixture.organizationId)),
    db
      .select({ id: schema.clauseVariants.id })
      .from(schema.clauseVariants)
      .where(eq(schema.clauseVariants.organizationId, fixture.organizationId)),
    db
      .select({ id: schema.templates.id })
      .from(schema.templates)
      .where(eq(schema.templates.organizationId, fixture.organizationId)),
    db
      .select({ id: schema.templateVersions.id })
      .from(schema.templateVersions)
      .where(
        eq(schema.templateVersions.organizationId, fixture.organizationId),
      ),
    db
      .select({ id: schema.timeEntries.id })
      .from(schema.timeEntries)
      .where(
        and(
          eq(schema.timeEntries.organizationId, fixture.organizationId),
          isNull(schema.timeEntries.workspaceId),
        ),
      ),
    db
      .select({ id: schema.timeEntries.id })
      .from(schema.timeEntries)
      .where(
        and(
          eq(schema.timeEntries.organizationId, fixture.organizationId),
          inArray(schema.timeEntries.workspaceId, eligibleMatterIds),
        ),
      ),
    db
      .select({ id: schema.expenses.id })
      .from(schema.expenses)
      .where(
        and(
          eq(schema.expenses.organizationId, fixture.organizationId),
          inArray(schema.expenses.workspaceId, eligibleMatterIds),
        ),
      ),
    db
      .select({ id: schema.entities.id })
      .from(schema.entities)
      .where(
        and(
          inArray(schema.entities.workspaceId, eligibleMatterIds),
          ne(schema.entities.kind, "link"),
        ),
      ),
    db
      .select({ id: schema.workspaceContacts.id })
      .from(schema.workspaceContacts)
      .where(inArray(schema.workspaceContacts.workspaceId, eligibleMatterIds)),
    db
      .select({
        entityId: schema.taskAssignees.entityId,
        userId: schema.taskAssignees.userId,
        role: schema.taskAssignees.role,
      })
      .from(schema.taskAssignees)
      .where(inArray(schema.taskAssignees.workspaceId, eligibleMatterIds)),
  ]);
  const { entityVersionRows, fileFieldRows } = await readDocumentDatabaseRows(
    db,
    eligibleMatterIds,
  );
  const expectedIds: Record<string, readonly string[]> = {
    workspaces: eligibleMatterIds,
    fields: fileFieldRows.map((row) => row.id),
    entities: entityRows.map((row) => row.id),
    entityVersions: entityVersionRows.map((row) => row.id),
    workspaceContacts: matterContactRows.map((row) => row.id),
    taskAssignees: taskAssigneeRows.map(
      (row) => `${row.entityId}\u0000${row.userId}\u0000${row.role}`,
    ),
    timeEntries: [...unassignedTimeRows, ...matterTimeRows].map(
      (row) => row.id,
    ),
    expenses: expenseRows.map((row) => row.id),
    invoices: allInvoiceIds,
    invoiceLines: invoiceLineRows.map((row) => row.id),
    invoicePayments: invoicePaymentRows.map((row) => row.id),
    contacts: contactRows.map((row) => row.id),
    contactRelationships: relationshipRows.map((row) => row.id),
    clauses: clauseRows.map((row) => row.id),
    templates: templateRows.map((row) => row.id),
    sellerProfiles: sellerProfiles.map((row) => row.id),
    clauseCategories: clauseCategories.map((row) => row.id),
    templateCategories: templateCategories.map((row) => row.id),
    clauseVersions: clauseVersionRows.map((row) => row.id),
    clauseVariants: clauseVariantRows.map((row) => row.id),
    templateVersions: templateVersionRows.map((row) => row.id),
  };
  return {
    eligibleMatterIds,
    expectedIds,
    templateVersionIds: templateVersionRows.map((row) => row.id),
    documentFileIds: fileFieldRows.flatMap((row) =>
      row.content.type === "file" ? [row.content.id] : [],
    ),
    documentVersionCount: entityVersionRows.length,
  };
};

type ScopeForTableOptions = {
  table: PgTable;
  fixture: DataExportCompletenessFixture;
  matterIds: readonly string[];
};

const scopeForTable = ({
  table,
  fixture,
  matterIds,
}: ScopeForTableOptions): SQL => {
  const columns = Object.values(getColumns(table));
  const predicates: SQL[] = [];
  const organizationColumn = columns.find(
    (column) => column.name === "organization_id",
  );
  const workspaceColumn = columns.find(
    (column) => column.name === "workspace_id",
  );
  if (organizationColumn !== undefined) {
    predicates.push(sql`${organizationColumn} = ${fixture.organizationId}`);
  } else if (workspaceColumn !== undefined) {
    const ids = sql.join(
      matterIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const matterScope = sql`${workspaceColumn} IN (${ids})`;
    predicates.push(matterScope);
  }
  if (predicates.length === 0) {
    throw new Error(`No tenant scope for ${getTableConfig(table).name}`);
  }
  return sql.join(predicates, sql` AND `);
};

type AssertNullableForeignKeyCoverageOptions = {
  db: TestDatabase;
  fixture: DataExportCompletenessFixture;
  sourceTables: readonly string[];
  matterIds: readonly string[];
};

const assertNullableForeignKeyCoverage = async ({
  db,
  fixture,
  sourceTables,
  matterIds,
}: AssertNullableForeignKeyCoverageOptions): Promise<void> => {
  const exports = new Map(Object.entries(schema));
  for (const tableName of sourceTables) {
    const value = exports.get(tableName);
    if (value === undefined || !is(value, PgTable)) {
      throw new Error(`Missing schema table ${tableName}`);
    }
    const table = value;
    const nullableForeignKeyColumns = new Map<string, PgColumn>();
    for (const foreignKey of getTableConfig(table).foreignKeys) {
      for (const column of foreignKey.reference().columns) {
        if (!column.notNull) {
          nullableForeignKeyColumns.set(column.name, column);
        }
      }
    }
    const scope = scopeForTable({ table, fixture, matterIds });
    for (const [columnName, column] of nullableForeignKeyColumns) {
      const rows = await db
        .select({
          nullCount: sql<number>`count(*) FILTER (WHERE ${column} IS NULL)::integer`,
          nonNullCount: sql<number>`count(*) FILTER (WHERE ${column} IS NOT NULL)::integer`,
        })
        .from(table)
        .where(scope);
      const { nullCount, nonNullCount } = required(
        rows.at(0),
        "nullable parent counts",
      );
      expect(
        nullCount,
        `${tableName}.${columnName} NULL fixture`,
      ).toBeGreaterThan(0);
      expect(
        nonNullCount,
        `${tableName}.${columnName} non-NULL fixture`,
      ).toBeGreaterThan(0);
    }
  }
};

type AssertArchiveCompletenessOptions = {
  archive: ArchiveRows;
  database: DatabaseRows;
  sourceTables: readonly string[];
  fixture: DataExportCompletenessFixture;
};

const assertArchiveCompleteness = ({
  archive,
  database,
  sourceTables,
  fixture,
}: AssertArchiveCompletenessOptions): void => {
  expect(archive.part.matters.map((matter) => matter.id).toSorted()).toEqual(
    database.eligibleMatterIds.toSorted(),
  );
  expect(archive.part.matters.map((matter) => matter.id)).not.toContain(
    fixture.personalMatterId,
  );
  expect(Object.keys(database.expectedIds).toSorted()).toEqual([
    ...sourceTables,
  ]);
  expect(Object.keys(archive.actualIds).toSorted()).toEqual([...sourceTables]);
  for (const tableName of sourceTables) {
    const expected = database.expectedIds[tableName];
    const actual = archive.actualIds[tableName];
    expect(expected, `${tableName} has database rows`).toBeDefined();
    expect(actual, `${tableName} has archive rows`).toBeDefined();
    if (expected === undefined || actual === undefined) {
      throw new Error(`Missing completeness coverage for ${tableName}`);
    }
    expect(expected.length, `${tableName} fixture rows`).toBeGreaterThan(0);
    expect(sortIds(actual), `${tableName} archived IDs`).toEqual(
      sortIds(expected),
    );
  }
  expect(archive.templateVersionIds.toSorted()).toEqual(
    database.templateVersionIds.toSorted(),
  );
  expect(archive.documentFileIds.toSorted()).toEqual(
    database.documentFileIds.toSorted(),
  );
  expect(archive.documentVersionCount).toBe(database.documentVersionCount);
  expect(archive.sellerProfiles).toContainEqual(
    expect.objectContaining({ legalName: "Export Seller" }),
  );
  expect(archive.clauseCategories).toContainEqual(
    expect.objectContaining({ name: "Export clause category" }),
  );
  expect(archive.templateCategories).toContainEqual(
    expect.objectContaining({ name: "Export template category" }),
  );
  expect(archive.part.organizationRecords).not.toBeNull();
};

let testDb: TestDatabase;
let fixture: DataExportCompletenessFixture | undefined;

beforeAll(async () => {
  testDb = await getTestDb();
  fixture = await seedDataExportCompleteness(testDb);
});

afterAll(async () => {
  if (fixture !== undefined) {
    await fixture.cleanup();
  }
  await releaseTestDb();
});

describe("database-backed export archive completeness", () => {
  test("every source table row is present once in the organization or matter archive", async () => {
    const mapTableNames = columnMapTableNames();
    const activeFixture = required(fixture, "database fixture");
    const sourceTables = sourceReadTableNames();
    const expectedSourceTables = [
      ...new Set([...mapTableNames, "entityVersions", "fields"]),
    ].toSorted();
    expect(sourceTables).toEqual(expectedSourceTables);
    const schemaTables = new Set(
      Object.entries(schema)
        .filter(([, value]) => is(value, PgTable))
        .map(([name]) => name),
    );
    expect(sourceTables.every((name) => schemaTables.has(name))).toBe(true);

    const { plan, part, zip } = await buildArchive(activeFixture);
    const firstPlannedPart = required(plan.parts.at(0), "first planned part");
    expect(part.matters.map((matter) => matter.id).toSorted()).toEqual(
      firstPlannedPart.matterIds.toSorted(),
    );
    const [archiveRows, databaseRows] = await Promise.all([
      readArchiveRows(zip, part),
      readDatabaseRows(testDb, activeFixture),
    ]);
    assertArchiveCompleteness({
      archive: archiveRows,
      database: databaseRows,
      sourceTables,
      fixture: activeFixture,
    });
    await assertNullableForeignKeyCoverage({
      db: testDb,
      fixture: activeFixture,
      sourceTables,
      matterIds: databaseRows.eligibleMatterIds,
    });
  });
  test("seller and category references retain their stored IDs and values", async () => {
    const activeFixture = required(fixture, "database fixture");
    const { zip, part } = await buildArchive(activeFixture);
    const organization = required(
      part.organizationRecords,
      "organization records",
    );
    const [
      sellerRows,
      clauseRows,
      templateRows,
      expectedSellers,
      expectedClauses,
      expectedTemplates,
    ] = await Promise.all([
      readRecordTable(zip, organization.sellerProfiles),
      readRecordTable(zip, organization.clauseCategories),
      readRecordTable(zip, organization.templateCategories),
      testDb
        .select({
          id: schema.sellerProfiles.id,
          legalName: schema.sellerProfiles.legalName,
          defaultCurrency: schema.sellerProfiles.defaultCurrency,
        })
        .from(schema.sellerProfiles)
        .where(
          eq(
            schema.sellerProfiles.organizationId,
            activeFixture.organizationId,
          ),
        )
        .orderBy(asc(schema.sellerProfiles.id)),
      testDb
        .select({
          id: schema.clauseCategories.id,
          name: schema.clauseCategories.name,
          parentId: schema.clauseCategories.parentId,
        })
        .from(schema.clauseCategories)
        .where(
          eq(
            schema.clauseCategories.organizationId,
            activeFixture.organizationId,
          ),
        )
        .orderBy(asc(schema.clauseCategories.id)),
      testDb
        .select({
          id: schema.templateCategories.id,
          name: schema.templateCategories.name,
          parentId: schema.templateCategories.parentId,
        })
        .from(schema.templateCategories)
        .where(
          eq(
            schema.templateCategories.organizationId,
            activeFixture.organizationId,
          ),
        )
        .orderBy(asc(schema.templateCategories.id)),
    ]);
    const sellers = v.parse(
      v.array(
        v.object({
          id: v.string(),
          legalName: v.string(),
          defaultCurrency: v.string(),
        }),
      ),
      sellerRows,
    );
    const categorySchema = v.array(
      v.object({
        id: v.string(),
        name: v.string(),
        parentId: v.nullable(v.string()),
      }),
    );
    const clauses = v.parse(categorySchema, clauseRows);
    const templates = v.parse(categorySchema, templateRows);
    expect(expectedSellers.length).toBeGreaterThan(0);
    expect(expectedClauses.length).toBeGreaterThan(0);
    expect(expectedTemplates.length).toBeGreaterThan(0);
    expect(sellers.toSorted((a, b) => compareCodeUnit(a.id, b.id))).toEqual(
      expectedSellers,
    );
    expect(clauses.toSorted((a, b) => compareCodeUnit(a.id, b.id))).toEqual(
      expectedClauses,
    );
    expect(templates.toSorted((a, b) => compareCodeUnit(a.id, b.id))).toEqual(
      expectedTemplates,
    );
  });
});
