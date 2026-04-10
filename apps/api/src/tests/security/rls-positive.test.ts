import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, getTableName } from "drizzle-orm";

import {
  billingCodes,
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
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import {
  orgScopedTables,
  wsScopedTables,
} from "@/api/tests/security/rls-helpers";
import type { MutationCase, TestIds } from "@/api/tests/security/rls-helpers";
import type {
  createDryScopedQuery,
  createScopedQuery,
} from "@/api/tests/security/test-utils";

let ids: TestIds;
let scopedQuery: ReturnType<typeof createScopedQuery>;
let dryScopedQuery: ReturnType<typeof createDryScopedQuery>;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  ids = fixture.ids;
  scopedQuery = fixture.scopedQuery;
  dryScopedQuery = fixture.dryScopedQuery;
});

afterAll(async () => {
  await releaseRlsFixture();
});

const clauseBody: ClauseBody = [{ text: "test" }];

const propContent = {
  version: 1 as const,
  type: "text" as const,
};
const propTool = {
  version: 1 as const,
  type: "manual-input" as const,
};
const fieldContent = {
  version: 1 as const,
  type: "text" as const,
  value: "positive-test",
};

// ════════════════════════════════════════════════════════
// SELECT: correct scope → rows visible
// ════════════════════════════════════════════════════════

describe("workspace SELECT — correct scope", () => {
  for (const table of wsScopedTables) {
    const tableName = getTableName(table);
    test(`${tableName}: correct workspace IDs → rows visible`, async () => {
      const c = await scopedQuery([ids.wsA1], ids.orgA, (tx) =>
        tx.$count(table),
      );
      expect(c).toBeGreaterThan(0);
    });
  }
});

describe("organization SELECT — correct scope", () => {
  for (const table of orgScopedTables) {
    const tableName = getTableName(table);
    test(`${tableName}: correct org ID → rows visible`, async () => {
      const c = await scopedQuery([ids.wsA1], ids.orgA, (tx) =>
        tx.$count(table),
      );
      expect(c).toBeGreaterThan(0);
    });
  }
});

describe("chat SELECT — correct user and workspace", () => {
  test("global thread is visible to its owner", async () => {
    const c = await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      (tx) =>
        tx.$count(chatThreads, eq(chatThreads.id, ids.chatThreadGlobalA1)),
      ids.userA1,
    );
    expect(c).toBe(1);
  });

  test("workspace thread is visible to its owner in an allowed workspace", async () => {
    const c = await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      (tx) =>
        tx.$count(
          chatMessages,
          eq(chatMessages.id, ids.chatMessageWorkspaceA1),
        ),
      ids.userA1,
    );
    expect(c).toBe(1);
  });
});

// ════════════════════════════════════════════════════════
// UPDATE: correct scope → affected
// ════════════════════════════════════════════════════════

