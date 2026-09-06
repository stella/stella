import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { transactionAbortError } from "@/api/db/safe-db";
import { properties, propertyDependencies, workspaces } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import type { ViewLayout, ViewTemplateProperty } from "@/api/lib/views-schema";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

import { resolveTemplateProperties } from "./template-properties";

/**
 * `resolveTemplateProperties` creates a view's missing columns inside its
 * caller's transaction, so a rejection anywhere in that transaction decides
 * whether those columns survive. The create-view handler rejects after the
 * resolver has written, and used to do so by returning: the columns, their
 * dependency rows, and their audit events committed without the view they were
 * created for. This suite pins the two outcomes apart against a real
 * transaction.
 */

let testDb: TestDatabase;
const seededOrganizationIds: SafeId<"organization">[] = [];
const seededWorkspaceIds: SafeId<"workspace">[] = [];

beforeAll(
  async () => {
    testDb = await getTestDb();
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  // property_dependencies restricts on delete, so the created columns and their
  // edges go before the organizations that own them.
  if (seededWorkspaceIds.length > 0) {
    await testDb
      .delete(propertyDependencies)
      .where(inArray(propertyDependencies.workspaceId, seededWorkspaceIds));
    await testDb
      .delete(properties)
      .where(inArray(properties.workspaceId, seededWorkspaceIds));
  }
  if (seededOrganizationIds.length > 0) {
    await testDb
      .delete(organization)
      .where(inArray(organization.id, seededOrganizationIds));
  }
  await releaseTestDb();
});

const seedWorkspace = async (): Promise<SafeId<"workspace">> => {
  const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
  const workspaceId = toSafeId<"workspace">(Bun.randomUUIDv7());

  await testDb.transaction(async (tx: TestDatabaseTransaction) => {
    await tx.execute(sql.raw("RESET ROLE"));
    await tx.insert(organization).values({
      id: organizationId,
      name: "Template column matter",
      slug: `template-columns-${Bun.randomUUIDv7()}`,
      createdAt: new Date(),
    });
    await tx.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      name: "Template column matter",
      reference: Bun.randomUUIDv7().slice(0, 8),
    });
  });

  seededOrganizationIds.push(organizationId);
  seededWorkspaceIds.push(workspaceId);
  return workspaceId;
};

const noAuditRows: AuditRecorder = async () => undefined;

/** Two columns, the second depending on the first, so both tables are written. */
const templateColumns: ViewTemplateProperty[] = [
  {
    version: 1,
    sourceId: "source_counterparty",
    name: "Counterparty",
    content: { version: 1, type: "text" },
    tool: { version: 1, type: "manual-input" },
    role: null,
    createIfMissing: true,
  },
  {
    version: 1,
    sourceId: "source_summary",
    name: "Summary",
    content: { version: 1, type: "text" },
    tool: { version: 1, type: "ai-model", prompt: "Summarize the document." },
    role: null,
    createIfMissing: true,
    dependencies: [
      { dependsOnSourceId: "source_counterparty", condition: null },
    ],
  },
];

const tableLayout = (): ViewLayout => ({
  version: 1,
  type: "table",
  columnOrder: templateColumns.map((column) => column.sourceId),
  columnPinning: [],
  hiddenProperties: [],
  calculations: [],
  filters: [],
  sorts: [],
});

type ResolveOutcome = "commit" | "reject-after-resolving";

/**
 * Mirrors the create-view handler: resolve the template columns, then either
 * finish or reject. The rejection is the handler's own
 * `Failed to create view` branch, raised the way the handler now raises it.
 */
const runResolve = async (
  workspaceId: SafeId<"workspace">,
  outcome: ResolveOutcome,
) =>
  await Result.tryPromise({
    try: async () =>
      await testDb.transaction(async (tx: TestDatabaseTransaction) => {
        await tx.execute(sql.raw("RESET ROLE"));
        const resolved = await resolveTemplateProperties({
          tx: asTestRaw<Transaction>(tx),
          workspaceId,
          layout: tableLayout(),
          templateProperties: templateColumns,
          canCreateProperties: true,
          recordAuditEvent: noAuditRows,
        });
        if (outcome === "reject-after-resolving") {
          throw new HandlerError({
            status: 500,
            message: "Failed to create view",
          });
        }
        return resolved;
      }),
    catch: (cause) =>
      new DatabaseError({ message: "test transaction failed", cause }),
  });

