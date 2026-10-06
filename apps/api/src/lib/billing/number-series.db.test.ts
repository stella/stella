import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  numberSeries,
  numberSeriesAllocations,
  numberSeriesCounters,
  sellerProfiles,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import createNumberSeries from "@/api/handlers/number-series/create";
import updateNumberSeries from "@/api/handlers/number-series/update";
import { allocateNumber } from "@/api/lib/billing/number-series";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
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
const createdSeriesIds: SafeId<"numberSeries">[] = [];
type UpdateContext = Parameters<typeof updateNumberSeries.handler>[0];
type CreateContext = Parameters<typeof createNumberSeries.handler>[0];

const createSeries = async (
  organizationId: SafeId<"organization">,
  options: {
    documentType?: "invoice" | "advance" | "credit_note";
    pattern?: string;
    isDefault?: boolean;
  } = {},
) => {
  const id = createSafeId<"numberSeries">();
  await testDb.insert(numberSeries).values({
    id,
    organizationId,
    documentType: options.documentType ?? "invoice",
    name: `Series ${id}`,
    pattern: options.pattern ?? "INV-{YYYY}-{SEQ}",
    padding: 3,
    isDefault: options.isDefault ?? false,
  });
  createdSeriesIds.push(id);
  return id;
};

const allocateInOrg = async (
  organizationId: SafeId<"organization">,
  seriesId: SafeId<"numberSeries">,
  issuedAt: Date,
) =>
  await createScopedDb(
    testDb,
    [],
    organizationId,
    ids.userA1,
  )(
    async (scoped) =>
      await allocateNumber(asTestRaw<Transaction>(scoped), seriesId, issuedAt),
  );

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  await enrolTimeBilling(testDb, [
    { userId: ids.userA1, organizationId: ids.orgA },
  ]);
});

afterAll(async () => {
  if (createdSeriesIds.length > 0) {
    await testDb
      .delete(numberSeries)
      .where(inArray(numberSeries.id, createdSeriesIds));
  }
  await releaseRlsFixture();
});

