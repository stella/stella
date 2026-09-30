import { panic } from "better-result";
import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";
import { Temporal } from "@stll/time";

import type { SafeDb } from "@/api/db/safe-db";
import {
  contacts,
  entities,
  expenses,
  invoices,
  timeEntries,
  workspaces,
} from "@/api/db/schema";
import { createMembershipSafeDb, createSafeDb } from "@/api/db/scoped";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import listClients from "./clients/list";
import listWip from "./list";

setDefaultTimeout(120_000);
let db: TestDatabase;
let ids: TestIds;
const clientId = createSafeId<"contact">();
const matters = [
  createSafeId<"workspace">(),
  createSafeId<"workspace">(),
  createSafeId<"workspace">(),
];
const firstMatter = matters.at(0) ?? panic("Missing fixture matter");
const secondMatter = matters.at(1) ?? panic("Missing fixture matter");
const unassignedMatter =
  matters.at(2) ?? panic("Missing unassigned fixture matter");
const entityId = createSafeId<"entity">();
const invoiceId = createSafeId<"invoice">();
const internalIds: ReturnType<typeof createSafeId<"timeEntry">>[] = [];
const AS_OF = "2026-10-01";
const dateAgo = (days: number) =>
  Temporal.PlainDate.from(AS_OF).subtract({ days }).toString();
beforeAll(async () => {
  const fixture = await getRlsFixture();
  db = fixture.testDb;
  ids = fixture.ids;
  await db.insert(contacts).values({
    id: clientId,
    organizationId: ids.orgA,
    type: "person",
    displayName: "WIP client",
  });
  await db.insert(workspaces).values(
    matters.map((id) => ({
      id,
      organizationId: ids.orgA,
      clientId: id === unassignedMatter ? null : clientId,
      name: "WIP matter",
      reference: id,
    })),
  );
  await db.insert(entities).values({
    id: entityId,
    workspaceId: firstMatter,
    kind: "document",
    name: "WIP expense item",
  });
  await db.insert(invoices).values({
    id: invoiceId,
    workspaceId: firstMatter,
    organizationId: ids.orgA,
    currency: "USD",
    invoiceDate: AS_OF,
  });
});
const cleanup = async () => {
  await db.delete(expenses).where(inArray(expenses.workspaceId, matters));
  await db.delete(timeEntries).where(inArray(timeEntries.workspaceId, matters));
  if (internalIds.length) {
    await db
      .delete(timeEntries)
      .where(inArray(timeEntries.id, internalIds.splice(0)));
  }
};
beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await db.delete(invoices).where(eq(invoices.id, invoiceId));
  await db.delete(entities).where(eq(entities.id, entityId));
  await db.delete(workspaces).where(inArray(workspaces.id, matters));
  await db.delete(contacts).where(eq(contacts.id, clientId));
  await releaseRlsFixture();
});
const timeRow = (overrides: Partial<typeof timeEntries.$inferInsert> = {}) => ({
  id: createSafeId<"timeEntry">(),
  organizationId: ids.orgA,
  workspaceId: firstMatter,
  userId: ids.userAdmin,
  dateWorked: AS_OF,
  timezoneId: "UTC",
  durationMinutes: 60,
  billedMinutes: 60,
  rateAtEntry: cents(100),
  currency: "USD",
  narrative: "Client work",
  status: "approved" as const,
  billable: true,
  ...overrides,
});
const read = async (
  query: Parameters<typeof listWip.handler>[0]["query"] = {},
) => {
  const response = await listWip.handler(
    createTestHandlerContext<Parameters<typeof listWip.handler>[0]>({
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userAdmin },
      safeDb: asTestRaw<SafeDb>(
        createSafeDb(db, matters, ids.orgA, ids.userAdmin),
      ),
      query: { asOf: AS_OF, clientId, ...query },
    }),
  );
  if (!("items" in response)) {
    panic(`WIP read refused: ${JSON.stringify(response)}`);
  }
  return response;
};
const readClients = async (
  query: Parameters<typeof listClients.handler>[0]["query"] = {},
) => {
  const response = await listClients.handler(
    createTestHandlerContext<Parameters<typeof listClients.handler>[0]>({
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userAdmin },
      safeDb: asTestRaw<SafeDb>(
        createSafeDb(db, matters, ids.orgA, ids.userAdmin),
      ),
      query: { asOf: AS_OF, ...query },
    }),
  );
  if (!("items" in response)) {
    panic(`WIP client read refused: ${JSON.stringify(response)}`);
  }
  return response;
};

