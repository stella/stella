import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { contacts } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  NO_DB,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import updateContact from "./update";

type UpdateContactContext = Parameters<typeof updateContact.handler>[0];
let testDb: TestDatabase;
let ids: TestIds;

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
}, 60_000);

afterAll(async () => {
  await releaseTestDb();
});

const update = async (body: UpdateContactContext["body"]) => {
  const auditFields: unknown[] = [];
  const result = await updateContact.handler(
    createTestHandlerContext<UpdateContactContext>({
      scopedDb: NO_DB,
      memberRole: sessionMemberRole("owner"),
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      params: { contactId: ids.contactA },
      safeDb: asTestRaw<SafeDb>(
        createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
      ),
      audit: async (_tx, events) => {
        for (const event of Array.isArray(events) ? events : [events]) {
          auditFields.push(event.changes);
        }
      },
      body,
    }),
  );
  const [row] = await testDb
    .select({
      currency: contacts.currency,
      defaultHourlyRate: contacts.defaultHourlyRate,
      notes: contacts.notes,
    })
    .from(contacts)
    .where(eq(contacts.id, ids.contactA));
  return { result, row, auditFields };
};

test.each([
  { source: "USD", target: "JPY", amount: 15_050, expected: 151 },
  { source: "JPY", target: "KWD", amount: 151, expected: 151_000 },
  { source: "USD", target: "EUR", amount: 15_050, expected: 15_050 },
  { source: "USD", target: "USD", amount: 15_050, expected: 15_050 },
  { source: "KWD", target: "JPY", amount: 150_499, expected: 150 },
  { source: "JPY", target: "KWD", amount: 0, expected: 0 },
  {
    source: "JPY",
    target: "KWD",
    amount: 9_007_199_254_740,
    expected: 9_007_199_254_740_000,
  },
])(
  "restates the currency's minor units: %j",
  async ({ source, target, amount, expected }) => {
    await testDb
      .update(contacts)
      .set({
        currency: source,
        defaultHourlyRate: cents(amount),
      })
      .where(eq(contacts.id, ids.contactA));
    const { result, row, auditFields } = await update({ currency: target });
    expect(result).toEqual({ id: ids.contactA });
    expect(row).toMatchObject({
      currency: target,
      defaultHourlyRate: expected,
    });
    expect(auditFields).toHaveLength(1);
    if (source === "USD" && target === "JPY") {
      expect(auditFields).toEqual([
        { fields: { old: null, new: ["currency", "defaultHourlyRate"] } },
      ]);
    }
  },
);

test("refuses an unsafe restatement before changing any field", async () => {
  await testDb
    .update(contacts)
    .set({
      currency: "JPY",
      defaultHourlyRate: cents(9_007_199_254_741),
      notes: "Before",
    })
    .where(eq(contacts.id, ids.contactA));
  const { result, row, auditFields } = await update({
    currency: "KWD",
    notes: "After",
  });
  expect(result).toEqual({
    code: 400,
    response: {
      message: "Currency change would put the contact rate out of range",
    },
  });
  expect(row).toEqual({
    currency: "JPY",
    defaultHourlyRate: cents(9_007_199_254_741),
    notes: "Before",
  });
  expect(auditFields).toEqual([]);
});

test.each([150_500, null])(
  "an explicit replacement rate %s uses the target currency",
  async (suppliedRate) => {
    await testDb
      .update(contacts)
      .set({
        currency: "JPY",
        defaultHourlyRate: cents(Number.MAX_SAFE_INTEGER),
      })
      .where(eq(contacts.id, ids.contactA));
    const { result, row } = await update({
      currency: "KWD",
      defaultHourlyRate: suppliedRate,
    });
    expect(result).toEqual({ id: ids.contactA });
    expect(row).toMatchObject({
      currency: "KWD",
      defaultHourlyRate: suppliedRate,
    });
  },
);

test.each([
  { source: "USD", target: "JPY", amount: null },
  { source: null, target: "JPY", amount: 151 },
  { source: "USD", target: null, amount: 15_050 },
])(
  "preserves nullable currency and rate: %j",
  async ({ source, target, amount }) => {
    await testDb
      .update(contacts)
      .set({
        currency: source,
        defaultHourlyRate: amount === null ? null : cents(amount),
      })
      .where(eq(contacts.id, ids.contactA));
    const { result, row } = await update({ currency: target });
    expect(result).toEqual({ id: ids.contactA });
    expect(row).toMatchObject({ currency: target, defaultHourlyRate: amount });
  },
);
