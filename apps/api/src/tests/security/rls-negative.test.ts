import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, getTableName, sql } from "drizzle-orm";

import { stella } from "@/api/db/rls";
import {
  billingCodes,
  caseLawDecisions,
  caseLawMatterLinks,
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
import type { SafeIdType } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import {
  orgScopedTables,
  wsScopedTables,
} from "@/api/tests/security/rls-helpers";
import type {
  InsertCase,
  MutationCase,
  TestIds,
} from "@/api/tests/security/rls-helpers";
import type {
  TestDatabase,
  TestDatabaseTransaction,
  createDryScopedQuery,
  createScopedQuery,
} from "@/api/tests/security/test-utils";

const testId = <T extends SafeIdType>() => toSafeId<T>(Bun.randomUUIDv7());

let testDb: TestDatabase;
let ids: TestIds;
let scopedQuery: ReturnType<typeof createScopedQuery>;
let dryScopedQuery: ReturnType<typeof createDryScopedQuery>;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedQuery = fixture.scopedQuery;
  dryScopedQuery = fixture.dryScopedQuery;
});

afterAll(async () => {
  await releaseRlsFixture();
});

const clauseBody: ClauseBody = [{ text: "test" }];

type WorkspaceScopedTable = (typeof wsScopedTables)[number];
type OrganizationScopedTable = (typeof orgScopedTables)[number];

const addWrongWorkspaceSelectTests = (table: WorkspaceScopedTable) => {
  const tableName = getTableName(table);

  test(`${tableName}: wrong workspace IDs → zero rows`, async () => {
    const c = await scopedQuery([ids.wsB1], ids.orgB, (tx) =>
      tx.$count(table, eq(table.workspaceId, ids.wsA1)),
    );
    expect(c).toBe(0);
  });

  test(`${tableName}: empty workspace IDs → zero rows`, async () => {
    const c = await scopedQuery([], ids.orgA, (tx) => tx.$count(table));
    expect(c).toBe(0);
  });
};

const addWrongOrganizationSelectTest = (table: OrganizationScopedTable) => {
  const tableName = getTableName(table);

  test(`${tableName}: wrong org ID → zero rows`, async () => {
    const c = await scopedQuery([ids.wsA1], ids.orgA, (tx) =>
      tx.$count(table, eq(table.organizationId, ids.orgB)),
    );
    expect(c).toBe(0);
  });
};

const addWrongWorkspaceInsertTest = ({ table, values }: InsertCase) => {
  test(`INSERT ${getTableName(table)} with wrong workspace_id → policy violation`, async () => {
    const error = await scopedQuery([ids.wsA1], ids.orgA, async (tx) =>
      tryCatch(async () => values(tx)),
    );
    expect(isPgError(error, PG_ERROR.INSUFFICIENT_PRIVILEGE)).toBe(true);
  });
};

const addWrongOrganizationInsertTest = ({ table, values }: InsertCase) => {
  test(`INSERT ${getTableName(table)} with wrong org_id → policy violation`, async () => {
    const error = await scopedQuery([ids.wsA1], ids.orgA, async (tx) =>
      tryCatch(async () => values(tx)),
    );
    expect(isPgError(error, PG_ERROR.INSUFFICIENT_PRIVILEGE)).toBe(true);
  });
};

const addZeroAffectedMutationTest = (
  { table, query }: MutationCase,
  action: "UPDATE" | "DELETE",
  scopeLabel: "workspace" | "org",
) => {
  test(`${action} ${getTableName(table)} in other ${scopeLabel} → zero affected`, async () => {
    const rows = await scopedQuery([ids.wsA1], ids.orgA, query);
    expect(rows).toHaveLength(0);
  });
};

// ════════════════════════════════════════════════════════
// SELECT: wrong scope → zero rows
// ════════════════════════════════════════════════════════

describe("workspace SELECT — wrong scope", () => {
  for (const table of wsScopedTables) {
    addWrongWorkspaceSelectTests(table);
  }
});

describe("organization SELECT — wrong scope", () => {
  for (const table of orgScopedTables) {
    addWrongOrganizationSelectTest(table);
  }
});