describe("workspace UPDATE — correct scope", () => {
  const cases: MutationCase[] = [
    {
      table: entities,
      query: (tx) =>
        tx
          .update(entities)
          .set({ name: "updated" })
          .where(eq(entities.id, ids.entityA1))
          .returning({ id: entities.id }),
    },
    {
      table: entityVersions,
      query: (tx) =>
        tx
          .update(entityVersions)
          .set({ stamp: "updated" })
          .where(eq(entityVersions.id, ids.entityVersionA1))
          .returning({ id: entityVersions.id }),
    },
    {
      table: properties,
      query: (tx) =>
        tx
          .update(properties)
          .set({ name: "updated" })
          .where(eq(properties.id, ids.propertyA1))
          .returning({ id: properties.id }),
    },
    {
      table: fields,
      query: (tx) =>
        tx
          .update(fields)
          .set({ content: fieldContent })
          .where(eq(fields.id, ids.fieldA1))
          .returning({ id: fields.id }),
    },
    {
      table: workspaceMembers,
      query: (tx) =>
        tx
          .update(workspaceMembers)
          .set({ createdAt: new Date() })
          .where(eq(workspaceMembers.id, ids.memberA1wsA1))
          .returning({ id: workspaceMembers.id }),
    },
    {
      table: documentCounters,
      query: (tx) =>
        tx
          .update(documentCounters)
          .set({ lastValue: 1 })
          .where(eq(documentCounters.id, ids.docCounterA1))
          .returning({ id: documentCounters.id }),
    },
    {
      table: workspaceContacts,
      query: (tx) =>
        tx
          .update(workspaceContacts)
          .set({ notes: "updated" })
          .where(eq(workspaceContacts.id, ids.wsContactA1))
          .returning({ id: workspaceContacts.id }),
    },
    {
      table: propertyDependencies,
      query: (tx) =>
        tx
          .update(propertyDependencies)
          .set({ condition: null })
          .where(eq(propertyDependencies.id, ids.propDepA1))
          .returning({ id: propertyDependencies.id }),
    },
    {
      table: justifications,
      query: (tx) =>
        tx
          .update(justifications)
          .set({ htmlContent: "<p>updated</p>" })
          .where(eq(justifications.id, ids.justificationA1))
          .returning({ id: justifications.id }),
    },
    {
      table: timeEntries,
      query: (tx) =>
        tx
          .update(timeEntries)
          .set({ narrative: "updated" })
          .where(eq(timeEntries.id, ids.timeEntryA1))
          .returning({ id: timeEntries.id }),
    },
    {
      table: billingCodes,
      query: (tx) =>
        tx
          .update(billingCodes)
          .set({ label: "updated" })
          .where(eq(billingCodes.id, ids.billingCodeA1))
          .returning({ id: billingCodes.id }),
    },
    {
      table: rateTables,
      query: (tx) =>
        tx
          .update(rateTables)
          .set({ name: "updated" })
          .where(eq(rateTables.id, ids.rateTableA1))
          .returning({ id: rateTables.id }),
    },
    {
      table: rateEntries,
      query: (tx) =>
        tx
          .update(rateEntries)
          .set({ hourlyRate: 250 })
          .where(eq(rateEntries.id, ids.rateEntryA1))
          .returning({ id: rateEntries.id }),
    },
    {
      table: expenses,
      query: (tx) =>
        tx
          .update(expenses)
          .set({ description: "updated" })
          .where(eq(expenses.id, ids.expenseA1))
          .returning({ id: expenses.id }),
    },
    {
      table: invoices,
      query: (tx) =>
        tx
          .update(invoices)
          .set({ notes: "updated" })
          .where(eq(invoices.id, ids.invoiceA1))
          .returning({ id: invoices.id }),
    },
    {
      table: caseLawMatterLinks,
      query: (tx) =>
        tx
          .update(caseLawMatterLinks)
          .set({ note: "updated" })
          .where(eq(caseLawMatterLinks.id, ids.caseLawMatterLinkA1))
          .returning({ id: caseLawMatterLinks.id }),
    },
  ];

  for (const { table, query } of cases) {
    test(`UPDATE ${getTableName(table)} in own workspace → affected`, async () => {
      const rows = await scopedQuery([ids.wsA1], ids.orgA, query);
      expect(rows).toHaveLength(1);
    });
  }
});

