import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";

import type { ScopedDb } from "@/api/db/safe-db";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import readBillingCodes from "@/api/handlers/billing-codes/read";
import readContactById from "@/api/handlers/contacts/read-by-id";
import readEntityById from "@/api/handlers/entities/read-by-id";
import readVersionById from "@/api/handlers/entities/read-version-by-id";
import readVersions from "@/api/handlers/entities/read-versions";
import readExpenses from "@/api/handlers/expenses/read";
import { readFileHandler } from "@/api/handlers/files/read-by-id";
import readInvoiceById from "@/api/handlers/invoices/read-by-id";
import readRateEntries from "@/api/handlers/rates/entries-read";
import getTemplate from "@/api/handlers/templates/get";
import readTimeEntryById from "@/api/handlers/time-entries/read-by-id";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

type TestHandlerContext = {
  activeWorkspaceIds: SafeId<"workspace">[];
  accessibleWorkspaces: { id: SafeId<"workspace">; status: "active" }[];
  createAuditRecorder: () => AuditRecorder;
  memberRole: { role: "owner" };
  orgAIConfig: null;
  promptCachingEnabled: false;
  recordAuditEvent: AuditRecorder;
  request: Request;
  route: string;
  safeDb: ReturnType<typeof createSafeDb<TestDatabaseTransaction>>;
  scopedDb: ReturnType<typeof createScopedDb<TestDatabaseTransaction>>;
  session: { activeOrganizationId: SafeId<"organization"> };
  user: { id: SafeId<"user"> };
  workspaceId: SafeId<"workspace">;
};

type IsolationContext = {
  ids: TestIds;
  workspaceA: TestHandlerContext;
  workspaceB: TestHandlerContext;
};

type IsolationCase = {
  name: string;
  runAAgainstB: (context: IsolationContext) => Promise<unknown>;
  runBPositive: (context: IsolationContext) => Promise<unknown>;
  expectDenied: (result: unknown, context: IsolationContext) => void;
  expectPositive: (result: unknown, context: IsolationContext) => void;
};

let testDb: TestDatabase;
let ids: TestIds;

const noopAuditRecorder: AuditRecorder = async () => undefined;