describe("chat SELECT — wrong user or workspace", () => {
  test("same user in another organization cannot read global chat rows", async () => {
    const c = await scopedQuery(
      [ids.wsB1],
      ids.orgB,
      (tx) =>
        tx.$count(chatThreads, eq(chatThreads.id, ids.chatThreadGlobalA1)),
      ids.userA1,
    );
    expect(c).toBe(0);
  });

  test("same user in another organization cannot read global chat messages", async () => {
    const c = await scopedQuery(
      [ids.wsB1],
      ids.orgB,
      (tx) =>
        tx.$count(chatMessages, eq(chatMessages.id, ids.chatMessageGlobalA1)),
      ids.userA1,
    );
    expect(c).toBe(0);
  });

  test("different user in the same workspace sees zero rows", async () => {
    const c = await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      (tx) =>
        tx.$count(chatThreads, eq(chatThreads.id, ids.chatThreadWorkspaceB1)),
      ids.userA1,
    );
    expect(c).toBe(0);
  });

  test("different user in the same workspace cannot read file chat mappings", async () => {
    const c = await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      (tx) =>
        tx.$count(
          fileChatThreads,
          eq(fileChatThreads.id, ids.fileChatThreadA1),
        ),
      ids.userA2,
    );
    expect(c).toBe(0);
  });

  test("same user in an inaccessible workspace sees zero rows", async () => {
    const c = await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      (tx) =>
        tx.$count(
          chatMessages,
          eq(chatMessages.id, ids.chatMessageWorkspaceA2),
        ),
      ids.userA1,
    );
    expect(c).toBe(0);
  });
});

describe("global case-law corpus mutations", () => {
  test("scoped stella can read global decisions", async () => {
    const count = await scopedQuery([ids.wsA1], ids.orgA, (tx) =>
      tx.$count(caseLawDecisions),
    );
    expect(count).toBeGreaterThan(0);
  });

  test("scoped stella cannot insert global decisions", async () => {
    const error = await tryCatch(async () =>
      scopedQuery([ids.wsA1], ids.orgA, async (tx) => {
        await tx.insert(caseLawDecisions).values({
          id: testId(),
          sourceId: ids.caseLawSourceId,
          caseNumber: "FORBIDDEN-INSERT",
          court: "Forbidden Court",
          country: "CZE",
          language: "cs",
        });
      }),
    );
    expect(isPgError(error, PG_ERROR.INSUFFICIENT_PRIVILEGE)).toBe(true);
  });

  test("scoped stella cannot update global decisions", async () => {
    const error = await tryCatch(async () =>
      scopedQuery([ids.wsA1], ids.orgA, async (tx) => {
        await tx
          .update(caseLawDecisions)
          .set({ court: "Forbidden Court" })
          .where(eq(caseLawDecisions.id, ids.caseLawDecisionA));
      }),
    );
    expect(isPgError(error, PG_ERROR.INSUFFICIENT_PRIVILEGE)).toBe(true);
  });

  test("scoped stella cannot delete global decisions", async () => {
    const error = await tryCatch(async () =>
      scopedQuery([ids.wsA1], ids.orgA, async (tx) => {
        await tx
          .delete(caseLawDecisions)
          .where(eq(caseLawDecisions.id, ids.caseLawDecisionA));
      }),
    );
    expect(isPgError(error, PG_ERROR.INSUFFICIENT_PRIVILEGE)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════
// INSERT: wrong scope → policy violation
// ════════════════════════════════════════════════════════

const tryCatch = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
};

describe("workspace INSERT — wrong scope", () => {
  const cases: InsertCase[] = [
    {
      table: entities,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(entities).values({
          id: testId(),
          workspaceId: ids.wsB1,
          kind: "document" as const,
          name: "rls negative scope",
        }),
    },
    {
      table: entityVersions,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(entityVersions).values({
          id: testId(),
          workspaceId: ids.wsB1,
          entityId: ids.entityB1,
        }),
    },
    {
      table: properties,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(properties).values({
          id: testId(),
          workspaceId: ids.wsB1,
          name: "Bad",
          content: {
            version: 1 as const,
            type: "text" as const,
          },
          tool: {
            version: 1 as const,
            type: "manual-input" as const,
          },
          status: "fresh",
        }),
    },
    {
      table: fields,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(fields).values({
          id: testId(),
          workspaceId: ids.wsB1,
          propertyId: ids.propertyB1,
          entityVersionId: ids.entityVersionB1,
          content: {
            version: 1 as const,
            type: "text" as const,
            value: "bad",
          },
        }),
    },
    {
      table: workspaceMembers,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(workspaceMembers).values({
          id: testId(),
          workspaceId: ids.wsB1,
          userId: ids.userA1,
        }),
    },
    {
      table: documentCounters,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(documentCounters).values({
          id: testId(),
          workspaceId: ids.wsB1,
          lastValue: 0,
        }),
    },
    {
      table: workspaceContacts,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(workspaceContacts).values({
          id: testId(),
          organizationId: ids.orgB,
          workspaceId: ids.wsB1,
          contactId: ids.contactB,
          role: "opposing_party" as const,
        }),
    },
    {
      table: propertyDependencies,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(propertyDependencies).values({
          id: testId(),
          workspaceId: ids.wsB1,
          propertyId: ids.propertyB1,
          dependsOnPropertyId: ids.propertyB1dep,
        }),
    },
    {
      table: justifications,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(justifications).values({
          id: testId(),
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
                    text: "bad",
                    citations: [{ bates: "F0-0001", pageNumber: 1 }],
                  },
                ],
              },
            ],
          },
        }),
    },
    {
      table: timeEntries,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(timeEntries).values({
          id: testId(),
          organizationId: ids.orgA,
          workspaceId: ids.wsB1,
          userId: ids.userA1,
          matterId: ids.entityA1,
          dateWorked: "2025-06-01",
          timezoneId: "UTC",
          durationMinutes: 30,
          billedMinutes: 30,
          rateAtEntry: cents(100),
          currency: "USD",
          narrative: "bad",
        }),
    },
    {
      table: billingCodes,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(billingCodes).values({
          id: testId(),
          organizationId: ids.orgA,
          workspaceId: ids.wsB1,
          type: "task" as const,
          code: "BAD",
          label: "Bad",
        }),
    },
    {
      table: rateTables,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(rateTables).values({
          id: testId(),
          organizationId: ids.orgA,
          workspaceId: ids.wsB1,
          name: "Bad",
          currency: "USD",
        }),
    },
    {
      table: rateEntries,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(rateEntries).values({
          id: testId(),
          workspaceId: ids.wsB1,
          rateTableId: ids.rateTableB1,
          hourlyRate: cents(100),
          effectiveFrom: "2025-01-01",
        }),
    },
    {
      table: expenses,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(expenses).values({
          id: testId(),
          organizationId: ids.orgA,
          workspaceId: ids.wsB1,
          userId: ids.userA1,
          matterId: ids.entityB1,
          dateIncurred: "2025-06-01",
          amount: cents(100),
          currency: "USD",
          category: "filing_fee" as const,
          description: "bad",
        }),
    },
    {
      table: invoices,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(invoices).values({
          id: testId(),
          organizationId: ids.orgA,
          workspaceId: ids.wsB1,
          invoiceNumber: "BAD-001",
          invoiceDate: "2025-01-01",
          currency: "USD",
        }),
    },
    {
      table: caseLawMatterLinks,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(caseLawMatterLinks).values({
          id: testId(),
          decisionId: ids.caseLawDecisionA,
          workspaceId: ids.wsB1,
          linkedBy: ids.userA1,
        }),
    },
  ];

  for (const insertCase of cases) {
    addWrongWorkspaceInsertTest(insertCase);
  }
});