test("WIP counts only approved unattached billable client time and includes unbilled expense markup without FX", async () => {
  const internal = timeRow({
    activityGroup: TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
    workspaceId: null,
    billable: false,
    billedMinutes: 0,
    rateAtEntry: cents(0),
    currency: UNPRICED_TIME_ENTRY_CURRENCY,
  });
  internalIds.push(internal.id);
  await db
    .insert(timeEntries)
    .values([
      timeRow(),
      timeRow({ status: "draft" }),
      timeRow({ status: "written_off" }),
      timeRow({ status: "billed", invoiceId }),
      timeRow({ invoiceId }),
      timeRow({ billable: false }),
      timeRow({ noCharge: true }),
      internal,
      timeRow({ currency: "EUR", rateAtEntry: cents(700) }),
    ]);
  const expense = {
    organizationId: ids.orgA,
    workspaceId: firstMatter,
    matterId: entityId,
    userId: ids.userAdmin,
    dateIncurred: AS_OF,
    amount: cents(101),
    currency: "USD",
    category: "filing_fee" as const,
    description: "Expense",
    markup: 50,
  };
  await db
    .insert(expenses)
    .values([
      expense,
      { ...expense, billable: false },
      { ...expense, status: "written_off" },
      { ...expense, invoiceId },
      { ...expense, status: "billed" },
    ]);
  const result = await read();
  expect(result.items).toHaveLength(1);
  expect(result.totalsByCurrency).toMatchObject([
    {
      currency: "EUR",
      timeAmount: "700",
      expenseAmount: "0",
      totalAmount: "700",
    },
    {
      currency: "USD",
      timeAmount: "100",
      expenseAmount: "152",
      totalAmount: "252",
    },
  ]);
});

test("aging boundaries partition exact minor-unit values and future dates explicitly have age zero", async () => {
  await db.insert(timeEntries).values(
    [-1, 0, 30, 31, 60, 61, 90, 91].map((age) =>
      timeRow({
        dateWorked: dateAgo(age),
        rateAtEntry: cents(age === -1 ? 10 : 100),
      }),
    ),
  );
  expect((await read()).totalsByCurrency.at(0)).toMatchObject({
    totalAmount: "710",
    aged: {
      days0To30: "210",
      days31To60: "200",
      days61To90: "200",
      daysOver90: "100",
    },
  });
});

test("SQL proration remains exact beyond floating intermediates and aggregate totals beyond safe JSON numbers", async () => {
  await db
    .insert(timeEntries)
    .values([
      timeRow({ billedMinutes: 1, rateAtEntry: cents(9_007_199_254_740_989) }),
      timeRow({ currency: "EUR", rateAtEntry: cents(Number.MAX_SAFE_INTEGER) }),
      timeRow({ currency: "EUR", rateAtEntry: cents(Number.MAX_SAFE_INTEGER) }),
    ]);
  expect((await read()).totalsByCurrency).toMatchObject([
    { currency: "EUR", totalAmount: "18014398509481982" },
    { currency: "USD", totalAmount: "150119987579016" },
  ]);
});

test("matter cursor pagination never truncates complete scope totals or client totals", async () => {
  await db
    .insert(timeEntries)
    .values([
      timeRow(),
      timeRow({ workspaceId: secondMatter, rateAtEntry: cents(200) }),
    ]);
  const first = await read({ limit: 1 });
  expect(first.items).toHaveLength(1);
  expect(first.nextCursor).not.toBeNull();
  expect(first.totalsByCurrency.at(0)?.totalAmount).toBe("300");
  const second = await read({
    limit: 1,
    cursor: first.nextCursor ?? panic("Missing next cursor"),
  });
  expect(second.items).toHaveLength(1);
  expect(second.items.at(0)?.matterId).not.toBe(first.items.at(0)?.matterId);
  expect(second.nextCursor).toBeNull();
  expect(second.totalsByCurrency).toEqual(first.totalsByCurrency);
  expect((await readClients({ clientId })).items.at(0)).toMatchObject({
    clientId,
    clientName: "WIP client",
    currencies: [{ currency: "USD", totalAmount: "300" }],
  });
});

