import { sql } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";

import { member, organization, user } from "@/api/db/auth-schema";
import { stella } from "@/api/db/rls";
import {
  billingCodes,
  caseLawDecisions,
  caseLawMatterLinks,
  caseLawSources,
  clauseCategories,
  clauses,
  clauseVariants,
  clauseVersions,
  contactRelationships,
  contacts,
  documentCounters,
  entities,
  entityVersions,
  expenses,
  fields,
  invoices,
  justifications,
  matterCounters,
  organizationSettings,
  properties,
  propertyDependencies,
  rateEntries,
  rateTables,
  templateCategories,
  templateClauses,
  templateFills,
  templates,
  templateVersions,
  timeEntries,
  workspaceContacts,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import type { ClauseBody } from "@/api/handlers/clauses/types";
import { toSafeId } from "@/api/lib/branded-types";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

// ── ID generation ──────────────────────────────────────

const tid = () => crypto.randomUUID();
const wsId = () => toSafeId<"workspace">(tid());
const orgId = () => toSafeId<"organization">(tid());

// ── Test data IDs ──────────────────────────────────────

export const createTestIds = () => ({
  orgA: orgId(),
  orgB: orgId(),
  userA1: tid(),
  userA2: tid(),
  userB1: tid(),
  userAdmin: tid(),
  wsA1: wsId(),
  wsA2: wsId(),
  wsB1: wsId(),
  memberA1org: tid(),
  memberA2org: tid(),
  memberB1org: tid(),
  memberAdminOrg: tid(),
  memberA1wsA1: tid(),
  memberA1wsA2: tid(),
  memberA2wsA2: tid(),
  memberB1wsB1: tid(),
  // Workspace-scoped rows
  entityA1: tid(),
  entityA2: tid(),
  entityB1: tid(),
  entityVersionA1: tid(),
  entityVersionA2: tid(),
  entityVersionB1: tid(),
  propertyA1: tid(),
  propertyA2: tid(),
  propertyB1: tid(),
  fieldA1: tid(),
  fieldA2: tid(),
  fieldB1: tid(),
  docCounterA1: tid(),
  docCounterB1: tid(),
  wsContactA1: tid(),
  wsContactB1: tid(),
  propDepA1: tid(),
  propDepB1: tid(),
  justificationA1: tid(),
  justificationB1: tid(),
  timeEntryA1: tid(),
  timeEntryB1: tid(),
  billingCodeA1: tid(),
  billingCodeB1: tid(),
  rateTableA1: tid(),
  rateTableB1: tid(),
  rateEntryA1: tid(),
  rateEntryB1: tid(),
  expenseA1: tid(),
  expenseB1: tid(),
  invoiceA1: tid(),
  invoiceB1: tid(),
  caseLawSourceId: tid(),
  caseLawDecisionA: tid(),
  caseLawDecisionB: tid(),
  caseLawMatterLinkA1: tid(),
  caseLawMatterLinkB1: tid(),
  // Additional properties for dependencies
  propertyA1dep: tid(),
  propertyB1dep: tid(),
  // Org-scoped rows
  contactA: tid(),
  contactA2: tid(),
  contactB: tid(),
  contactB2: tid(),
  contactRelA: tid(),
  contactRelB: tid(),
  templateA: tid(),
  templateB: tid(),
  templateVersionA: tid(),
  templateVersionB: tid(),
  templateCategoryA: tid(),
  templateCategoryB: tid(),
  templateClauseA: tid(),
  templateClauseB: tid(),
  templateFillA: tid(),
  templateFillB: tid(),
  clauseCategoryA: tid(),
  clauseCategoryB: tid(),
  clauseA: tid(),
  clauseB: tid(),
  clauseVariantA: tid(),
  clauseVariantB: tid(),
  clauseVersionA: tid(),
  clauseVersionB: tid(),
  orgSettingsA: tid(),
  orgSettingsB: tid(),
  matterCounterA: tid(),
  matterCounterB: tid(),
});

export type TestIds = ReturnType<typeof createTestIds>;

// ── Shared types ──────────────────────────────────────

export type InsertCase = {
  table: AnyPgTable;
  values: (tx: TestDatabaseTransaction) => Promise<unknown>;
};

export type MutationCase = {
  table: AnyPgTable;
  query: (tx: TestDatabaseTransaction) => Promise<{ id: string }[]>;
};

// ── Scoped table arrays ───────────────────────────────

/** All workspace-scoped tables with `workspace_id`. */
export const wsScopedTables = [
  entities,
  entityVersions,
  properties,
  fields,
  workspaceMembers,
  documentCounters,
  workspaceContacts,
  propertyDependencies,
  justifications,
  timeEntries,
  billingCodes,
  rateTables,
  rateEntries,
  expenses,
  invoices,
  caseLawMatterLinks,
] as const;

/** All organization-only tables with `organization_id`. */
export const orgScopedTables = [
  contacts,
  templates,
  clauseCategories,
  clauses,
  organizationSettings,
  matterCounters,
  contactRelationships,
  templateVersions,
  clauseVariants,
  clauseVersions,
  templateCategories,
  templateClauses,
  templateFills,
] as const;

// ── Seed ───────────────────────────────────────────────

export const setupRlsTestData = async (db: TestDatabase, ids: TestIds) => {
  await db.insert(user).values([
    {
      id: ids.userA1,
      name: "User A1",
      email: `${ids.userA1}@test.local`,
    },
    {
      id: ids.userA2,
      name: "User A2",
      email: `${ids.userA2}@test.local`,
    },
    {
      id: ids.userB1,
      name: "User B1",
      email: `${ids.userB1}@test.local`,
    },
    {
      id: ids.userAdmin,
      name: "Admin",
      email: `${ids.userAdmin}@test.local`,
    },
  ]);

  await db.insert(organization).values([
    {
      id: ids.orgA,
      name: "Org A",
      slug: `org-a-${ids.orgA}`,
      createdAt: new Date(),
    },
    {
      id: ids.orgB,
      name: "Org B",
      slug: `org-b-${ids.orgB}`,
      createdAt: new Date(),
    },
  ]);

  await db.insert(member).values([
    {
      id: ids.memberA1org,
      organizationId: ids.orgA,
      userId: ids.userA1,
      role: "member",
      createdAt: new Date(),
    },
    {
      id: ids.memberA2org,
      organizationId: ids.orgA,
      userId: ids.userA2,
      role: "member",
      createdAt: new Date(),
    },
    {
      id: ids.memberB1org,
      organizationId: ids.orgB,
      userId: ids.userB1,
      role: "member",
      createdAt: new Date(),
    },
    {
      id: ids.memberAdminOrg,
      organizationId: ids.orgA,
      userId: ids.userAdmin,
      role: "owner",
      createdAt: new Date(),
    },
  ]);

  await db.insert(contacts).values([
    {
      id: ids.contactA,
      organizationId: ids.orgA,
      type: "person" as const,
      displayName: "Contact A",
    },
    {
      id: ids.contactA2,
      organizationId: ids.orgA,
      type: "person" as const,
      displayName: "Contact A2",
    },
    {
      id: ids.contactB,
      organizationId: ids.orgB,
      type: "person" as const,
      displayName: "Contact B",
    },
    {
      id: ids.contactB2,
      organizationId: ids.orgB,
      type: "person" as const,
      displayName: "Contact B2",
    },
  ]);

  await db.insert(workspaces).values([
    {
      id: ids.wsA1,
      organizationId: ids.orgA,
      clientId: ids.contactA,
      name: "WS A1",
      reference: "REF-A1",
      status: "active" as const,
    },
    {
      id: ids.wsA2,
      organizationId: ids.orgA,
      clientId: ids.contactA2,
      name: "WS A2",
      reference: "REF-A2",
      status: "active" as const,
    },
    {
      id: ids.wsB1,
      organizationId: ids.orgB,
      clientId: ids.contactB,
      name: "WS B1",
      reference: "REF-B1",
      status: "active" as const,
    },
  ]);

  await db.insert(workspaceMembers).values([
    {
      id: ids.memberA1wsA1,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
    },
    {
      id: ids.memberA1wsA2,
      workspaceId: ids.wsA2,
      userId: ids.userA1,
    },
    {
      id: ids.memberA2wsA2,
      workspaceId: ids.wsA2,
      userId: ids.userA2,
    },
    {
      id: ids.memberB1wsB1,
      workspaceId: ids.wsB1,
      userId: ids.userB1,
    },
  ]);

  await db.insert(entities).values([
    {
      id: ids.entityA1,
      workspaceId: ids.wsA1,
      kind: "document" as const,
    },
    {
      id: ids.entityA2,
      workspaceId: ids.wsA2,
      kind: "document" as const,
    },
    {
      id: ids.entityB1,
      workspaceId: ids.wsB1,
      kind: "document" as const,
    },
  ]);

  await db.insert(entityVersions).values([
    {
      id: ids.entityVersionA1,
      workspaceId: ids.wsA1,
      entityId: ids.entityA1,
    },
    {
      id: ids.entityVersionA2,
      workspaceId: ids.wsA2,
      entityId: ids.entityA2,
    },
    {
      id: ids.entityVersionB1,
      workspaceId: ids.wsB1,
      entityId: ids.entityB1,
    },
  ]);

  const propContent = {
    version: 1 as const,
    type: "text" as const,
  };
  const propTool = {
    version: 1 as const,
    type: "manual-input" as const,
  };

  await db.insert(properties).values([
    {
      id: ids.propertyA1,
      workspaceId: ids.wsA1,
      name: "Prop A1",
      content: propContent,
      tool: propTool,
    },
    {
      id: ids.propertyA2,
      workspaceId: ids.wsA2,
      name: "Prop A2",
      content: propContent,
      tool: propTool,
    },
    {
      id: ids.propertyB1,
      workspaceId: ids.wsB1,
      name: "Prop B1",
      content: propContent,
      tool: propTool,
    },
  ]);

  const fieldContent = (value: string) => ({
    version: 1 as const,
    type: "text" as const,
    value,
  });

  await db.insert(fields).values([
    {
      id: ids.fieldA1,
      workspaceId: ids.wsA1,
      propertyId: ids.propertyA1,
      entityVersionId: ids.entityVersionA1,
      content: fieldContent("a1"),
    },
    {
      id: ids.fieldA2,
      workspaceId: ids.wsA2,
      propertyId: ids.propertyA2,
      entityVersionId: ids.entityVersionA2,
      content: fieldContent("a2"),
    },
    {
      id: ids.fieldB1,
      workspaceId: ids.wsB1,
      propertyId: ids.propertyB1,
      entityVersionId: ids.entityVersionB1,
      content: fieldContent("b1"),
    },
  ]);

  await db.insert(documentCounters).values([
    {
      id: ids.docCounterA1,
      workspaceId: ids.wsA1,
      lastValue: 0,
    },
    {
      id: ids.docCounterB1,
      workspaceId: ids.wsB1,
      lastValue: 0,
    },
  ]);

  await db.insert(templates).values([
    {
      id: ids.templateA,
      organizationId: ids.orgA,
      name: "Tmpl A",
      fileName: "a.docx",
      s3Key: "test/a.docx",
      sizeBytes: 1024,
      createdBy: ids.userA1,
    },
    {
      id: ids.templateB,
      organizationId: ids.orgB,
      name: "Tmpl B",
      fileName: "b.docx",
      s3Key: "test/b.docx",
      sizeBytes: 1024,
      createdBy: ids.userB1,
    },
  ]);

  await db.insert(clauseCategories).values([
    {
      id: ids.clauseCategoryA,
      organizationId: ids.orgA,
      name: "Cat A",
    },
    {
      id: ids.clauseCategoryB,
      organizationId: ids.orgB,
      name: "Cat B",
    },
  ]);

  const clauseBody: ClauseBody = [{ text: "test" }];

  await db.insert(clauses).values([
    {
      id: ids.clauseA,
      organizationId: ids.orgA,
      title: "Clause A",
      body: clauseBody,
      createdBy: ids.userA1,
    },
    {
      id: ids.clauseB,
      organizationId: ids.orgB,
      title: "Clause B",
      body: clauseBody,
      createdBy: ids.userB1,
    },
  ]);

  await db.insert(organizationSettings).values([
    { id: ids.orgSettingsA, organizationId: ids.orgA },
    { id: ids.orgSettingsB, organizationId: ids.orgB },
  ]);

  await db.insert(matterCounters).values([
    {
      id: ids.matterCounterA,
      organizationId: ids.orgA,
      scopeKey: "default",
      lastValue: 0,
    },
    {
      id: ids.matterCounterB,
      organizationId: ids.orgB,
      scopeKey: "default",
      lastValue: 0,
    },
  ]);

  // ── Additional workspace-scoped tables ───────────

  await db.insert(workspaceContacts).values([
    {
      id: ids.wsContactA1,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      contactId: ids.contactA,
      role: "opposing_party" as const,
    },
    {
      id: ids.wsContactB1,
      organizationId: ids.orgB,
      workspaceId: ids.wsB1,
      contactId: ids.contactB,
      role: "opposing_party" as const,
    },
  ]);

  // Second property per workspace for dependencies
  await db.insert(properties).values([
    {
      id: ids.propertyA1dep,
      workspaceId: ids.wsA1,
      name: "Dep A1",
      content: propContent,
      tool: propTool,
    },
    {
      id: ids.propertyB1dep,
      workspaceId: ids.wsB1,
      name: "Dep B1",
      content: propContent,
      tool: propTool,
    },
  ]);

  await db.insert(propertyDependencies).values([
    {
      id: ids.propDepA1,
      workspaceId: ids.wsA1,
      propertyId: ids.propertyA1,
      dependsOnPropertyId: ids.propertyA1dep,
    },
    {
      id: ids.propDepB1,
      workspaceId: ids.wsB1,
      propertyId: ids.propertyB1,
      dependsOnPropertyId: ids.propertyB1dep,
    },
  ]);

  await db.insert(justifications).values([
    {
      id: ids.justificationA1,
      workspaceId: ids.wsA1,
      fieldId: ids.fieldA1,
      htmlVersion: 1,
      htmlContent: "<p>a1</p>",
    },
    {
      id: ids.justificationB1,
      workspaceId: ids.wsB1,
      fieldId: ids.fieldB1,
      htmlVersion: 1,
      htmlContent: "<p>b1</p>",
    },
  ]);

  // Invoices must be created before timeEntries/expenses
  // that reference them
  await db.insert(invoices).values([
    {
      id: ids.invoiceA1,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      invoiceNumber: "INV-A-001",
      invoiceDate: "2025-01-01",
      currency: "USD",
    },
    {
      id: ids.invoiceB1,
      organizationId: ids.orgB,
      workspaceId: ids.wsB1,
      invoiceNumber: "INV-B-001",
      invoiceDate: "2025-01-01",
      currency: "USD",
    },
  ]);

  await db.insert(timeEntries).values([
    {
      id: ids.timeEntryA1,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      matterId: ids.entityA1,
      dateWorked: "2025-01-15",
      timezoneId: "UTC",
      durationMinutes: 60,
      billedMinutes: 60,
      rateAtEntry: 200,
      currency: "USD",
      narrative: "Test entry A",
    },
    {
      id: ids.timeEntryB1,
      organizationId: ids.orgB,
      workspaceId: ids.wsB1,
      userId: ids.userB1,
      matterId: ids.entityB1,
      dateWorked: "2025-01-15",
      timezoneId: "UTC",
      durationMinutes: 60,
      billedMinutes: 60,
      rateAtEntry: 200,
      currency: "USD",
      narrative: "Test entry B",
    },
  ]);

  await db.insert(billingCodes).values([
    {
      id: ids.billingCodeA1,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      type: "task" as const,
      code: "T001",
      label: "Code A",
    },
    {
      id: ids.billingCodeB1,
      organizationId: ids.orgB,
      workspaceId: ids.wsB1,
      type: "task" as const,
      code: "T001",
      label: "Code B",
    },
  ]);

  await db.insert(rateTables).values([
    {
      id: ids.rateTableA1,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      name: "Rate A",
      currency: "USD",
    },
    {
      id: ids.rateTableB1,
      organizationId: ids.orgB,
      workspaceId: ids.wsB1,
      name: "Rate B",
      currency: "USD",
    },
  ]);

  await db.insert(rateEntries).values([
    {
      id: ids.rateEntryA1,
      workspaceId: ids.wsA1,
      rateTableId: ids.rateTableA1,
      userId: ids.userA1,
      hourlyRate: 200,
      effectiveFrom: "2025-01-01",
    },
    {
      id: ids.rateEntryB1,
      workspaceId: ids.wsB1,
      rateTableId: ids.rateTableB1,
      userId: ids.userB1,
      hourlyRate: 200,
      effectiveFrom: "2025-01-01",
    },
  ]);

  await db.insert(expenses).values([
    {
      id: ids.expenseA1,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      matterId: ids.entityA1,
      dateIncurred: "2025-01-15",
      amount: 100,
      currency: "USD",
      category: "filing_fee" as const,
      description: "Expense A",
    },
    {
      id: ids.expenseB1,
      organizationId: ids.orgB,
      workspaceId: ids.wsB1,
      userId: ids.userB1,
      matterId: ids.entityB1,
      dateIncurred: "2025-01-15",
      amount: 100,
      currency: "USD",
      category: "filing_fee" as const,
      description: "Expense B",
    },
  ]);

  // Case law global + tenant-scoped
  await db.insert(caseLawSources).values({
    id: ids.caseLawSourceId,
    adapterKey: `test-${ids.caseLawSourceId}`,
    name: "Test Source",
  });

  await db.insert(caseLawDecisions).values([
    {
      id: ids.caseLawDecisionA,
      sourceId: ids.caseLawSourceId,
      caseNumber: `CASE-A-${ids.caseLawDecisionA}`,
      court: "Test Court",
      country: "CZE",
      language: "cs",
    },
    {
      id: ids.caseLawDecisionB,
      sourceId: ids.caseLawSourceId,
      caseNumber: `CASE-B-${ids.caseLawDecisionB}`,
      court: "Test Court",
      country: "CZE",
      language: "cs",
    },
  ]);

  await db.insert(caseLawMatterLinks).values([
    {
      id: ids.caseLawMatterLinkA1,
      decisionId: ids.caseLawDecisionA,
      workspaceId: ids.wsA1,
      linkedBy: ids.userA1,
    },
    {
      id: ids.caseLawMatterLinkB1,
      decisionId: ids.caseLawDecisionB,
      workspaceId: ids.wsB1,
      linkedBy: ids.userB1,
    },
  ]);

  // ── Additional organization-scoped tables ────────

  await db.insert(contactRelationships).values([
    {
      id: ids.contactRelA,
      organizationId: ids.orgA,
      personId: ids.contactA,
      relatedContactId: ids.contactA2,
      relationshipType: "employee" as const,
    },
    {
      id: ids.contactRelB,
      organizationId: ids.orgB,
      personId: ids.contactB,
      relatedContactId: ids.contactB2,
      relationshipType: "employee" as const,
    },
  ]);

  await db.insert(templateVersions).values([
    {
      id: ids.templateVersionA,
      organizationId: ids.orgA,
      templateId: ids.templateA,
      version: 1,
      s3Key: "test/a-v1.docx",
      createdBy: ids.userA1,
    },
    {
      id: ids.templateVersionB,
      organizationId: ids.orgB,
      templateId: ids.templateB,
      version: 1,
      s3Key: "test/b-v1.docx",
      createdBy: ids.userB1,
    },
  ]);

  await db.insert(clauseVariants).values([
    {
      id: ids.clauseVariantA,
      organizationId: ids.orgA,
      clauseId: ids.clauseA,
      label: "Variant A",
      body: clauseBody,
    },
    {
      id: ids.clauseVariantB,
      organizationId: ids.orgB,
      clauseId: ids.clauseB,
      label: "Variant B",
      body: clauseBody,
    },
  ]);

  await db.insert(clauseVersions).values([
    {
      id: ids.clauseVersionA,
      organizationId: ids.orgA,
      clauseId: ids.clauseA,
      version: 1,
      body: clauseBody,
    },
    {
      id: ids.clauseVersionB,
      organizationId: ids.orgB,
      clauseId: ids.clauseB,
      version: 1,
      body: clauseBody,
    },
  ]);

  await db.insert(templateCategories).values([
    {
      id: ids.templateCategoryA,
      organizationId: ids.orgA,
      name: "Cat A",
    },
    {
      id: ids.templateCategoryB,
      organizationId: ids.orgB,
      name: "Cat B",
    },
  ]);

  await db.insert(templateClauses).values([
    {
      id: ids.templateClauseA,
      organizationId: ids.orgA,
      templateId: ids.templateA,
      clauseId: ids.clauseA,
    },
    {
      id: ids.templateClauseB,
      organizationId: ids.orgB,
      templateId: ids.templateB,
      clauseId: ids.clauseB,
    },
  ]);

  await db.insert(templateFills).values([
    {
      id: ids.templateFillA,
      organizationId: ids.orgA,
      templateId: ids.templateA,
      userId: ids.userA1,
      format: "docx",
      status: "completed",
    },
    {
      id: ids.templateFillB,
      organizationId: ids.orgB,
      templateId: ids.templateB,
      userId: ids.userB1,
      format: "docx",
      status: "completed",
    },
  ]);
};

// ── Policy introspection ───────────────────────────────

type PolicyRow = {
  table_name: string;
  policy_name: string;
  command: string;
  using_expr: string | null;
  check_expr: string | null;
};

/**
 * Fetch all RLS policies for the `stella` role.
 * Returns table name, policy name, and command type
 * (r=SELECT, a=INSERT, w=UPDATE, d=DELETE).
 */
export const fetchStellaPolicies = async (
  db: TestDatabase,
): Promise<PolicyRow[]> => {
  const rows = await db.execute<PolicyRow>(sql`
    SELECT c.relname AS table_name,
           p.polname AS policy_name,
           p.polcmd  AS command,
           pg_get_expr(p.polqual, p.polrelid)
             AS using_expr,
           pg_get_expr(p.polwithcheck, p.polrelid)
             AS check_expr
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE p.polroles @> ARRAY[
      (SELECT oid FROM pg_roles
       WHERE rolname = ${stella.name})
    ]::oid[]
    ORDER BY c.relname, p.polname
  `);
  return rows.rows;
};

/**
 * Fetch all tables that have a workspace_id or
 * organization_id column, to verify policy coverage.
 */
export const fetchScopedTables = async (
  db: TestDatabase,
): Promise<{ table_name: string; scope: "workspace" | "organization" }[]> => {
  const wsCol = entities.workspaceId.name;
  const orgCol = workspaces.organizationId.name;

  const rows = await db.execute<{
    table_name: string;
    scope: "workspace" | "organization";
  }>(sql`
    SELECT DISTINCT
      c.relname AS table_name,
      CASE
        WHEN a.attname = ${wsCol}
          THEN 'workspace'
        ELSE 'organization'
      END AS scope
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE a.attname IN (${wsCol}, ${orgCol})
      AND n.nspname = 'public'
      AND c.relkind = 'r'
      AND NOT a.attisdropped
    ORDER BY c.relname
  `);
  return rows.rows;
};