describe("organization INSERT — wrong scope", () => {
  const cases: InsertCase[] = [
    {
      table: contacts,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(contacts).values({
          id: testId(),
          organizationId: ids.orgB,
          type: "person" as const,
          displayName: "Bad",
        }),
    },
    {
      table: contactRelationships,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(contactRelationships).values({
          id: testId(),
          organizationId: ids.orgB,
          personId: ids.contactB,
          relatedContactId: ids.contactB2,
          relationshipType: "employee" as const,
        }),
    },
    {
      table: templates,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(templates).values({
          id: testId(),
          organizationId: ids.orgB,
          name: "Bad",
          fileName: "bad.docx",
          s3Key: "test/bad.docx",
          sizeBytes: 1024,
          createdBy: ids.userA1,
        }),
    },
    {
      table: templateVersions,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(templateVersions).values({
          id: testId(),
          organizationId: ids.orgB,
          templateId: ids.templateB,
          version: 99,
          s3Key: "test/bad-v99.docx",
          createdBy: ids.userA1,
        }),
    },
    {
      table: templateCategories,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(templateCategories).values({
          id: testId(),
          organizationId: ids.orgB,
          name: "Bad",
        }),
    },
    {
      table: templateClauses,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(templateClauses).values({
          id: testId(),
          organizationId: ids.orgB,
          templateId: ids.templateB,
          clauseId: ids.clauseB,
        }),
    },
    {
      table: templateFills,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(templateFills).values({
          id: testId(),
          organizationId: ids.orgB,
          templateId: ids.templateB,
          userId: ids.userB1,
          format: "docx",
          status: "completed",
        }),
    },
    {
      table: clauseCategories,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(clauseCategories).values({
          id: testId(),
          organizationId: ids.orgB,
          name: "Bad",
        }),
    },
    {
      table: clauses,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(clauses).values({
          id: testId(),
          organizationId: ids.orgB,
          title: "Bad",
          body: clauseBody,
          createdBy: ids.userA1,
        }),
    },
    {
      table: clauseVariants,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(clauseVariants).values({
          id: testId(),
          organizationId: ids.orgB,
          clauseId: ids.clauseB,
          label: "Bad",
          body: clauseBody,
        }),
    },
    {
      table: clauseVersions,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(clauseVersions).values({
          id: testId(),
          organizationId: ids.orgB,
          clauseId: ids.clauseB,
          version: 99,
          body: clauseBody,
        }),
    },
    {
      table: organizationSettings,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(organizationSettings).values({
          id: testId(),
          organizationId: ids.orgB,
        }),
    },
    {
      table: matterCounters,
      values: async (tx: TestDatabaseTransaction) =>
        tx.insert(matterCounters).values({
          id: testId(),
          organizationId: ids.orgB,
          scopeKey: "bad",
          lastValue: 0,
        }),
    },
  ];

  for (const insertCase of cases) {
    addWrongOrganizationInsertTest(insertCase);
  }
});