test("unassigned clients are an explicit stable cursor bucket", async () => {
  await db
    .insert(timeEntries)
    .values([
      timeRow(),
      timeRow({ workspaceId: unassignedMatter, rateAtEntry: cents(200) }),
    ]);
  const page = await readClients({ limit: 1 });
  expect(page.items.at(0)).toMatchObject({ clientId: null, clientName: null });
  expect(page.nextCursor).not.toBeNull();
  const next = await readClients({
    limit: 1,
    cursor: page.nextCursor ?? panic("Missing client cursor"),
  });
  expect(next.items.at(0)?.clientId).not.toBeNull();
});

test("matter filters stay within the active organization", async () => {
  const response = await listWip.handler(
    createTestHandlerContext<Parameters<typeof listWip.handler>[0]>({
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userAdmin },
      safeDb: asTestRaw<SafeDb>(
        createSafeDb(db, [ids.wsB1], ids.orgA, ids.userAdmin),
      ),
      query: { matterId: ids.wsB1, asOf: AS_OF },
    }),
  );
  expect(response).toMatchObject({
    code: 404,
    response: { code: "wip_matter_not_found" },
  });
});

test("membership-scoped WIP cannot read another member's inaccessible matter", async () => {
  await db.insert(timeEntries).values(timeRow());
  const response = await listWip.handler(
    createTestHandlerContext<Parameters<typeof listWip.handler>[0]>({
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      safeDb: asTestRaw<SafeDb>(
        createMembershipSafeDb(db, {
          organizationId: ids.orgA,
          userId: ids.userA1,
          serverValidatedWorkspaceIds: [],
        }),
      ),
      query: { matterId: firstMatter, asOf: AS_OF },
    }),
  );
  expect(response).toMatchObject({
    code: 404,
    response: { code: "wip_matter_not_found" },
  });
  expect(
    (await read({ matterId: firstMatter })).totalsByCurrency.at(0)?.totalAmount,
  ).toBe("100");
});

test("unpriced snapshots are counted separately from intentionally zero-valued priced work", async () => {
  await db.insert(timeEntries).values([
    timeRow({
      currency: UNPRICED_TIME_ENTRY_CURRENCY,
      rateAtEntry: cents(0),
    }),
    timeRow({ rateAtEntry: cents(0) }),
  ]);
  expect((await read()).totalsByCurrency).toMatchObject([
    { currency: "USD", totalAmount: "0", unpricedTimeEntryCount: "0" },
    {
      currency: UNPRICED_TIME_ENTRY_CURRENCY,
      totalAmount: "0",
      unpricedTimeEntryCount: "1",
    },
  ]);
});

test.each([
  { asOf: "2026-10-02" },
  { currency: "EUR" },
  { clientId: createSafeId<"contact">() },
])(
  "WIP cursor rejects changed aging or filtering scope: %j",
  async (changed) => {
    await db
      .insert(timeEntries)
      .values([timeRow(), timeRow({ workspaceId: secondMatter })]);
    const first = await read({ limit: 1 });
    const response = await listWip.handler(
      createTestHandlerContext<Parameters<typeof listWip.handler>[0]>({
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userAdmin },
        safeDb: asTestRaw<SafeDb>(
          createSafeDb(db, matters, ids.orgA, ids.userAdmin),
        ),
        query: {
          asOf: AS_OF,
          clientId,
          cursor: first.nextCursor ?? panic("Missing scope cursor"),
          ...changed,
        },
      }),
    );
    expect(response).toMatchObject({
      code: 400,
      response: { code: "invalid_wip_cursor" },
    });
  },
);