describe("organization UPDATE — correct scope", () => {
  const cases: MutationCase[] = [
    {
      table: contacts,
      query: (tx) =>
        tx
          .update(contacts)
          .set({ displayName: "updated" })
          .where(eq(contacts.id, ids.contactA))
          .returning({ id: contacts.id }),
    },
    {
      table: contactRelationships,
      query: (tx) =>
        tx
          .update(contactRelationships)
          .set({ title: "updated" })
          .where(eq(contactRelationships.id, ids.contactRelA))
          .returning({ id: contactRelationships.id }),
    },
    {
      table: templates,
      query: (tx) =>
        tx
          .update(templates)
          .set({ name: "updated" })
          .where(eq(templates.id, ids.templateA))
          .returning({ id: templates.id }),
    },
    {
      table: templateVersions,
      query: (tx) =>
        tx
          .update(templateVersions)
          .set({ fieldCount: 1 })
          .where(eq(templateVersions.id, ids.templateVersionA))
          .returning({ id: templateVersions.id }),
    },
    {
      table: templateCategories,
      query: (tx) =>
        tx
          .update(templateCategories)
          .set({ name: "updated" })
          .where(eq(templateCategories.id, ids.templateCategoryA))
          .returning({ id: templateCategories.id }),
    },
    {
      table: templateClauses,
      query: (tx) =>
        tx
          .update(templateClauses)
          .set({ sortOrder: 1 })
          .where(eq(templateClauses.id, ids.templateClauseA))
          .returning({ id: templateClauses.id }),
    },
    {
      table: templateFills,
      query: (tx) =>
        tx
          .update(templateFills)
          .set({ status: "pending" })
          .where(eq(templateFills.id, ids.templateFillA))
          .returning({ id: templateFills.id }),
    },
    {
      table: clauseCategories,
      query: (tx) =>
        tx
          .update(clauseCategories)
          .set({ name: "updated" })
          .where(eq(clauseCategories.id, ids.clauseCategoryA))
          .returning({ id: clauseCategories.id }),
    },
    {
      table: clauses,
      query: (tx) =>
        tx
          .update(clauses)
          .set({ title: "updated" })
          .where(eq(clauses.id, ids.clauseA))
          .returning({ id: clauses.id }),
    },
    {
      table: clauseVariants,
      query: (tx) =>
        tx
          .update(clauseVariants)
          .set({ label: "updated" })
          .where(eq(clauseVariants.id, ids.clauseVariantA))
          .returning({ id: clauseVariants.id }),
    },
    {
      table: clauseVersions,
      query: (tx) =>
        tx
          .update(clauseVersions)
          .set({ body: clauseBody })
          .where(eq(clauseVersions.id, ids.clauseVersionA))
          .returning({ id: clauseVersions.id }),
    },
    {
      table: organizationSettings,
      query: (tx) =>
        tx
          .update(organizationSettings)
          .set({ matterNumberPattern: "updated" })
          .where(eq(organizationSettings.id, ids.orgSettingsA))
          .returning({ id: organizationSettings.id }),
    },
    {
      table: matterCounters,
      query: (tx) =>
        tx
          .update(matterCounters)
          .set({ lastValue: 1 })
          .where(eq(matterCounters.id, ids.matterCounterA))
          .returning({ id: matterCounters.id }),
    },
  ];

  for (const { table, query } of cases) {
    test(`UPDATE ${getTableName(table)} in own org → affected`, async () => {
      const rows = await scopedQuery([ids.wsA1], ids.orgA, query);
      expect(rows).toHaveLength(1);
    });
  }
});

// ════════════════════════════════════════════════════════
// Workspaces table — correct scope
// ════════════════════════════════════════════════════════

describe("workspaces table — correct scope", () => {
  test("scoped to wsA1 → sees only wsA1", async () => {
    const rows = await scopedQuery([ids.wsA1], ids.orgA, (tx) =>
      tx.select({ id: workspaces.id }).from(workspaces),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(ids.wsA1);
  });

  test("scoped to wsA1 + wsA2 → sees both", async () => {
    const rows = await scopedQuery([ids.wsA1, ids.wsA2], ids.orgA, (tx) =>
      tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .orderBy(workspaces.name),
    );
    expect(rows).toHaveLength(2);
    const returnedIds = rows.map((r) => r.id);
    expect(returnedIds).toContain(ids.wsA1);
    expect(returnedIds).toContain(ids.wsA2);
  });

  test("INSERT workspace with matching org → succeeds", async () => {
    // No .returning() — the SELECT policy would filter out
    // the new row (its ID isn't in the session wsIds).
    // Not throwing IS the verification.
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      await tx.insert(workspaces).values({
        id: toSafeId<"workspace">(crypto.randomUUID()),
        organizationId: ids.orgA,
        clientId: ids.contactA,
        name: "RLS Insert Test",
        reference: "REF-INS",
        status: "active" as const,
      });
    });
  });

  test("UPDATE own workspace → affected", async () => {
    const rows = await scopedQuery([ids.wsA1], ids.orgA, (tx) =>
      tx
        .update(workspaces)
        .set({ name: "updated ws" })
        .where(eq(workspaces.id, ids.wsA1))
        .returning({ id: workspaces.id }),
    );
    expect(rows).toHaveLength(1);
  });

  test("UPDATE workspace organization_id → allowed (ws scope only)", async () => {
    // The workspace UPDATE policy checks id = ANY(wsIds),
    // not organization_id. Changing org_id is permitted at
    // the RLS level; the application layer prevents it.
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .update(workspaces)
        .set({ organizationId: ids.orgB })
        .where(eq(workspaces.id, ids.wsA1))
        .returning({ id: workspaces.id });
      expect(rows).toHaveLength(1);
    });
  });
});