// ════════════════════════════════════════════════════════
// UPDATE: wrong scope → zero affected
// ════════════════════════════════════════════════════════

describe("workspace UPDATE — wrong scope", () => {
  const cases: MutationCase[] = [
    {
      table: entities,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(entities)
          .set({ name: "hacked" })
          .where(eq(entities.id, ids.entityB1))
          .returning({ id: entities.id }),
    },
    {
      table: entityVersions,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(entityVersions)
          .set({ stamp: "hacked" })
          .where(eq(entityVersions.id, ids.entityVersionB1))
          .returning({ id: entityVersions.id }),
    },
    {
      table: properties,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(properties)
          .set({ name: "hacked" })
          .where(eq(properties.id, ids.propertyB1))
          .returning({ id: properties.id }),
    },
    {
      table: fields,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(fields)
          .set({
            content: {
              version: 1 as const,
              type: "text" as const,
              value: "hacked",
            },
          })
          .where(eq(fields.id, ids.fieldB1))
          .returning({ id: fields.id }),
    },
    {
      table: workspaceMembers,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(workspaceMembers)
          .set({ createdAt: new Date() })
          .where(eq(workspaceMembers.id, ids.memberB1wsB1))
          .returning({ id: workspaceMembers.id }),
    },
    {
      table: documentCounters,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(documentCounters)
          .set({ lastValue: 999 })
          .where(eq(documentCounters.id, ids.docCounterB1))
          .returning({ id: documentCounters.id }),
    },
    {
      table: workspaceContacts,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(workspaceContacts)
          .set({ notes: "hacked" })
          .where(eq(workspaceContacts.id, ids.wsContactB1))
          .returning({ id: workspaceContacts.id }),
    },
    {
      table: propertyDependencies,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(propertyDependencies)
          .set({ condition: null })
          .where(eq(propertyDependencies.id, ids.propDepB1))
          .returning({ id: propertyDependencies.id }),
    },
    {
      table: justifications,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(justifications)
          .set({
            content: {
              version: 1,
              blocks: [
                {
                  kind: "pdf-bates" as const,
                  fileFieldId: ids.fieldB1,
                  statements: [
                    {
                      text: "hacked",
                      citations: [{ bates: "F0-0001", pageNumber: 1 }],
                    },
                  ],
                },
              ],
            },
          })
          .where(eq(justifications.id, ids.justificationB1))
          .returning({ id: justifications.id }),
    },
    {
      table: timeEntries,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(timeEntries)
          .set({ narrative: "hacked" })
          .where(eq(timeEntries.id, ids.timeEntryB1))
          .returning({ id: timeEntries.id }),
    },
    {
      table: billingCodes,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(billingCodes)
          .set({ label: "hacked" })
          .where(eq(billingCodes.id, ids.billingCodeB1))
          .returning({ id: billingCodes.id }),
    },
    {
      table: rateTables,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(rateTables)
          .set({ name: "hacked" })
          .where(eq(rateTables.id, ids.rateTableB1))
          .returning({ id: rateTables.id }),
    },
    {
      table: rateEntries,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(rateEntries)
          .set({ hourlyRate: cents(9999) })
          .where(eq(rateEntries.id, ids.rateEntryB1))
          .returning({ id: rateEntries.id }),
    },
    {
      table: expenses,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(expenses)
          .set({ description: "hacked" })
          .where(eq(expenses.id, ids.expenseB1))
          .returning({ id: expenses.id }),
    },
    {
      table: invoices,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(invoices)
          .set({ notes: "hacked" })
          .where(eq(invoices.id, ids.invoiceB1))
          .returning({ id: invoices.id }),
    },
    {
      table: caseLawMatterLinks,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(caseLawMatterLinks)
          .set({ note: "hacked" })
          .where(eq(caseLawMatterLinks.id, ids.caseLawMatterLinkB1))
          .returning({ id: caseLawMatterLinks.id }),
    },
  ];

  for (const mutationCase of cases) {
    addZeroAffectedMutationTest(mutationCase, "UPDATE", "workspace");
  }
});

