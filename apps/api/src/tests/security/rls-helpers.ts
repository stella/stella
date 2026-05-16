import { sql } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";

import { member, organization, user } from "@/api/db/auth-schema";
import { stella, stellaIngestion } from "@/api/db/rls";
import {
  anonymizationBlacklistEntries,
  billingCodes,
  caseLawDecisions,
  caseLawMatterLinks,
  caseLawSources,
  chatMessages,
  chatThreads,
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
  fileChatThreads,
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
import type { SafeIdType } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

// ── ID generation ──────────────────────────────────────

const tid = () => Bun.randomUUIDv7();
const wsId = () => toSafeId<"workspace">(tid());
const orgId = () => toSafeId<"organization">(tid());
const id = <T extends SafeIdType>() => toSafeId<T>(tid());

// ── Test data IDs ──────────────────────────────────────

export const createTestIds = () => ({
  orgA: orgId(),
  orgB: orgId(),
  userA1: toSafeId<"user">(tid()),
  userA2: toSafeId<"user">(tid()),
  userB1: toSafeId<"user">(tid()),
  userAdmin: toSafeId<"user">(tid()),
  wsA1: wsId(),
  wsA2: wsId(),
  wsB1: wsId(),
  memberA1org: tid(),
  memberA2org: tid(),
  memberB1org: tid(),
  memberAdminOrg: tid(),
  memberA1wsA1: id<"workspaceMember">(),
  memberA1wsA2: id<"workspaceMember">(),
  memberA2wsA2: id<"workspaceMember">(),
  memberB1wsB1: id<"workspaceMember">(),
  // Workspace-scoped rows
  entityA1: id<"entity">(),
  entityA2: id<"entity">(),
  entityB1: id<"entity">(),
  entityVersionA1: id<"entityVersion">(),
  entityVersionA2: id<"entityVersion">(),
  entityVersionB1: id<"entityVersion">(),
  propertyA1: id<"property">(),
  propertyA2: id<"property">(),
  propertyB1: id<"property">(),
  fieldA1: id<"field">(),
  fieldA2: id<"field">(),
  fieldB1: id<"field">(),
  docCounterA1: id<"documentCounter">(),
  docCounterB1: id<"documentCounter">(),
  wsContactA1: id<"workspaceContact">(),
  wsContactB1: id<"workspaceContact">(),
  propDepA1: id<"propertyDependency">(),
  propDepB1: id<"propertyDependency">(),
  justificationA1: id<"justification">(),
  justificationB1: id<"justification">(),
  timeEntryA1: id<"timeEntry">(),
  timeEntryB1: id<"timeEntry">(),
  billingCodeA1: id<"billingCode">(),
  billingCodeB1: id<"billingCode">(),
  rateTableA1: id<"rateTable">(),
  rateTableB1: id<"rateTable">(),
  rateEntryA1: id<"rateEntry">(),
  rateEntryB1: id<"rateEntry">(),
  expenseA1: id<"expense">(),
  expenseB1: id<"expense">(),
  invoiceA1: id<"invoice">(),
  invoiceB1: id<"invoice">(),
  caseLawSourceId: id<"caseLawSource">(),
  caseLawDecisionA: id<"caseLawDecision">(),
  caseLawDecisionB: id<"caseLawDecision">(),
  caseLawMatterLinkA1: id<"caseLawMatterLink">(),
  caseLawMatterLinkB1: id<"caseLawMatterLink">(),
  chatThreadGlobalA1: id<"chatThread">(),
  chatThreadWorkspaceA1: id<"chatThread">(),
  chatThreadWorkspaceA2: id<"chatThread">(),
  chatThreadWorkspaceB1: id<"chatThread">(),
  chatMessageGlobalA1: id<"chatMessage">(),
  chatMessageWorkspaceA1: id<"chatMessage">(),
  chatMessageWorkspaceA2: id<"chatMessage">(),
  chatMessageWorkspaceB1: id<"chatMessage">(),
  fileChatThreadA1: id<"fileChatThread">(),
  // Additional properties for dependencies
  propertyA1dep: id<"property">(),
  propertyB1dep: id<"property">(),
  // Org-scoped rows
  contactA: id<"contact">(),
  contactA2: id<"contact">(),
  contactB: id<"contact">(),
  contactB2: id<"contact">(),
  contactRelA: id<"contactRelationship">(),
  contactRelB: id<"contactRelationship">(),
  templateA: id<"template">(),
  templateB: id<"template">(),
  templateVersionA: id<"templateVersion">(),
  templateVersionB: id<"templateVersion">(),
  templateCategoryA: id<"templateCategory">(),
  templateCategoryB: id<"templateCategory">(),
  templateClauseA: id<"templateClause">(),
  templateClauseB: id<"templateClause">(),
  templateFillA: id<"templateFill">(),
  templateFillB: id<"templateFill">(),
  clauseCategoryA: id<"clauseCategory">(),
  clauseCategoryB: id<"clauseCategory">(),
  clauseA: id<"clause">(),
  clauseB: id<"clause">(),
  clauseVariantA: id<"clauseVariant">(),
  clauseVariantB: id<"clauseVariant">(),
  clauseVersionA: id<"clauseVersion">(),
  clauseVersionB: id<"clauseVersion">(),
  orgSettingsA: id<"organizationSettings">(),
  orgSettingsB: id<"organizationSettings">(),
  anonymizationBlacklistEntryA: id<"anonymizationBlacklistEntry">(),
  anonymizationBlacklistEntryB: id<"anonymizationBlacklistEntry">(),
  matterCounterA: id<"matterCounter">(),
  matterCounterB: id<"matterCounter">(),
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
  anonymizationBlacklistEntries,
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
      name: "entityA1",
    },
    {
      id: ids.entityA2,
      workspaceId: ids.wsA2,
      kind: "document" as const,
      name: "entityA2",
    },
    {
      id: ids.entityB1,
      workspaceId: ids.wsB1,
      kind: "document" as const,
      name: "entityB1",
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
      status: "fresh",
    },
    {
      id: ids.propertyA2,
      workspaceId: ids.wsA2,
      name: "Prop A2",
      content: propContent,
      tool: propTool,
      status: "fresh",
    },
    {
      id: ids.propertyB1,
      workspaceId: ids.wsB1,
      name: "Prop B1",
      content: propContent,
      tool: propTool,
      status: "fresh",
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

  await db.insert(anonymizationBlacklistEntries).values([
    {
      id: ids.anonymizationBlacklistEntryA,
      organizationId: ids.orgA,
      label: "organization",
      canonical: "Acme A",
      variants: [],
      createdBy: ids.userA1,
      updatedBy: ids.userA1,
    },
    {
      id: ids.anonymizationBlacklistEntryB,
      organizationId: ids.orgB,
      label: "organization",
      canonical: "Acme B",
      variants: [],
      createdBy: ids.userB1,
      updatedBy: ids.userB1,
    },
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
      status: "fresh",
    },
    {
      id: ids.propertyB1dep,
      workspaceId: ids.wsB1,
      name: "Dep B1",
      content: propContent,
      tool: propTool,
      status: "fresh",
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
      content: {
        version: 1,
        blocks: [
          {
            kind: "pdf-bates" as const,
            fileFieldId: ids.fieldA1,
            statements: [
              {
                text: "a1",
                citations: [{ bates: "F0-0001", pageNumber: 1 }],
              },
            ],
          },
        ],
      },
    },
    {
      id: ids.justificationB1,
      workspaceId: ids.wsB1,
      fieldId: ids.fieldB1,
      content: {
        version: 1,
        blocks: [
          {
            kind: "pdf-bates" as const,
            fileFieldId: ids.fieldB1,
            statements: [
              {
                text: "b1",
                citations: [{ bates: "F0-0001", pageNumber: 1 }],
              },
            ],
          },
        ],
      },
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
      rateAtEntry: cents(200),
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
      rateAtEntry: cents(200),
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
      hourlyRate: cents(200),
      effectiveFrom: "2025-01-01",
    },
    {
      id: ids.rateEntryB1,
      workspaceId: ids.wsB1,
      rateTableId: ids.rateTableB1,
      userId: ids.userB1,
      hourlyRate: cents(200),
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
      amount: cents(100),
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
      amount: cents(100),
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

  await db.insert(chatThreads).values([
    {
      id: ids.chatThreadGlobalA1,
      organizationId: ids.orgA,
      userId: ids.userA1,
      title: "Global thread A1",
      workspaceId: null,
    },
    {
      id: ids.chatThreadWorkspaceA1,
      organizationId: ids.orgA,
      userId: ids.userA1,
      title: "Workspace thread A1",
      workspaceId: ids.wsA1,
    },
    {
      id: ids.chatThreadWorkspaceA2,
      organizationId: ids.orgA,
      userId: ids.userA1,
      title: "Workspace thread A2",
      workspaceId: ids.wsA2,
    },
    {
      id: ids.chatThreadWorkspaceB1,
      organizationId: ids.orgB,
      userId: ids.userB1,
      title: "Workspace thread B1",
      workspaceId: ids.wsA1,
    },
  ]);

  await db.insert(fileChatThreads).values({
    id: ids.fileChatThreadA1,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    userId: ids.userA1,
    entityId: ids.entityA1,
    fieldId: ids.fieldA1,
    chatThreadId: ids.chatThreadWorkspaceA1,
  });

  const chatContent = (text: string) => ({
    version: 1 as const,
    data: [{ type: "text" as const, text }],
  });

  await db.insert(chatMessages).values([
    {
      id: ids.chatMessageGlobalA1,
      threadId: ids.chatThreadGlobalA1,
      userId: ids.userA1,
      workspaceId: null,
      role: "user",
      content: chatContent("global"),
    },
    {
      id: ids.chatMessageWorkspaceA1,
      threadId: ids.chatThreadWorkspaceA1,
      userId: ids.userA1,
      workspaceId: ids.wsA1,
      role: "user",
      content: chatContent("workspace-a1"),
    },
    {
      id: ids.chatMessageWorkspaceA2,
      threadId: ids.chatThreadWorkspaceA2,
      userId: ids.userA1,
      workspaceId: ids.wsA2,
      role: "user",
      content: chatContent("workspace-a2"),
    },
    {
      id: ids.chatMessageWorkspaceB1,
      threadId: ids.chatThreadWorkspaceB1,
      userId: ids.userB1,
      workspaceId: ids.wsA1,
      role: "user",
      content: chatContent("workspace-b1"),
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

type TablePrivilegeRow = {
  table_name: string;
  privilege: "DELETE" | "INSERT" | "SELECT" | "UPDATE";
};

/**
 * Fetch all RLS policies for the `stella` role.
 * Returns table name, policy name, and command type
 * (r=SELECT, a=INSERT, w=UPDATE, d=DELETE).
 */
export const fetchStellaPolicies = async (
  db: TestDatabase,
): Promise<PolicyRow[]> => await fetchPoliciesForRole(db, stella.name);

export const fetchStellaIngestionPolicies = async (
  db: TestDatabase,
): Promise<PolicyRow[]> => await fetchPoliciesForRole(db, stellaIngestion.name);

const fetchPoliciesForRole = async (
  db: TestDatabase,
  roleName: string,
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
       WHERE rolname = ${roleName})
    ]::oid[]
    ORDER BY c.relname, p.polname
  `);
  return rows.rows;
};

export const fetchStellaTablePrivileges = async (
  db: TestDatabase,
): Promise<TablePrivilegeRow[]> =>
  await fetchTablePrivilegesForRole(db, stella.name);

export const fetchStellaIngestionTablePrivileges = async (
  db: TestDatabase,
): Promise<TablePrivilegeRow[]> =>
  await fetchTablePrivilegesForRole(db, stellaIngestion.name);

const fetchTablePrivilegesForRole = async (
  db: TestDatabase,
  roleName: string,
): Promise<TablePrivilegeRow[]> => {
  const rows = await db.execute<TablePrivilegeRow>(sql`
    SELECT c.relname AS table_name,
           privilege.value AS privilege
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN (VALUES
      ('SELECT'),
      ('INSERT'),
      ('UPDATE'),
      ('DELETE')
    ) AS privilege(value)
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND has_table_privilege(${roleName}, c.oid, privilege.value)
    ORDER BY c.relname, privilege.value
  `);
  return rows.rows;
};

type ColumnPrivilegeRow = {
  column_name: string;
  privilege: "UPDATE";
  table_name: string;
};

export const fetchStellaIngestionColumnPrivileges = async (
  db: TestDatabase,
): Promise<ColumnPrivilegeRow[]> => {
  const rows = await db.execute<ColumnPrivilegeRow>(sql`
    SELECT c.relname AS table_name,
           a.attname AS column_name,
           'UPDATE' AS privilege
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND has_column_privilege(
        ${stellaIngestion.name},
        c.oid,
        a.attname,
        'UPDATE'
      )
    ORDER BY c.relname, a.attname
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