const persistedCounts = async (workspaceId: SafeId<"workspace">) => ({
  properties: await testDb.$count(
    properties,
    eq(properties.workspaceId, workspaceId),
  ),
  dependencies: await testDb.$count(
    propertyDependencies,
    eq(propertyDependencies.workspaceId, workspaceId),
  ),
});

// The control: without it, "nothing was written" would also pass on a resolver
// that creates no columns at all.
test("resolving template columns commits them when the caller finishes", async () => {
  const workspaceId = await seedWorkspace();

  const outcome = await runResolve(workspaceId, "commit");

  expect(Result.isOk(outcome)).toBe(true);
  expect(await persistedCounts(workspaceId)).toEqual({
    properties: 2,
    dependencies: 1,
  });
});

test("a caller that rejects after resolving keeps no created column", async () => {
  const workspaceId = await seedWorkspace();

  const outcome = await runResolve(workspaceId, "reject-after-resolving");

  expect(Result.isError(outcome)).toBe(true);
  if (!Result.isError(outcome)) {
    throw new TypeError("Expected the view transaction to abort");
  }

  const abort = transactionAbortError(outcome.error);
  expect(HandlerError.is(abort)).toBe(true);
  if (!HandlerError.is(abort)) {
    throw new TypeError("Expected a HandlerError to abort the transaction");
  }
  expect(abort.status).toBe(500);
  expect(abort.message).toBe("Failed to create view");

  expect(await persistedCounts(workspaceId)).toEqual({
    properties: 0,
    dependencies: 0,
  });
});

test("the resolver rejects an invalid template before writing anything", async () => {
  const workspaceId = await seedWorkspace();

  const outcome = await Result.tryPromise({
    try: async () =>
      await testDb.transaction(async (tx: TestDatabaseTransaction) => {
        await tx.execute(sql.raw("RESET ROLE"));
        const duplicated = templateColumns.at(0);
        if (duplicated === undefined) {
          throw new TypeError("Expected a template column fixture");
        }
        return await resolveTemplateProperties({
          tx: asTestRaw<Transaction>(tx),
          workspaceId,
          layout: tableLayout(),
          templateProperties: [duplicated, duplicated],
          canCreateProperties: true,
          recordAuditEvent: noAuditRows,
        });
      }),
    catch: (cause) =>
      new DatabaseError({ message: "test transaction failed", cause }),
  });

  expect(Result.isError(outcome)).toBe(true);
  if (!Result.isError(outcome)) {
    throw new TypeError("Expected the resolver to reject the template");
  }

  const abort = transactionAbortError(outcome.error);
  expect(HandlerError.is(abort)).toBe(true);
  if (!HandlerError.is(abort)) {
    throw new TypeError("Expected a HandlerError rejection");
  }
  expect(abort.status).toBe(422);
  expect(abort.message).toBe("Duplicate template property sourceId");

  expect(await persistedCounts(workspaceId)).toEqual({
    properties: 0,
    dependencies: 0,
  });
});

// The columns go in as one multi-row insert, so nothing but the assembly order
// decides which id belongs to which template column. This pins that the ids the
// caller is handed name the rows the template asked for, in its order, and that
// the dependency edge connects the right two of them.
test("batched column creation keeps ids paired with their template columns", async () => {
  const workspaceId = await seedWorkspace();

  const outcome = await runResolve(workspaceId, "commit");

  expect(Result.isOk(outcome)).toBe(true);
  if (!Result.isOk(outcome)) {
    throw new TypeError("Expected the resolver to commit");
  }

  const persisted = await testDb
    .select({ id: properties.id, name: properties.name })
    .from(properties)
    .where(eq(properties.workspaceId, workspaceId));
  // Widened to `string` because the resolver hands back the branded and the
  // unbranded id types on different paths; only the name matters here.
  const nameById = new Map<string, string>(
    persisted.map((row) => [row.id, row.name]),
  );

  expect(outcome.value.propertyIds.map((id) => nameById.get(id))).toEqual([
    "Counterparty",
    "Summary",
  ]);

  const edges = await testDb
    .select({
      propertyId: propertyDependencies.propertyId,
      dependsOnPropertyId: propertyDependencies.dependsOnPropertyId,
    })
    .from(propertyDependencies)
    .where(eq(propertyDependencies.workspaceId, workspaceId));

  expect(
    edges.map((edge) => [
      nameById.get(edge.propertyId),
      nameById.get(edge.dependsOnPropertyId),
    ]),
  ).toEqual([["Summary", "Counterparty"]]);
});