describe("organization UPDATE — wrong scope", () => {
  const cases: MutationCase[] = [
    {
      table: contacts,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(contacts)
          .set({ displayName: "hacked" })
          .where(eq(contacts.id, ids.contactB))
          .returning({ id: contacts.id }),
    },
    {
      table: contactRelationships,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(contactRelationships)
          .set({ title: "hacked" })
          .where(eq(contactRelationships.id, ids.contactRelB))
          .returning({ id: contactRelationships.id }),
    },
    {
      table: templates,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(templates)
          .set({ name: "hacked" })
          .where(eq(templates.id, ids.templateB))
          .returning({ id: templates.id }),
    },
    {
      table: templateVersions,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(templateVersions)
          .set({ fieldCount: 999 })
          .where(eq(templateVersions.id, ids.templateVersionB))
          .returning({ id: templateVersions.id }),
    },
    {
      table: templateCategories,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(templateCategories)
          .set({ name: "hacked" })
          .where(eq(templateCategories.id, ids.templateCategoryB))
          .returning({ id: templateCategories.id }),
    },
    {
      table: templateClauses,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(templateClauses)
          .set({ sortOrder: 999 })
          .where(eq(templateClauses.id, ids.templateClauseB))
          .returning({ id: templateClauses.id }),
    },
    {
      table: templateFills,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(templateFills)
          .set({ status: "pending" })
          .where(eq(templateFills.id, ids.templateFillB))
          .returning({ id: templateFills.id }),
    },
    {
      table: clauseCategories,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(clauseCategories)
          .set({ name: "hacked" })
          .where(eq(clauseCategories.id, ids.clauseCategoryB))
          .returning({ id: clauseCategories.id }),
    },
    {
      table: clauses,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(clauses)
          .set({ title: "hacked" })
          .where(eq(clauses.id, ids.clauseB))
          .returning({ id: clauses.id }),
    },
    {
      table: clauseVariants,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(clauseVariants)
          .set({ label: "hacked" })
          .where(eq(clauseVariants.id, ids.clauseVariantB))
          .returning({ id: clauseVariants.id }),
    },
    {
      table: clauseVersions,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(clauseVersions)
          .set({ body: clauseBody })
          .where(eq(clauseVersions.id, ids.clauseVersionB))
          .returning({ id: clauseVersions.id }),
    },
    {
      table: organizationSettings,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(organizationSettings)
          .set({ matterNumberPattern: "hacked" })
          .where(eq(organizationSettings.id, ids.orgSettingsB))
          .returning({ id: organizationSettings.id }),
    },
    {
      table: matterCounters,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .update(matterCounters)
          .set({ lastValue: 999 })
          .where(eq(matterCounters.id, ids.matterCounterB))
          .returning({ id: matterCounters.id }),
    },
  ];

  for (const mutationCase of cases) {
    addZeroAffectedMutationTest(mutationCase, "UPDATE", "org");
  }
});

// ════════════════════════════════════════════════════════
// DELETE: wrong scope → zero affected
// ════════════════════════════════════════════════════════