describe("number series allocation", () => {
  test("serializes allocations across transactions and resets at the period boundary", async () => {
    const seriesId = await createSeries(ids.orgA);
    const beforeRollover = new Date("2025-12-31T23:59:00.000Z");

    const [first, second] = await Promise.all([
      allocateInOrg(ids.orgA, seriesId, beforeRollover),
      allocateInOrg(ids.orgA, seriesId, beforeRollover),
    ]);

    expect(
      [first, second].map((result) => result.unwrap().number).toSorted(),
    ).toEqual(["INV-2025-001", "INV-2025-002"]);

    const nextPeriod = await allocateInOrg(
      ids.orgA,
      seriesId,
      new Date("2026-01-01T00:01:00.000Z"),
    );
    expect(nextPeriod.unwrap().number).toBe("INV-2026-001");
  });

  test("resets a monthly series when the rendered month changes", async () => {
    const seriesId = await createSeries(ids.orgA, {
      pattern: "INV-{YYYY}-{MM}-{SEQ}",
    });
    const january = await allocateInOrg(
      ids.orgA,
      seriesId,
      new Date("2026-01-15T12:00:00.000Z"),
    );
    const february = await allocateInOrg(
      ids.orgA,
      seriesId,
      new Date("2026-02-15T12:00:00.000Z"),
    );
    expect(january.unwrap().number).toBe("INV-2026-01-001");
    expect(february.unwrap().number).toBe("INV-2026-02-001");
  });

  test("keeps the pattern fixed after a number has been allocated", async () => {
    const seriesId = await createSeries(ids.orgA);
    await allocateInOrg(
      ids.orgA,
      seriesId,
      new Date("2026-06-15T12:00:00.000Z"),
    );
    const context = asTestRaw<UpdateContext>({
      params: { numberSeriesId: seriesId },
      body: { pattern: "CHANGED-{YYYY}-{SEQ}" },
      request: new Request(
        `https://example.test/v1/number-series/${seriesId}`,
        {
          method: "PATCH",
        },
      ),
      route: "/v1/number-series/:numberSeriesId",
      safeDb: createSafeDb(testDb, [], ids.orgA, ids.userA1),
      session: { activeOrganizationId: ids.orgA },
      memberRole: sessionMemberRole("owner"),
      user: { id: ids.userA1 },
      recordAuditEvent: async () => {},
    });
    expect(await updateNumberSeries.handler(context)).toEqual({
      code: 409,
      response: {
        message: "Pattern and padding cannot change after allocation",
      },
    });
    const rows = await testDb
      .select({ pattern: numberSeries.pattern })
      .from(numberSeries)
      .where(inArray(numberSeries.id, [seriesId]));
    expect(rows.at(0)?.pattern).toBe("INV-{YYYY}-{SEQ}");
  });

  test("rejects a number already allocated by another series", async () => {
    const firstSeries = await createSeries(ids.orgA);
    const secondSeries = await createSeries(ids.orgA);
    const issuedAt = new Date("2027-04-15T12:00:00.000Z");
    expect(
      (await allocateInOrg(ids.orgA, firstSeries, issuedAt)).unwrap().number,
    ).toBe("INV-2027-001");
    const collision = await allocateInOrg(ids.orgA, secondSeries, issuedAt);
    expect(collision.isErr()).toBe(true);
    const receipts = await testDb
      .select({ seriesId: numberSeriesAllocations.seriesId })
      .from(numberSeriesAllocations)
      .where(
        inArray(numberSeriesAllocations.seriesId, [firstSeries, secondSeries]),
      );
    expect(receipts).toEqual([{ seriesId: firstSeries }]);
  });

  test("rejects a seller profile from another organization", async () => {
    const sellerProfileId = createSafeId<"sellerProfile">();
    await testDb.insert(sellerProfiles).values({
      id: sellerProfileId,
      organizationId: ids.orgB,
      legalName: "Other organization",
      defaultCurrency: "EUR",
    });
    try {
      const context = asTestRaw<CreateContext>({
        body: {
          documentType: "invoice",
          name: "Cross-org series",
          pattern: "INV-{YYYY}-{SEQ}",
          padding: 3,
          sellerProfileId,
        },
        request: new Request("https://example.test/v1/number-series", {
          method: "POST",
        }),
        route: "/v1/number-series",
        safeDb: createSafeDb(testDb, [], ids.orgA, ids.userA1),
        session: { activeOrganizationId: ids.orgA },
        memberRole: sessionMemberRole("owner"),
        user: { id: ids.userA1 },
        recordAuditEvent: async () => {},
      });
      expect(await createNumberSeries.handler(context)).toEqual({
        code: 404,
        response: { message: "Seller profile not found" },
      });
    } finally {
      await testDb
        .delete(sellerProfiles)
        .where(inArray(sellerProfiles.id, [sellerProfileId]));
    }
  });

  test("deletes an organization with a series linked to its seller profile", async () => {
    const organizationId = toSafeId<"organization">(
      `org_${Bun.randomUUIDv7()}`,
    );
    const sellerProfileId = createSafeId<"sellerProfile">();
    await testDb.insert(organization).values({
      id: organizationId,
      name: "Number series deletion test",
      slug: `number-series-${organizationId}`,
      createdAt: new Date(),
    });
    await testDb.insert(sellerProfiles).values({
      id: sellerProfileId,
      organizationId,
      legalName: "Seller",
      defaultCurrency: "EUR",
    });
    const seriesId = createSafeId<"numberSeries">();
    await testDb.insert(numberSeries).values({
      id: seriesId,
      organizationId,
      sellerProfileId,
      documentType: "invoice",
      name: "Invoice series",
      pattern: "INV-{YYYY}-{SEQ}",
      padding: 3,
    });

    try {
      const deletionError = await testDb
        .delete(sellerProfiles)
        .where(eq(sellerProfiles.id, sellerProfileId))
        .execute()
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(deletionError).toMatchObject({ cause: { code: "23503" } });
      await testDb
        .delete(organization)
        .where(eq(organization.id, organizationId));
    } finally {
      await testDb.delete(numberSeries).where(eq(numberSeries.id, seriesId));
      await testDb
        .delete(sellerProfiles)
        .where(eq(sellerProfiles.id, sellerProfileId));
      await testDb
        .delete(organization)
        .where(eq(organization.id, organizationId));
    }
  });

  test("allows one default series for each document type and rejects a duplicate default", async () => {
    const defaults = [];
    for (const documentType of ["invoice", "advance", "credit_note"] as const) {
      defaults.push(
        await createSeries(ids.orgA, { documentType, isDefault: true }),
      );
    }

    expect(defaults).toHaveLength(3);
    const duplicateError = await createSeries(ids.orgA, {
      documentType: "invoice",
      isDefault: true,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(duplicateError).toMatchObject({
      cause: {
        code: "23505",
        constraint: "number_series_org_type_default_uidx",
      },
    });
  });

  test("keeps series and counters isolated by organization RLS", async () => {
    const orgASeries = await createSeries(ids.orgA);
    const orgBSeries = await createSeries(ids.orgB);
    await allocateInOrg(
      ids.orgA,
      orgASeries,
      new Date("2026-03-01T12:00:00.000Z"),
    );
    await allocateInOrg(
      ids.orgB,
      orgBSeries,
      new Date("2026-03-01T12:00:00.000Z"),
    );

    const rowsForOrgA = await createScopedDb(
      testDb,
      [],
      ids.orgA,
      ids.userA1,
    )(
      async (tx) =>
        await tx
          .select({ seriesId: numberSeriesCounters.seriesId })
          .from(numberSeriesCounters)
          .where(
            inArray(numberSeriesCounters.seriesId, [orgASeries, orgBSeries]),
          ),
    );

    expect(rowsForOrgA.map((row) => row.seriesId)).toEqual([orgASeries]);
    const otherOrgAllocation = await allocateInOrg(
      ids.orgA,
      orgBSeries,
      new Date("2026-03-02T12:00:00.000Z"),
    );
    expect(otherOrgAllocation.isErr()).toBe(true);
    const rootAllocation = await testDb.transaction(
      async (tx) =>
        await allocateNumber(
          asTestRaw<Transaction>(tx),
          orgBSeries,
          new Date("2026-03-02T12:00:00.000Z"),
        ),
    );
    expect(rootAllocation.isErr()).toBe(true);
  });
});
