import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { numberSeries, sellerProfiles } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import setDefault from "@/api/handlers/number-series/default/update";
import updateSeries from "@/api/handlers/number-series/update";
import {
  allocateNumber,
  findDefaultNumberSeries,
} from "@/api/lib/billing/number-series";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

describe.skipIf(process.env.STELLA_RUN_POSTGRES_TESTS !== "true")(
  "seller-scoped number series",
  () => {
    let fixture: Awaited<ReturnType<typeof getRlsFixture>>;
    const orgId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
    const sellerA = createSafeId<"sellerProfile">();
    const sellerB = createSafeId<"sellerProfile">();
    const sellerC = createSafeId<"sellerProfile">();
    const allSeries = createSafeId<"numberSeries">();
    const aSeries = createSafeId<"numberSeries">();
    const bSeries = createSafeId<"numberSeries">();
    const alternateA = createSafeId<"numberSeries">();

    beforeAll(async () => {
      fixture = await getRlsFixture();
      await fixture.testDb.insert(organization).values({
        id: orgId,
        name: "Series scope",
        slug: orgId,
        createdAt: new Date(),
      });
      await fixture.testDb.insert(sellerProfiles).values(
        [sellerA, sellerB, sellerC].map((id) => ({
          id,
          organizationId: orgId,
          legalName: id,
          defaultCurrency: "EUR",
        })),
      );
      await fixture.testDb.insert(numberSeries).values(
        [
          {
            id: allSeries,
            sellerProfileId: null,
            pattern: "ALL-{SEQ}",
            isDefault: true,
          },
          {
            id: aSeries,
            sellerProfileId: sellerA,
            pattern: "A-{SEQ}",
            isDefault: true,
          },
          {
            id: bSeries,
            sellerProfileId: sellerB,
            pattern: "B-{SEQ}",
            isDefault: true,
          },
          {
            id: alternateA,
            sellerProfileId: sellerA,
            pattern: "ALT-{SEQ}",
            isDefault: false,
          },
        ].map(({ id, sellerProfileId, pattern, isDefault }) => ({
          id,
          sellerProfileId,
          pattern,
          isDefault,
          organizationId: orgId,
          documentType: "invoice" as const,
          name: id,
          padding: 3,
        })),
      );
    });

    afterAll(async () => {
      await fixture.testDb
        .delete(organization)
        .where(eq(organization.id, orgId));
      await releaseRlsFixture();
    });

    test("seller defaults take precedence and unrelated sellers use only the all-sellers fallback", async () => {
      const result = await createScopedDb(
        fixture.testDb,
        [],
        orgId,
        fixture.ids.userA1,
      )(async (scoped) => {
        const tx = asTestRaw<Transaction>(scoped);
        return Promise.all(
          [sellerA, sellerB, sellerC, null].map((seller) =>
            findDefaultNumberSeries(tx, "invoice", seller),
          ),
        );
      });
      expect(result.map((row) => row?.id)).toEqual([
        aSeries,
        bSeries,
        allSeries,
        allSeries,
      ]);
      const missing = await createScopedDb(
        fixture.testDb,
        [],
        orgId,
        fixture.ids.userA1,
      )(async (scoped) =>
        findDefaultNumberSeries(
          asTestRaw<Transaction>(scoped),
          "advance",
          sellerA,
        ),
      );
      expect(missing).toBeUndefined();
    });

    test("database refuses a second default in the same seller scope", async () => {
      const duplicateError = await fixture.testDb
        .update(numberSeries)
        .set({ isDefault: true })
        .where(eq(numberSeries.id, alternateA))
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(duplicateError).toMatchObject({
        cause: {
          code: "23505",
          constraint: "number_series_org_type_seller_default_uidx",
        },
      });
    });

    test("independent seller series allocate independent counters", async () => {
      const numbers = await createScopedDb(
        fixture.testDb,
        [],
        orgId,
        fixture.ids.userA1,
      )(async (scoped) => {
        const tx = asTestRaw<Transaction>(scoped);
        const result = [];
        for (const seller of [sellerA, sellerB, sellerA, sellerB]) {
          const series = await findDefaultNumberSeries(tx, "invoice", seller);
          expect(series).toBeDefined();
          if (!series) {
            panic("Expected seller series");
          }
          result.push(
            (
              await allocateNumber(
                tx,
                series.id,
                new Date("2026-10-02T00:00:00Z"),
              )
            ).unwrap().number,
          );
        }
        return result;
      });
      expect(numbers).toEqual(["A-001", "B-001", "A-002", "B-002"]);
    });

    test("moving a default into an occupied seller scope returns 409", async () => {
      const result = await updateSeries.handler(
        asTestRaw<Parameters<typeof updateSeries.handler>[0]>({
          params: { numberSeriesId: bSeries },
          body: { sellerProfileId: sellerA },
          safeDb: createSafeDb(fixture.testDb, [], orgId, fixture.ids.userA1),
          session: { activeOrganizationId: orgId },
          user: { id: fixture.ids.userA1 },
          memberRole: { role: "owner" },
          request: new Request("https://example.test/v1/number-series", {
            method: "PATCH",
          }),
          route: "/v1/number-series/:numberSeriesId",
          recordAuditEvent: async () => {},
        }),
      );
      expect(result).toEqual({
        code: 409,
        response: {
          message:
            "A default number series already exists for this seller scope",
        },
      });
    });

    test("concurrent default switches preserve other seller scopes and leave exactly one winner", async () => {
      const results = await Promise.all(
        [aSeries, alternateA].map((id) =>
          setDefault.handler(
            asTestRaw<Parameters<typeof setDefault.handler>[0]>({
              params: { numberSeriesId: id },
              safeDb: createSafeDb(
                fixture.testDb,
                [],
                orgId,
                fixture.ids.userA1,
              ),
              session: { activeOrganizationId: orgId },
              user: { id: fixture.ids.userA1 },
              memberRole: { role: "owner" },
              request: new Request(
                "https://example.test/v1/number-series/default",
                { method: "PUT" },
              ),
              route: "/v1/number-series/:numberSeriesId/default",
              recordAuditEvent: async () => {},
            }),
          ),
        ),
      );
      expect(results.map((result) => result.code)).toEqual([200, 200]);
      const defaults = await fixture.testDb.query.numberSeries.findMany({
        where: { organizationId: { eq: orgId }, isDefault: { eq: true } },
        columns: { id: true, sellerProfileId: true },
        limit: 10,
      });
      expect(
        defaults.filter((row) => row.sellerProfileId === sellerA),
      ).toHaveLength(1);
      expect(defaults.map((row) => row.id)).toContain(bSeries);
      expect(defaults.map((row) => row.id)).toContain(allSeries);
      expect(defaults).toHaveLength(3);
    });
  },
);