describe("workspace DELETE — wrong scope", () => {
  const cases: MutationCase[] = [
    {
      table: entities,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(entities)
          .where(eq(entities.id, ids.entityB1))
          .returning({ id: entities.id }),
    },
    {
      table: entityVersions,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(entityVersions)
          .where(eq(entityVersions.id, ids.entityVersionB1))
          .returning({ id: entityVersions.id }),
    },
    {
      table: properties,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(properties)
          .where(eq(properties.id, ids.propertyB1))
          .returning({ id: properties.id }),
    },
    {
      table: fields,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(fields)
          .where(eq(fields.id, ids.fieldB1))
          .returning({ id: fields.id }),
    },
    {
      table: workspaceMembers,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(workspaceMembers)
          .where(eq(workspaceMembers.id, ids.memberB1wsB1))
          .returning({ id: workspaceMembers.id }),
    },
    {
      table: documentCounters,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(documentCounters)
          .where(eq(documentCounters.id, ids.docCounterB1))
          .returning({ id: documentCounters.id }),
    },
    {
      table: workspaceContacts,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(workspaceContacts)
          .where(eq(workspaceContacts.id, ids.wsContactB1))
          .returning({ id: workspaceContacts.id }),
    },
    {
      table: propertyDependencies,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(propertyDependencies)
          .where(eq(propertyDependencies.id, ids.propDepB1))
          .returning({ id: propertyDependencies.id }),
    },
    {
      table: justifications,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(justifications)
          .where(eq(justifications.id, ids.justificationB1))
          .returning({ id: justifications.id }),
    },
    {
      table: timeEntries,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(timeEntries)
          .where(eq(timeEntries.id, ids.timeEntryB1))
          .returning({ id: timeEntries.id }),
    },
    {
      table: billingCodes,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(billingCodes)
          .where(eq(billingCodes.id, ids.billingCodeB1))
          .returning({ id: billingCodes.id }),
    },
    {
      table: rateTables,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(rateTables)
          .where(eq(rateTables.id, ids.rateTableB1))
          .returning({ id: rateTables.id }),
    },
    {
      table: rateEntries,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(rateEntries)
          .where(eq(rateEntries.id, ids.rateEntryB1))
          .returning({ id: rateEntries.id }),
    },
    {
      table: expenses,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(expenses)
          .where(eq(expenses.id, ids.expenseB1))
          .returning({ id: expenses.id }),
    },
    {
      table: invoices,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(invoices)
          .where(eq(invoices.id, ids.invoiceB1))
          .returning({ id: invoices.id }),
    },
    {
      table: caseLawMatterLinks,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(caseLawMatterLinks)
          .where(eq(caseLawMatterLinks.id, ids.caseLawMatterLinkB1))
          .returning({ id: caseLawMatterLinks.id }),
    },
  ];

  for (const mutationCase of cases) {
    addZeroAffectedMutationTest(mutationCase, "DELETE", "workspace");
  }
});

describe("organization DELETE — wrong scope", () => {
  const cases: MutationCase[] = [
    {
      table: contacts,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(contacts)
          .where(eq(contacts.id, ids.contactB))
          .returning({ id: contacts.id }),
    },
    {
      table: contactRelationships,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(contactRelationships)
          .where(eq(contactRelationships.id, ids.contactRelB))
          .returning({ id: contactRelationships.id }),
    },
    {
      table: templates,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(templates)
          .where(eq(templates.id, ids.templateB))
          .returning({ id: templates.id }),
    },
    {
      table: templateVersions,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(templateVersions)
          .where(eq(templateVersions.id, ids.templateVersionB))
          .returning({ id: templateVersions.id }),
    },
    {
      table: templateCategories,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(templateCategories)
          .where(eq(templateCategories.id, ids.templateCategoryB))
          .returning({ id: templateCategories.id }),
    },
    {
      table: templateClauses,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(templateClauses)
          .where(eq(templateClauses.id, ids.templateClauseB))
          .returning({ id: templateClauses.id }),
    },
    {
      table: templateFills,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(templateFills)
          .where(eq(templateFills.id, ids.templateFillB))
          .returning({ id: templateFills.id }),
    },
    {
      table: clauseCategories,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(clauseCategories)
          .where(eq(clauseCategories.id, ids.clauseCategoryB))
          .returning({ id: clauseCategories.id }),
    },
    {
      table: clauses,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(clauses)
          .where(eq(clauses.id, ids.clauseB))
          .returning({ id: clauses.id }),
    },
    {
      table: clauseVariants,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(clauseVariants)
          .where(eq(clauseVariants.id, ids.clauseVariantB))
          .returning({ id: clauseVariants.id }),
    },
    {
      table: clauseVersions,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(clauseVersions)
          .where(eq(clauseVersions.id, ids.clauseVersionB))
          .returning({ id: clauseVersions.id }),
    },
    {
      table: organizationSettings,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(organizationSettings)
          .where(eq(organizationSettings.id, ids.orgSettingsB))
          .returning({ id: organizationSettings.id }),
    },
    {
      table: matterCounters,
      query: (tx: TestDatabaseTransaction) =>
        tx
          .delete(matterCounters)
          .where(eq(matterCounters.id, ids.matterCounterB))
          .returning({ id: matterCounters.id }),
    },
  ];

  for (const mutationCase of cases) {
    addZeroAffectedMutationTest(mutationCase, "DELETE", "org");
  }
});

// ════════════════════════════════════════════════════════
// Workspaces table — wrong scope
// ════════════════════════════════════════════════════════