// ════════════════════════════════════════════════════════
// INSERT: correct scope → succeeds
// ════════════════════════════════════════════════════════

describe("workspace INSERT — correct scope", () => {
  test("INSERT entity → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .insert(entities)
        .values({
          id: crypto.randomUUID(),
          workspaceId: ids.wsA1,
          kind: "document" as const,
        })
        .returning({ id: entities.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("INSERT entityVersion → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .insert(entityVersions)
        .values({
          id: crypto.randomUUID(),
          workspaceId: ids.wsA1,
          entityId: ids.entityA1,
        })
        .returning({ id: entityVersions.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("INSERT property → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .insert(properties)
        .values({
          id: crypto.randomUUID(),
          workspaceId: ids.wsA1,
          name: "RLS Positive",
          content: propContent,
          tool: propTool,
        })
        .returning({ id: properties.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("INSERT field → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .insert(fields)
        .values({
          id: crypto.randomUUID(),
          workspaceId: ids.wsA1,
          propertyId: ids.propertyA1dep,
          entityVersionId: ids.entityVersionA1,
          content: fieldContent,
        })
        .returning({ id: fields.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("INSERT workspaceMember → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .insert(workspaceMembers)
        .values({
          id: crypto.randomUUID(),
          workspaceId: ids.wsA1,
          userId: ids.userAdmin,
        })
        .returning({ id: workspaceMembers.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("INSERT documentCounter → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      // Unique on workspaceId — remove seed row first
      await tx
        .delete(documentCounters)
        .where(eq(documentCounters.id, ids.docCounterA1));
      const rows = await tx
        .insert(documentCounters)
        .values({
          id: crypto.randomUUID(),
          workspaceId: ids.wsA1,
          lastValue: 0,
        })
        .returning({ id: documentCounters.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("INSERT workspaceContact → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .insert(workspaceContacts)
        .values({
          id: crypto.randomUUID(),
          organizationId: ids.orgA,
          workspaceId: ids.wsA1,
          contactId: ids.contactA2,
          role: "co_counsel" as const,
        })
        .returning({ id: workspaceContacts.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("INSERT propertyDependency → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .insert(propertyDependencies)
        .values({
          id: crypto.randomUUID(),
          workspaceId: ids.wsA1,
          propertyId: ids.propertyA1dep,
          dependsOnPropertyId: ids.propertyA1,
        })
        .returning({ id: propertyDependencies.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("INSERT justification → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      // Unique on fieldId — remove seed row first
      await tx
        .delete(justifications)
        .where(eq(justifications.id, ids.justificationA1));
      const rows = await tx
        .insert(justifications)
        .values({
          id: crypto.randomUUID(),
          workspaceId: ids.wsA1,
          fieldId: ids.fieldA1,
          htmlVersion: 99,
          htmlContent: "<p>positive</p>",
        })
        .returning({ id: justifications.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("INSERT timeEntry → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .insert(timeEntries)
        .values({
          id: crypto.randomUUID(),
          organizationId: ids.orgA,
          workspaceId: ids.wsA1,
          userId: ids.userA1,
          matterId: ids.entityA1,
          dateWorked: "2025-06-01",
          timezoneId: "UTC",
          durationMinutes: 30,
          billedMinutes: 30,
          rateAtEntry: 100,
          currency: "USD",
          narrative: "positive insert",
        })
        .returning({ id: timeEntries.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("INSERT billingCode → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .insert(billingCodes)
        .values({
          id: crypto.randomUUID(),
          organizationId: ids.orgA,
          workspaceId: ids.wsA1,
          type: "task" as const,
          code: "RLS",
          label: "Positive Insert",
        })
        .returning({ id: billingCodes.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("INSERT rateTable → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .insert(rateTables)
        .values({
          id: crypto.randomUUID(),
          organizationId: ids.orgA,
          workspaceId: ids.wsA1,
          name: "RLS Positive",
          currency: "USD",
        })
        .returning({ id: rateTables.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("INSERT rateEntry → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .insert(rateEntries)
        .values({
          id: crypto.randomUUID(),
          workspaceId: ids.wsA1,
          rateTableId: ids.rateTableA1,
          hourlyRate: 150,
          effectiveFrom: "2026-01-01",
        })
        .returning({ id: rateEntries.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("INSERT expense → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .insert(expenses)
        .values({
          id: crypto.randomUUID(),
          organizationId: ids.orgA,
          workspaceId: ids.wsA1,
          userId: ids.userA1,
          matterId: ids.entityA1,
          dateIncurred: "2025-06-01",
          amount: 50,
          currency: "USD",
          category: "filing_fee" as const,
          description: "positive insert",
        })
        .returning({ id: expenses.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("INSERT invoice → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .insert(invoices)
        .values({
          id: crypto.randomUUID(),
          organizationId: ids.orgA,
          workspaceId: ids.wsA1,
          invoiceNumber: "RLS-POS-001",
          invoiceDate: "2025-06-01",
          currency: "USD",
        })
        .returning({ id: invoices.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("INSERT caseLawMatterLink → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      // Unique on (decisionId, workspaceId) — use decisionB
      const rows = await tx
        .insert(caseLawMatterLinks)
        .values({
          id: crypto.randomUUID(),
          decisionId: ids.caseLawDecisionB,
          workspaceId: ids.wsA1,
          linkedBy: ids.userA1,
        })
        .returning({ id: caseLawMatterLinks.id });
      expect(rows).toHaveLength(1);
    });
  });
});

describe("organization INSERT — correct scope", () => {
  test("INSERT contact → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .insert(contacts)
        .values({
          id: crypto.randomUUID(),
          organizationId: ids.orgA,
          type: "person" as const,
          displayName: "Positive Insert",
        })
        .returning({ id: contacts.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("INSERT contactRelationship → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .insert(contactRelationships)
        .values({
          id: crypto.randomUUID(),
          organizationId: ids.orgA,
          personId: ids.contactA2,
          relatedContactId: ids.contactA,
          relationshipType: "employee" as const,
        })
        .returning({ id: contactRelationships.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("INSERT template → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .insert(templates)
        .values({
          id: crypto.randomUUID(),
          organizationId: ids.orgA,
          name: "RLS Positive",
          fileName: "pos.docx",
          s3Key: "test/pos.docx",
          sizeBytes: 512,
          createdBy: ids.userA1,
        })
        .returning({ id: templates.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("INSERT templateVersion → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .insert(templateVersions)
        .values({
          id: crypto.randomUUID(),
          organizationId: ids.orgA,
          templateId: ids.templateA,
          version: 99,
          s3Key: "test/pos-v99.docx",
          createdBy: ids.userA1,
        })
        .returning({ id: templateVersions.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("INSERT templateCategory → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .insert(templateCategories)
        .values({
          id: crypto.randomUUID(),
          organizationId: ids.orgA,
          name: "RLS Positive",
        })
        .returning({ id: templateCategories.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("INSERT templateClause → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .insert(templateClauses)
        .values({
          id: crypto.randomUUID(),
          organizationId: ids.orgA,
          templateId: ids.templateA,
          clauseId: ids.clauseA,
        })
        .returning({ id: templateClauses.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("INSERT templateFill → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .insert(templateFills)
        .values({
          id: crypto.randomUUID(),
          organizationId: ids.orgA,
          templateId: ids.templateA,
          userId: ids.userA2,
          format: "docx",
          status: "completed",
        })
        .returning({ id: templateFills.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("INSERT clauseCategory → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .insert(clauseCategories)
        .values({
          id: crypto.randomUUID(),
          organizationId: ids.orgA,
          name: "RLS Positive",
        })
        .returning({ id: clauseCategories.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("INSERT clause → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .insert(clauses)
        .values({
          id: crypto.randomUUID(),
          organizationId: ids.orgA,
          title: "RLS Positive",
          body: clauseBody,
          createdBy: ids.userA1,
        })
        .returning({ id: clauses.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("INSERT clauseVariant → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .insert(clauseVariants)
        .values({
          id: crypto.randomUUID(),
          organizationId: ids.orgA,
          clauseId: ids.clauseA,
          label: "RLS Positive",
          body: clauseBody,
        })
        .returning({ id: clauseVariants.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("INSERT clauseVersion → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .insert(clauseVersions)
        .values({
          id: crypto.randomUUID(),
          organizationId: ids.orgA,
          clauseId: ids.clauseA,
          version: 99,
          body: clauseBody,
        })
        .returning({ id: clauseVersions.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("INSERT organizationSettings → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      // Unique on organizationId — remove seed row first
      await tx
        .delete(organizationSettings)
        .where(eq(organizationSettings.id, ids.orgSettingsA));
      const rows = await tx
        .insert(organizationSettings)
        .values({
          id: crypto.randomUUID(),
          organizationId: ids.orgA,
        })
        .returning({ id: organizationSettings.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("INSERT matterCounter → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .insert(matterCounters)
        .values({
          id: crypto.randomUUID(),
          organizationId: ids.orgA,
          scopeKey: "rls-positive-test",
          lastValue: 0,
        })
        .returning({ id: matterCounters.id });
      expect(rows).toHaveLength(1);
    });
  });
});

// ════════════════════════════════════════════════════════
// DELETE: correct scope → succeeds (insert-then-delete)
// ════════════════════════════════════════════════════════

describe("workspace DELETE — correct scope", () => {
  test("DELETE entity in own workspace → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const delId = crypto.randomUUID();
      await tx.insert(entities).values({
        id: delId,
        workspaceId: ids.wsA1,
        kind: "document" as const,
      });
      const rows = await tx
        .delete(entities)
        .where(eq(entities.id, delId))
        .returning({ id: entities.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("DELETE entityVersion in own workspace → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const delId = crypto.randomUUID();
      await tx.insert(entityVersions).values({
        id: delId,
        workspaceId: ids.wsA1,
        entityId: ids.entityA1,
      });
      const rows = await tx
        .delete(entityVersions)
        .where(eq(entityVersions.id, delId))
        .returning({ id: entityVersions.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("DELETE property in own workspace → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const delId = crypto.randomUUID();
      await tx.insert(properties).values({
        id: delId,
        workspaceId: ids.wsA1,
        name: "To Delete",
        content: propContent,
        tool: propTool,
      });
      const rows = await tx
        .delete(properties)
        .where(eq(properties.id, delId))
        .returning({ id: properties.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("DELETE field in own workspace → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .delete(fields)
        .where(eq(fields.id, ids.fieldA1))
        .returning({ id: fields.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("DELETE workspaceMember in own workspace → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const delId = crypto.randomUUID();
      await tx.insert(workspaceMembers).values({
        id: delId,
        workspaceId: ids.wsA1,
        userId: ids.userAdmin,
      });
      const rows = await tx
        .delete(workspaceMembers)
        .where(eq(workspaceMembers.id, delId))
        .returning({ id: workspaceMembers.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("DELETE documentCounter in own workspace → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .delete(documentCounters)
        .where(eq(documentCounters.id, ids.docCounterA1))
        .returning({ id: documentCounters.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("DELETE workspaceContact in own workspace → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const delId = crypto.randomUUID();
      await tx.insert(workspaceContacts).values({
        id: delId,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        contactId: ids.contactA2,
        role: "co_counsel" as const,
      });
      const rows = await tx
        .delete(workspaceContacts)
        .where(eq(workspaceContacts.id, delId))
        .returning({ id: workspaceContacts.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("DELETE propertyDependency in own workspace → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const delId = crypto.randomUUID();
      await tx.insert(propertyDependencies).values({
        id: delId,
        workspaceId: ids.wsA1,
        propertyId: ids.propertyA1dep,
        dependsOnPropertyId: ids.propertyA1,
      });
      const rows = await tx
        .delete(propertyDependencies)
        .where(eq(propertyDependencies.id, delId))
        .returning({ id: propertyDependencies.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("DELETE justification in own workspace → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .delete(justifications)
        .where(eq(justifications.id, ids.justificationA1))
        .returning({ id: justifications.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("DELETE timeEntry in own workspace → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const delId = crypto.randomUUID();
      await tx.insert(timeEntries).values({
        id: delId,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        userId: ids.userA1,
        matterId: ids.entityA1,
        dateWorked: "2025-07-01",
        timezoneId: "UTC",
        durationMinutes: 15,
        billedMinutes: 15,
        rateAtEntry: 100,
        currency: "USD",
        narrative: "to delete",
      });
      const rows = await tx
        .delete(timeEntries)
        .where(eq(timeEntries.id, delId))
        .returning({ id: timeEntries.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("DELETE billingCode in own workspace → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const delId = crypto.randomUUID();
      await tx.insert(billingCodes).values({
        id: delId,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        type: "task" as const,
        code: "DEL",
        label: "To Delete",
      });
      const rows = await tx
        .delete(billingCodes)
        .where(eq(billingCodes.id, delId))
        .returning({ id: billingCodes.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("DELETE rateTable in own workspace → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const delId = crypto.randomUUID();
      await tx.insert(rateTables).values({
        id: delId,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        name: "To Delete",
        currency: "USD",
      });
      const rows = await tx
        .delete(rateTables)
        .where(eq(rateTables.id, delId))
        .returning({ id: rateTables.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("DELETE rateEntry in own workspace → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const delId = crypto.randomUUID();
      await tx.insert(rateEntries).values({
        id: delId,
        workspaceId: ids.wsA1,
        rateTableId: ids.rateTableA1,
        hourlyRate: 150,
        effectiveFrom: "2026-06-01",
      });
      const rows = await tx
        .delete(rateEntries)
        .where(eq(rateEntries.id, delId))
        .returning({ id: rateEntries.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("DELETE expense in own workspace → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const delId = crypto.randomUUID();
      await tx.insert(expenses).values({
        id: delId,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        userId: ids.userA1,
        matterId: ids.entityA1,
        dateIncurred: "2025-07-01",
        amount: 25,
        currency: "USD",
        category: "filing_fee" as const,
        description: "to delete",
      });
      const rows = await tx
        .delete(expenses)
        .where(eq(expenses.id, delId))
        .returning({ id: expenses.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("DELETE invoice in own workspace → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const delId = crypto.randomUUID();
      await tx.insert(invoices).values({
        id: delId,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        invoiceNumber: "DEL-001",
        invoiceDate: "2025-07-01",
        currency: "USD",
      });
      const rows = await tx
        .delete(invoices)
        .where(eq(invoices.id, delId))
        .returning({ id: invoices.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("DELETE caseLawMatterLink in own workspace → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .delete(caseLawMatterLinks)
        .where(eq(caseLawMatterLinks.id, ids.caseLawMatterLinkA1))
        .returning({ id: caseLawMatterLinks.id });
      expect(rows).toHaveLength(1);
    });
  });
});

describe("organization DELETE — correct scope", () => {
  test("DELETE contact in own org → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const delId = crypto.randomUUID();
      await tx.insert(contacts).values({
        id: delId,
        organizationId: ids.orgA,
        type: "person" as const,
        displayName: "To Delete",
      });
      const rows = await tx
        .delete(contacts)
        .where(eq(contacts.id, delId))
        .returning({ id: contacts.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("DELETE contactRelationship in own org → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const delId = crypto.randomUUID();
      await tx.insert(contactRelationships).values({
        id: delId,
        organizationId: ids.orgA,
        personId: ids.contactA2,
        relatedContactId: ids.contactA,
        relationshipType: "employee" as const,
      });
      const rows = await tx
        .delete(contactRelationships)
        .where(eq(contactRelationships.id, delId))
        .returning({ id: contactRelationships.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("DELETE template in own org → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const delId = crypto.randomUUID();
      await tx.insert(templates).values({
        id: delId,
        organizationId: ids.orgA,
        name: "To Delete",
        fileName: "del.docx",
        s3Key: "test/del.docx",
        sizeBytes: 512,
        createdBy: ids.userA1,
      });
      const rows = await tx
        .delete(templates)
        .where(eq(templates.id, delId))
        .returning({ id: templates.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("DELETE templateVersion in own org → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const delId = crypto.randomUUID();
      await tx.insert(templateVersions).values({
        id: delId,
        organizationId: ids.orgA,
        templateId: ids.templateA,
        version: 98,
        s3Key: "test/del-v98.docx",
        createdBy: ids.userA1,
      });
      const rows = await tx
        .delete(templateVersions)
        .where(eq(templateVersions.id, delId))
        .returning({ id: templateVersions.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("DELETE templateCategory in own org → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const delId = crypto.randomUUID();
      await tx.insert(templateCategories).values({
        id: delId,
        organizationId: ids.orgA,
        name: "To Delete",
      });
      const rows = await tx
        .delete(templateCategories)
        .where(eq(templateCategories.id, delId))
        .returning({ id: templateCategories.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("DELETE templateClause in own org → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const delId = crypto.randomUUID();
      await tx.insert(templateClauses).values({
        id: delId,
        organizationId: ids.orgA,
        templateId: ids.templateA,
        clauseId: ids.clauseA,
      });
      const rows = await tx
        .delete(templateClauses)
        .where(eq(templateClauses.id, delId))
        .returning({ id: templateClauses.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("DELETE templateFill in own org → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const delId = crypto.randomUUID();
      await tx.insert(templateFills).values({
        id: delId,
        organizationId: ids.orgA,
        templateId: ids.templateA,
        userId: ids.userA2,
        format: "docx",
        status: "completed",
      });
      const rows = await tx
        .delete(templateFills)
        .where(eq(templateFills.id, delId))
        .returning({ id: templateFills.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("DELETE clauseCategory in own org → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const delId = crypto.randomUUID();
      await tx.insert(clauseCategories).values({
        id: delId,
        organizationId: ids.orgA,
        name: "To Delete",
      });
      const rows = await tx
        .delete(clauseCategories)
        .where(eq(clauseCategories.id, delId))
        .returning({ id: clauseCategories.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("DELETE clause in own org → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const delId = crypto.randomUUID();
      await tx.insert(clauses).values({
        id: delId,
        organizationId: ids.orgA,
        title: "To Delete",
        body: clauseBody,
        createdBy: ids.userA1,
      });
      const rows = await tx
        .delete(clauses)
        .where(eq(clauses.id, delId))
        .returning({ id: clauses.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("DELETE clauseVariant in own org → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const delId = crypto.randomUUID();
      await tx.insert(clauseVariants).values({
        id: delId,
        organizationId: ids.orgA,
        clauseId: ids.clauseA,
        label: "To Delete",
        body: clauseBody,
      });
      const rows = await tx
        .delete(clauseVariants)
        .where(eq(clauseVariants.id, delId))
        .returning({ id: clauseVariants.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("DELETE clauseVersion in own org → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const delId = crypto.randomUUID();
      await tx.insert(clauseVersions).values({
        id: delId,
        organizationId: ids.orgA,
        clauseId: ids.clauseA,
        version: 98,
        body: clauseBody,
      });
      const rows = await tx
        .delete(clauseVersions)
        .where(eq(clauseVersions.id, delId))
        .returning({ id: clauseVersions.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("DELETE organizationSettings in own org → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const rows = await tx
        .delete(organizationSettings)
        .where(eq(organizationSettings.id, ids.orgSettingsA))
        .returning({ id: organizationSettings.id });
      expect(rows).toHaveLength(1);
    });
  });

  test("DELETE matterCounter in own org → succeeds", async () => {
    await dryScopedQuery([ids.wsA1], ids.orgA, async (tx) => {
      const delId = crypto.randomUUID();
      await tx.insert(matterCounters).values({
        id: delId,
        organizationId: ids.orgA,
        scopeKey: "rls-delete-test",
        lastValue: 0,
      });
      const rows = await tx
        .delete(matterCounters)
        .where(eq(matterCounters.id, delId))
        .returning({ id: matterCounters.id });
      expect(rows).toHaveLength(1);
    });
  });
});