const isolationCases: IsolationCase[] = [
  {
    name: "entity read by id",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(readEntityById, workspaceA, {
        params: {
          workspaceId: testIds.wsA1,
          entityId: testIds.entityB1,
        },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(readEntityById, workspaceB, {
        params: {
          workspaceId: testIds.wsB1,
          entityId: testIds.entityB1,
        },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result, { ids: testIds }) =>
      expectRecordFieldEquals(result, "entityId", testIds.entityB1),
  },
  {
    name: "entity version list",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(readVersions, workspaceA, {
        params: {
          workspaceId: testIds.wsA1,
          entityId: testIds.entityB1,
        },
        query: {},
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(readVersions, workspaceB, {
        params: {
          workspaceId: testIds.wsB1,
          entityId: testIds.entityB1,
        },
        query: {},
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result, { ids: testIds }) => {
      expectRecordFieldEquals(result, "entityId", testIds.entityB1);
      expectVersionsContainId(result, testIds.entityVersionB1);
    },
  },
  {
    name: "entity version read by id",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(readVersionById, workspaceA, {
        params: {
          workspaceId: testIds.wsA1,
          entityId: testIds.entityB1,
          versionId: testIds.entityVersionB1,
        },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(readVersionById, workspaceB, {
        params: {
          workspaceId: testIds.wsB1,
          entityId: testIds.entityB1,
          versionId: testIds.entityVersionB1,
        },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result, { ids: testIds }) =>
      expectRecordFieldEquals(result, "id", testIds.entityVersionB1),
  },
  {
    name: "file field download metadata",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(readFileHandler, workspaceA, {
        scopedDb: asTestRaw<ScopedDb>(workspaceA.scopedDb),
        fieldId: testIds.fieldB1,
        organizationId: testIds.orgA,
        workspaceId: testIds.wsA1,
        purpose: "download",
        recordAuditEvent: noopAuditRecorder,
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(readFileHandler, workspaceB, {
        scopedDb: asTestRaw<ScopedDb>(workspaceB.scopedDb),
        fieldId: testIds.fieldB1,
        organizationId: testIds.orgB,
        workspaceId: testIds.wsB1,
        purpose: "download",
        recordAuditEvent: noopAuditRecorder,
      }),
    expectDenied: expectStatus(404),
    expectPositive: expectStatus(400),
  },
  {
    name: "invoice read by id",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(readInvoiceById, workspaceA, {
        params: {
          workspaceId: testIds.wsA1,
          invoiceId: testIds.invoiceB1,
        },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(readInvoiceById, workspaceB, {
        params: {
          workspaceId: testIds.wsB1,
          invoiceId: testIds.invoiceB1,
        },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result, { ids: testIds }) =>
      expectRecordFieldEquals(result, "id", testIds.invoiceB1),
  },
  {
    name: "time entry read by id",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(readTimeEntryById, workspaceA, {
        params: {
          workspaceId: testIds.wsA1,
          id: testIds.timeEntryB1,
        },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(readTimeEntryById, workspaceB, {
        params: {
          workspaceId: testIds.wsB1,
          id: testIds.timeEntryB1,
        },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result, { ids: testIds }) =>
      expectRecordFieldEquals(result, "id", testIds.timeEntryB1),
  },
  {
    name: "rate table entries list",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(readRateEntries, workspaceA, {
        params: { workspaceId: testIds.wsA1, rateTableId: testIds.rateTableB1 },
        query: { limit: 25 },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(readRateEntries, workspaceB, {
        params: { workspaceId: testIds.wsB1, rateTableId: testIds.rateTableB1 },
        query: { limit: 25 },
      }),
    expectDenied: expectEmptyPage,
    expectPositive: (result, { ids: testIds }) =>
      expectPageContainsId(result, testIds.rateEntryB1),
  },
  {
    name: "expenses filtered by matter id",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(readExpenses, workspaceA, {
        query: { limit: 25, matterId: testIds.entityB1 },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(readExpenses, workspaceB, {
        query: { limit: 25, matterId: testIds.entityB1 },
      }),
    expectDenied: expectEmptyPage,
    expectPositive: (result, { ids: testIds }) =>
      expectPageContainsId(result, testIds.expenseB1),
  },
  {
    name: "billing code list",
    runAAgainstB: async ({ workspaceA }) =>
      await runHandler(readBillingCodes, workspaceA, {
        query: { limit: 100 },
      }),
    runBPositive: async ({ workspaceB }) =>
      await runHandler(readBillingCodes, workspaceB, {
        query: { limit: 100 },
      }),
    expectDenied: (result, { ids: testIds }) =>
      expectPageExcludesId(result, testIds.billingCodeB1),
    expectPositive: (result, { ids: testIds }) =>
      expectPageContainsId(result, testIds.billingCodeB1),
  },
  {
    name: "organization contact read by id",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(readContactById, workspaceA, {
        params: { contactId: testIds.contactB },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(readContactById, workspaceB, {
        params: { contactId: testIds.contactB },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result, { ids: testIds }) =>
      expectRecordFieldEquals(result, "id", testIds.contactB),
  },
  {
    name: "organization template read by id",
    runAAgainstB: async ({ ids: testIds, workspaceA }) =>
      await runHandler(getTemplate, workspaceA, {
        params: { templateId: testIds.templateB },
      }),
    runBPositive: async ({ ids: testIds, workspaceB }) =>
      await runHandler(getTemplate, workspaceB, {
        params: { templateId: testIds.templateB },
      }),
    expectDenied: expectStatus(404),
    expectPositive: (result, { ids: testIds }) =>
      expectRecordFieldEquals(result, "id", testIds.templateB),
  },
];

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
});

afterAll(async () => {
  await releaseTestDb();
});

describe("cross-tenant handler isolation", () => {
  for (const testCase of isolationCases) {
    test(`${testCase.name}: workspace A cannot read workspace/org B resource IDs`, async () => {
      const context = createIsolationContext();

      const result = await testCase.runAAgainstB(context);

      testCase.expectDenied(result, context);
    });

    test(`${testCase.name}: fixture exposes the target inside its own tenant`, async () => {
      const context = createIsolationContext();

      const result = await testCase.runBPositive(context);

      testCase.expectPositive(result, context);
    });
  }
});

const createIsolationContext = (): IsolationContext => ({
  ids,
  workspaceA: createWorkspaceContext({
    activeWorkspaceIds: [ids.wsA1],
    organizationId: ids.orgA,
    userId: ids.userA1,
    workspaceId: ids.wsA1,
  }),
  workspaceB: createWorkspaceContext({
    activeWorkspaceIds: [ids.wsB1],
    organizationId: ids.orgB,
    userId: ids.userB1,
    workspaceId: ids.wsB1,
  }),
});

const createWorkspaceContext = ({
  activeWorkspaceIds,
  organizationId,
  userId,
  workspaceId,
}: {
  activeWorkspaceIds: SafeId<"workspace">[];
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
}): TestHandlerContext => {
  const scopedDb = createScopedDb(
    testDb,
    activeWorkspaceIds,
    organizationId,
    userId,
  );
  const safeDb = createSafeDb(
    testDb,
    activeWorkspaceIds,
    organizationId,
    userId,
  );

  return {
    activeWorkspaceIds,
    accessibleWorkspaces: activeWorkspaceIds.map((id) => ({
      id,
      status: "active",
    })),
    createAuditRecorder: () => noopAuditRecorder,
    memberRole: { role: "owner" },
    orgAIConfig: null,
    promptCachingEnabled: false,
    recordAuditEvent: noopAuditRecorder,
    request: new Request(`https://example.test/workspaces/${workspaceId}`),
    route: "/security/cross-tenant-handler",
    safeDb,
    scopedDb,
    session: { activeOrganizationId: organizationId },
    user: { id: userId },
    workspaceId,
  };
};

type TestEndpoint<TContext> =
  | { handler: (context: TContext) => Promise<unknown> }
  | ((context: TContext) => Promise<unknown>);

const runHandler = async <TContext>(
  endpoint: TestEndpoint<TContext>,
  context: TestHandlerContext,
  requestShape: Partial<TContext> & Record<string, unknown>,
): Promise<unknown> => {
  const handler = typeof endpoint === "function" ? endpoint : endpoint.handler;

  try {
    return await handler(
      asTestRaw<TContext>({
        ...context,
        ...requestShape,
      }),
    );
  } catch (error) {
    return error;
  }
};

function expectStatus(expectedStatus: number): (result: unknown) => void {
  return (result: unknown): void => {
    expect(getStatusCode(result)).toBe(expectedStatus);
  };
}

function expectEmptyPage(result: unknown): void {
  expect(getStatusCode(result)).toBeNull();
  expect(getPageItems(result)).toEqual([]);
}

function expectPageContainsId(result: unknown, expectedId: string): void {
  expect(getStatusCode(result)).toBeNull();
  expect(getPageItems(result).some((item) => item.id === expectedId)).toBe(
    true,
  );
}

function expectPageExcludesId(result: unknown, excludedId: string): void {
  expect(getStatusCode(result)).toBeNull();
  expect(getPageItems(result).some((item) => item.id === excludedId)).toBe(
    false,
  );
}

function expectRecordFieldEquals(
  result: unknown,
  field: string,
  expectedValue: string,
): void {
  expect(getStatusCode(result)).toBeNull();
  if (!isRecord(result)) {
    throw new Error("Expected an object response");
  }
  expect(result[field]).toBe(expectedValue);
}

function expectVersionsContainId(result: unknown, expectedId: string): void {
  expect(getStatusCode(result)).toBeNull();
  if (!isRecord(result) || !Array.isArray(result["versions"])) {
    throw new Error("Expected a versions response");
  }
  expect(
    result["versions"].some(
      (version) => isRecord(version) && version["id"] === expectedId,
    ),
  ).toBe(true);
}

const getStatusCode = (result: unknown): number | null => {
  if (!isRecord(result)) {
    return null;
  }

  if (typeof result["status"] === "number") {
    return result["status"];
  }

  if (typeof result["statusCode"] === "number") {
    return result["statusCode"];
  }

  if (typeof result["code"] === "number") {
    return result["code"];
  }

  return null;
};

const getPageItems = (result: unknown): { id: string }[] => {
  if (!isRecord(result) || !Array.isArray(result["items"])) {
    throw new Error("Expected a page response");
  }

  return result["items"].map((item) => {
    if (!isRecord(item) || typeof item["id"] !== "string") {
      throw new Error("Expected every page item to include a string id");
    }
    return { id: item["id"] };
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