describe("workspaces table — wrong scope", () => {
  test("empty workspace IDs → zero rows", async () => {
    const c = await scopedQuery([], ids.orgA, (tx) => tx.$count(workspaces));
    expect(c).toBe(0);
  });

  test("cannot see other org's workspaces", async () => {
    const c = await scopedQuery([ids.wsA1, ids.wsA2], ids.orgA, (tx) =>
      tx.$count(workspaces, eq(workspaces.id, ids.wsB1)),
    );
    expect(c).toBe(0);
  });

  test("UPDATE other org's workspace → zero affected", async () => {
    const rows = await scopedQuery([ids.wsA1], ids.orgA, (tx) =>
      tx
        .update(workspaces)
        .set({ name: "hacked ws" })
        .where(eq(workspaces.id, ids.wsB1))
        .returning({ id: workspaces.id }),
    );
    expect(rows).toHaveLength(0);
  });

  test("DELETE other org's workspace → zero affected", async () => {
    const rows = await scopedQuery([ids.wsA1], ids.orgA, (tx) =>
      tx
        .delete(workspaces)
        .where(eq(workspaces.id, ids.wsB1))
        .returning({ id: workspaces.id }),
    );
    expect(rows).toHaveLength(0);
  });

  test("INSERT workspace with wrong org → policy violation", async () => {
    const error = await scopedQuery([ids.wsA1], ids.orgA, async (tx) =>
      tryCatch(async () =>
        tx.insert(workspaces).values({
          id: toSafeId<"workspace">(Bun.randomUUIDv7()),
          organizationId: ids.orgB,
          clientId: ids.contactB,
          name: "Bad Workspace",
          reference: "REF-BAD",
          status: "active" as const,
        }),
      ),
    );
    expect(isPgError(error, PG_ERROR.INSUFFICIENT_PRIVILEGE)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════
// Ethical wall: same org, different workspaces
// ════════════════════════════════════════════════════════

describe("ethical wall (same org)", () => {
  test("user A2 (wsA2 only) cannot see wsA1 entities", async () => {
    const c = await scopedQuery([ids.wsA2], ids.orgA, (tx) =>
      tx.$count(entities, eq(entities.workspaceId, ids.wsA1)),
    );
    expect(c).toBe(0);
  });

  test("user A2 (wsA2 only) sees wsA2 entities", async () => {
    const c = await scopedQuery([ids.wsA2], ids.orgA, (tx) =>
      tx.$count(entities, eq(entities.workspaceId, ids.wsA2)),
    );
    expect(c).toBeGreaterThan(0);
  });

  test("user A1 (wsA1 + wsA2) sees both workspaces", async () => {
    const c = await scopedQuery([ids.wsA1, ids.wsA2], ids.orgA, (tx) =>
      tx.$count(entities),
    );
    expect(c).toBe(2);
  });
});

// ════════════════════════════════════════════════════════
// Cross-org attack
// ════════════════════════════════════════════════════════

describe("cross-org isolation", () => {
  test("org B session with org A workspace IDs → entities visible (ws policy only)", async () => {
    const c = await scopedQuery([ids.wsA1, ids.wsA2], ids.orgB, (tx) =>
      tx.$count(entities),
    );
    // workspace_select checks workspace_id = ANY(wsIds).
    // The wsIds are from org A but the session is org B.
    // The rows are still visible because workspace
    // policies only check workspace_id, not org_id.
    // This is safe because workspace IDs are server-set.
    expect(c).toBeGreaterThan(0);
  });

  test("org B session with org A workspace IDs → zero org-scoped data", async () => {
    // Contacts are org-scoped; org B can't see org A's
    const c = await scopedQuery([ids.wsA1, ids.wsA2], ids.orgB, (tx) =>
      tx.$count(contacts, eq(contacts.organizationId, ids.orgA)),
    );
    expect(c).toBe(0);
  });

  test("org A session with org B workspace IDs → ws data visible (ws policy only)", async () => {
    const c = await scopedQuery([ids.wsB1], ids.orgA, (tx) =>
      tx.$count(entities, eq(entities.workspaceId, ids.wsB1)),
    );
    // wsB1 is in the session wsIds, so entities in wsB1
    // are visible (ws policy only checks wsIds). This is
    // the expected behavior — workspace IDs are server-set
    // from resolveAccessibleWorkspaces which filters by
    // user membership. The test documents this.
    expect(c).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════
// Dual-scope: correct ws but wrong org on dual-column tables
// ════════════════════════════════════════════════════════

describe("dual-scope integrity (ws + org columns)", () => {
  // Tables with both workspace_id and organization_id
  // where RLS only checks workspace_id. This documents
  // that org_id is not enforced at the RLS level; it is
  // safe because workspace IDs are server-set by
  // resolveAccessibleWorkspaces which filters by org.

  test("INSERT timeEntry with correct ws but wrong org → succeeds (ws policy only)", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      await tx.insert(timeEntries).values({
        id: testId(),
        organizationId: ids.orgB,
        workspaceId: ids.wsA1,
        userId: ids.userA1,
        matterId: ids.entityA1,
        dateWorked: "2025-06-01",
        timezoneId: "UTC",
        durationMinutes: 30,
        billedMinutes: 30,
        rateAtEntry: cents(100),
        currency: "USD",
        narrative: "dual-scope test",
      });
      // If we got here without error, the insert succeeded.
      // This is the expected behavior; the test documents it.
    });
  });

  test("INSERT expense with correct ws but wrong org → succeeds (ws policy only)", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      await tx.insert(expenses).values({
        id: testId(),
        organizationId: ids.orgB,
        workspaceId: ids.wsA1,
        userId: ids.userA1,
        matterId: ids.entityA1,
        dateIncurred: "2025-06-01",
        amount: cents(50),
        currency: "USD",
        category: "filing_fee" as const,
        description: "dual-scope test",
      });
    });
  });

  test("INSERT invoice with correct ws but wrong org → succeeds (ws policy only)", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      await tx.insert(invoices).values({
        id: testId(),
        organizationId: ids.orgB,
        workspaceId: ids.wsA1,
        invoiceNumber: "DUAL-001",
        invoiceDate: "2025-06-01",
        currency: "USD",
      });
    });
  });
});

