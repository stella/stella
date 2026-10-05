import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { vatRates } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import createVatRate from "@/api/handlers/vat-rates/create";
import updateVatRate from "@/api/handlers/vat-rates/update";
import { resolveVatRate } from "@/api/lib/billing/vat-rates";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { enrolTimeBilling } from "@/api/tests/helpers/time-billing-enrolment";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);
let testDb: TestDatabase;
let ids: TestIds;
const createdIds: SafeId<"vatRate">[] = [];
type RateValues = typeof vatRates.$inferInsert & { id: SafeId<"vatRate"> };
type CreateContext = Parameters<typeof createVatRate.handler>[0];
type UpdateContext = Parameters<typeof updateVatRate.handler>[0];

const seedRates = async (values: RateValues[]) => {
  createdIds.push(...values.map(({ id }) => id));
  await testDb.insert(vatRates).values(values);
};

const resolveInOrg = async (options: {
  organizationId: SafeId<"organization">;
  code: string;
  on: string;
}) =>
  await createScopedDb(
    testDb,
    [],
    options.organizationId,
    ids.userA1,
  )(async (tx) => await resolveVatRate(asTestRaw<Transaction>(tx), options));

const requestContext = () => ({
  request: new Request("https://example.test/v1/vat-rates", { method: "POST" }),
  route: "/v1/vat-rates",
  safeDb: createSafeDb(testDb, [], ids.orgA, ids.userA1),
  session: { activeOrganizationId: ids.orgA },
  memberRole: sessionMemberRole("owner"),
  user: { id: ids.userA1 },
  recordAuditEvent: async () => {},
});

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  await enrolTimeBilling(testDb, [
    { userId: ids.userA1, organizationId: ids.orgA },
  ]);
});

afterAll(async () => {
  if (createdIds.length > 0) {
    await testDb.delete(vatRates).where(inArray(vatRates.id, createdIds));
  }
  await releaseRlsFixture();
});

describe("VAT rate validity", () => {
  test("resolves inclusive starts, exclusive ends, gaps and an open-ended period", async () => {
    const code = `boundary-${Bun.randomUUIDv7()}`;
    const firstId = createSafeId<"vatRate">();
    const currentId = createSafeId<"vatRate">();
    await seedRates([
      {
        id: firstId,
        organizationId: ids.orgA,
        code,
        name: "Earlier",
        rateBps: 2100,
        validFrom: "2025-01-01",
        validTo: "2025-07-01",
      },
      {
        id: currentId,
        organizationId: ids.orgA,
        code,
        name: "Current",
        rateBps: 2200,
        validFrom: "2025-08-01",
      },
    ]);
    const dates = [
      "2024-12-31",
      "2025-01-01",
      "2025-06-30",
      "2025-07-01",
      "2025-07-31",
      "2025-08-01",
      "2099-12-31",
    ];
    const results = await Promise.all(
      dates.map(
        async (on) =>
          await resolveInOrg({ organizationId: ids.orgA, code, on }),
      ),
    );
    expect(
      results.map((result) =>
        result.isOk() ? result.value.id : result.error.status,
      ),
    ).toEqual([404, firstId, firstId, 404, 404, currentId, currentId]);
  });

  test("excludes archived periods and isolates organization rates through RLS", async () => {
    const code = `isolation-${Bun.randomUUIDv7()}`;
    const ownId = createSafeId<"vatRate">();
    const foreignId = createSafeId<"vatRate">();
    const archivedId = createSafeId<"vatRate">();
    await seedRates([
      {
        id: ownId,
        organizationId: ids.orgA,
        code,
        name: "Own",
        rateBps: 2100,
        validFrom: "2026-01-01",
      },
      {
        id: foreignId,
        organizationId: ids.orgB,
        code,
        name: "Foreign",
        rateBps: 1900,
        validFrom: "2026-01-01",
      },
      {
        id: archivedId,
        organizationId: ids.orgA,
        code: `${code}-archived`,
        name: "Archived",
        rateBps: 0,
        validFrom: "2026-01-01",
        archivedAt: new Date("2026-02-01T00:00:00Z"),
      },
    ]);
    expect(
      (
        await resolveInOrg({ organizationId: ids.orgA, code, on: "2026-03-01" })
      ).unwrap().id,
    ).toBe(ownId);
    expect(
      (
        await resolveInOrg({
          organizationId: ids.orgA,
          code: `${code}-archived`,
          on: "2026-03-01",
        })
      ).isErr(),
    ).toBe(true);
    const visible = await createScopedDb(
      testDb,
      [],
      ids.orgA,
      ids.userA1,
    )(
      async (tx) =>
        await tx
          .select({ id: vatRates.id })
          .from(vatRates)
          .where(inArray(vatRates.id, [ownId, foreignId])),
    );
    expect(visible).toEqual([{ id: ownId }]);
    const forgedOrganization = await createScopedDb(
      testDb,
      [],
      ids.orgA,
      ids.userA1,
    )(
      async (tx) =>
        await resolveVatRate(asTestRaw<Transaction>(tx), {
          organizationId: ids.orgB,
          code,
          on: "2026-03-01",
        }),
    );
    expect(forgedOrganization.isErr()).toBe(true);
  });

  test("serializes overlapping creates even when the code has no existing period", async () => {
    const code = `concurrent-${Bun.randomUUIDv7()}`;
    const body = {
      code,
      name: "Concurrent",
      rateBps: 2100,
      validFrom: "2026-01-01",
      validTo: null,
    };
    const results = await Promise.all([
      createVatRate.handler(
        asTestRaw<CreateContext>({ ...requestContext(), body }),
      ),
      createVatRate.handler(
        asTestRaw<CreateContext>({ ...requestContext(), body }),
      ),
    ]);
    const rows = await testDb
      .select()
      .from(vatRates)
      .where(eq(vatRates.code, code));
    createdIds.push(...rows.map(({ id }) => id));
    expect(rows).toHaveLength(1);
    expect(
      results.filter((result) => "code" in result && result.code === 409),
    ).toHaveLength(1);
  });

  test("allows adjacent periods but rejects overlapping updates without changing the row", async () => {
    const code = `overlap-${Bun.randomUUIDv7()}`;
    const firstId = createSafeId<"vatRate">();
    await seedRates([
      {
        id: firstId,
        organizationId: ids.orgA,
        code,
        name: "First",
        rateBps: 2100,
        validFrom: "2026-01-01",
        validTo: "2026-07-01",
      },
    ]);
    await createVatRate.handler(
      asTestRaw<CreateContext>({
        ...requestContext(),
        body: {
          code,
          name: "Second",
          rateBps: 2200,
          validFrom: "2026-07-01",
          validTo: null,
        },
      }),
    );
    const rows = await testDb
      .select()
      .from(vatRates)
      .where(eq(vatRates.code, code));
    createdIds.push(
      ...rows.filter(({ id }) => id !== firstId).map(({ id }) => id),
    );
    expect(rows).toHaveLength(2);
    const rejected = await updateVatRate.handler(
      asTestRaw<UpdateContext>({
        ...requestContext(),
        params: { vatRateId: firstId },
        body: { validTo: "2026-07-02" },
      }),
    );
    expect(rejected).toMatchObject({ code: 409 });
    const unchanged = await testDb
      .select({ validTo: vatRates.validTo })
      .from(vatRates)
      .where(eq(vatRates.id, firstId));
    expect(unchanged).toEqual([{ validTo: "2026-07-01" }]);
  });
});