// ════════════════════════════════════════════════════════
// Scope reassignment via UPDATE
// ════════════════════════════════════════════════════════

describe("scope reassignment via UPDATE", () => {
  test("UPDATE entity workspace_id to foreign workspace → policy violation", async () => {
    // PostgreSQL applies USING as WITH CHECK on the new row
    // when no explicit WITH CHECK is set. The updated row's
    // workspace_id would not match the session wsIds.
    const error = await scopedQuery([ids.wsA1], ids.orgA, async (tx) =>
      tryCatch(async () =>
        tx
          .update(entities)
          .set({ workspaceId: ids.wsB1 })
          .where(eq(entities.id, ids.entityA1))
          .returning({ id: entities.id }),
      ),
    );
    expect(isPgError(error, PG_ERROR.INSUFFICIENT_PRIVILEGE)).toBe(true);
  });

  test("UPDATE workspace id to foreign workspace → policy violation", async () => {
    // USING defaults as WITH CHECK; the new id must be in wsIds.
    const error = await scopedQuery([ids.wsA1], ids.orgA, async (tx) =>
      tryCatch(async () =>
        tx
          .update(workspaces)
          .set({ id: ids.wsB1 })
          .where(eq(workspaces.id, ids.wsA1))
          .returning({ id: workspaces.id }),
      ),
    );
    expect(isPgError(error, PG_ERROR.INSUFFICIENT_PRIVILEGE)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════
// Unset session variables → zero rows (not a leak)
// ════════════════════════════════════════════════════════

describe("unset session variables", () => {
  test("stella role without set_config → ws query errors (no leak)", async () => {
    // When app.workspace_ids is not set, current_setting
    // returns '' which fails to cast to text[]. This is
    // safe: the query errors instead of leaking data.
    const result = await testDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('role', ${stella.name}, true)`);
      try {
        await tx.$count(entities);
        return "leaked";
      } catch {
        return "blocked";
      }
    });
    expect(result).toBe("blocked");
  });

  test("stella role without set_config → org query returns zero", async () => {
    // When app.organization_id is not set, current_setting
    // returns '' which doesn't match any org ID → zero rows.
    const c = await testDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('role', ${stella.name}, true)`);
      return tx.$count(contacts);
    });
    expect(c).toBe(0);
  });
});

describe("chat mutations — wrong user", () => {
  test("insert with mismatched user_id is rejected", async () => {
    const error = await tryCatch(async () =>
      dryScopedQuery(
        [ids.wsA1],
        ids.orgA,
        async (tx) => {
          await tx.insert(chatThreads).values({
            id: testId(),
            organizationId: ids.orgA,
            userId: ids.userB1,
            title: "forbidden",
            workspaceId: ids.wsA1,
          });
        },
        ids.userA1,
      ),
    );
    expect(isPgError(error, PG_ERROR.INSUFFICIENT_PRIVILEGE)).toBe(true);
  });

  test("update on another user's row affects zero rows", async () => {
    const rows = await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      (tx) =>
        tx
          .update(chatMessages)
          .set({ content: { version: 1 as const, data: [] } })
          .where(eq(chatMessages.id, ids.chatMessageWorkspaceB1))
          .returning({ id: chatMessages.id }),
      ids.userA1,
    );
    expect(rows).toHaveLength(0);
  });

  test("delete on another user's row affects zero rows", async () => {
    const rows = await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      (tx) =>
        tx
          .delete(chatThreads)
          .where(eq(chatThreads.id, ids.chatThreadWorkspaceB1))
          .returning({ id: chatThreads.id }),
      ids.userA1,
    );
    expect(rows).toHaveLength(0);
  });
});
