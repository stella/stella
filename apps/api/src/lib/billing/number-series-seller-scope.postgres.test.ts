import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import { numberSeries, sellerProfiles } from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import createSeries from "@/api/handlers/number-series/create";
import setDefault from "@/api/handlers/number-series/default/update";
import updateSeries from "@/api/handlers/number-series/update";
import {
  allocateNumber,
  findDefaultNumberSeries,
} from "@/api/lib/billing/number-series";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { isPgConstraintError, PG_ERROR } from "@/api/lib/pg-error";
import {
  openGatedTestDatabase,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { enrolledTimeBillingSnapshot } from "@/api/tests/helpers/time-billing-enrolment";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("seller-scoped number series (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("seller-scoped number series (postgres)", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);
    const rlsDb = markRlsDatabase(db);

    const fixture = async () => {
      const orgId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const sellerA = createSafeId<"sellerProfile">();
      const sellerB = createSafeId<"sellerProfile">();
      const sellerC = createSafeId<"sellerProfile">();
      const archivedSeller = createSafeId<"sellerProfile">();
      cleanUp(async () => {
        // The seller FK restricts deletion; remove series before profiles.
        await db
          .delete(numberSeries)
          .where(eq(numberSeries.organizationId, orgId));
        await db.delete(organization).where(eq(organization.id, orgId));
        await db.delete(user).where(eq(user.id, userId));
      });
      await db.insert(organization).values({
        id: orgId,
        name: "Series scope",
        slug: orgId,
        createdAt: new Date(),
      });
      await db.insert(user).values({
        id: userId,
        name: "Series owner",
        email: `${userId}@example.test`,
      });
      await db.insert(member).values({
        id: mintAuthProviderIdValue(),
        organizationId: orgId,
        userId,
        role: "owner",
        createdAt: new Date(),
      });
      await db.insert(sellerProfiles).values([
        ...[sellerA, sellerB, sellerC].map((id) => ({
          id,
          organizationId: orgId,
          legalName: id,
          defaultCurrency: "EUR",
        })),
        {
          id: archivedSeller,
          organizationId: orgId,
          legalName: archivedSeller,
          defaultCurrency: "EUR",
          archivedAt: new Date(),
        },
      ]);
      const contextFor = (database: GatedTestDb) => ({
        safeDb: createSafeDb(markRlsDatabase(database), [], orgId, userId),
        session: { activeOrganizationId: orgId },
        user: { id: userId, email: `${userId}@example.test` },
        memberRole: sessionMemberRole("owner"),
        request: new Request("https://example.test/v1/number-series", {
          method: "POST",
        }),
        route: "/v1/number-series",
        recordAuditEvent: async () => {},
        featureAccessSnapshot: enrolledTimeBillingSnapshot({
          organizationId: orgId,
          userId,
        }),
      });
      const context = contextFor(db);
      const insert = async ({
        sellerProfileId = null,
        isDefault = false,
        archivedAt = null,
        pattern = "SERIES-{SEQ}",
      }: {
        sellerProfileId?: SafeId<"sellerProfile"> | null;
        isDefault?: boolean;
        archivedAt?: Date | null;
        pattern?: string;
      } = {}) => {
        const id = createSafeId<"numberSeries">();
        await db.insert(numberSeries).values({
          id,
          organizationId: orgId,
          documentType: "invoice",
          name: id,
          padding: 3,
          sellerProfileId,
          isDefault,
          archivedAt,
          pattern,
        });
        return id;
      };
      const create = async (
        sellerProfileId?: SafeId<"sellerProfile">,
        database: GatedTestDb = db,
      ) =>
        await createSeries.handler(
          asTestRaw<Parameters<typeof createSeries.handler>[0]>({
            ...contextFor(database),
            body: {
              documentType: "invoice",
              name: "Series",
              pattern: "NEW-{SEQ}",
              padding: 3,
              sellerProfileId,
            },
          }),
        );
      const makeDefault = async (id: SafeId<"numberSeries">) =>
        await setDefault.handler(
          asTestRaw<Parameters<typeof setDefault.handler>[0]>({
            ...context,
            params: { numberSeriesId: id },
          }),
        );
      const update = async (
        id: SafeId<"numberSeries">,
        sellerProfileId: SafeId<"sellerProfile"> | null,
      ) =>
        await updateSeries.handler(
          asTestRaw<Parameters<typeof updateSeries.handler>[0]>({
            ...context,
            params: { numberSeriesId: id },
            body: { sellerProfileId },
          }),
        );
      const defaults = async () =>
        await db.query.numberSeries.findMany({
          where: {
            organizationId: { eq: orgId },
            isDefault: { eq: true },
            archivedAt: { isNull: true },
          },
          columns: { id: true, sellerProfileId: true },
          limit: 20,
        });
      const stored = async () =>
        await db
          .select({
            id: numberSeries.id,
            isDefault: numberSeries.isDefault,
            sellerProfileId: numberSeries.sellerProfileId,
          })
          .from(numberSeries)
          .where(eq(numberSeries.organizationId, orgId));
      return {
        orgId,
        sellerA,
        sellerB,
        sellerC,
        archivedSeller,
        insert,
        create,
        makeDefault,
        update,
        defaults,
        stored,
        scopedDb: createScopedDb(rlsDb, [], orgId, userId),
      };
    };

    test("seller defaults take precedence and only the organization default is a fallback", async () => {
      const f = await fixture();
      const all = await f.insert({ isDefault: true });
      const a = await f.insert({ sellerProfileId: f.sellerA, isDefault: true });
      const b = await f.insert({ sellerProfileId: f.sellerB, isDefault: true });
      const result = await f.scopedDb(
        async (tx) =>
          await Promise.all(
            [f.sellerA, f.sellerB, f.sellerC, null].map(
              async (seller) =>
                await findDefaultNumberSeries(tx, "invoice", seller),
            ),
          ),
      );
      expect(result.map((row) => row?.id)).toEqual([a, b, all, all]);
    });

    test("another seller default, an archived series and a nondefault never supply a missing default", async () => {
      const f = await fixture();
      await f.insert({ sellerProfileId: f.sellerB, isDefault: true });
      const archived = await f.insert({
        sellerProfileId: f.sellerA,
        archivedAt: new Date(),
      });
      await f.insert({ sellerProfileId: f.sellerA });
      const result = await f.scopedDb(async (tx) => ({
        seller: await findDefaultNumberSeries(tx, "invoice", f.sellerA),
        organization: await findDefaultNumberSeries(tx, "invoice", null),
        documentType: await findDefaultNumberSeries(tx, "advance", f.sellerB),
        archived: await allocateNumber(
          tx,
          archived,
          new Date("2026-10-02T00:00:00Z"),
        ),
      }));
      expect(result.seller).toBeUndefined();
      expect(result.organization).toBeUndefined();
      expect(result.documentType).toBeUndefined();
      if (!result.archived.isErr()) {
        panic("Expected archived allocation to fail");
      }
      expect(result.archived.error).toMatchObject({
        status: 404,
        message: "Number series not found",
      });
    });

    test("an archived seller series allows the organization fallback", async () => {
      const f = await fixture();
      const all = await f.insert({ isDefault: true });
      const archived = await f.insert({
        sellerProfileId: f.sellerA,
        isDefault: true,
      });
      await db
        .update(numberSeries)
        .set({ isDefault: false, archivedAt: new Date() })
        .where(eq(numberSeries.id, archived));
      const result = await f.scopedDb(
        async (tx) => await findDefaultNumberSeries(tx, "invoice", f.sellerA),
      );
      expect(result?.id).toBe(all);
    });

    test("database refuses a second default in the same seller and organization scopes", async () => {
      const f = await fixture();
      for (const sellerProfileId of [null, f.sellerA]) {
        await f.insert({ sellerProfileId, isDefault: true });
        const alternate = await f.insert({ sellerProfileId });
        const duplicate = await Result.tryPromise({
          try: async () =>
            await db
              .update(numberSeries)
              .set({ isDefault: true })
              .where(eq(numberSeries.id, alternate)),
          catch: (cause) => cause,
        });
        if (!duplicate.isErr()) {
          panic("Expected the second default to be refused");
        }
        expect(
          isPgConstraintError(
            duplicate.error,
            PG_ERROR.UNIQUE_VIOLATION,
            sellerProfileId === null
              ? "number_series_org_type_default_uidx"
              : "number_series_org_type_seller_default_uidx",
          ),
        ).toBe(true);
      }
    });

    test("independent seller series allocate independent counters", async () => {
      const f = await fixture();
      await f.insert({
        sellerProfileId: f.sellerA,
        isDefault: true,
        pattern: "A-{SEQ}",
      });
      await f.insert({
        sellerProfileId: f.sellerB,
        isDefault: true,
        pattern: "B-{SEQ}",
      });
      const numbers = await f.scopedDb(async (tx) => {
        const result = [];
        for (const seller of [f.sellerA, f.sellerB, f.sellerA, f.sellerB]) {
          const series = await findDefaultNumberSeries(tx, "invoice", seller);
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

    test("creation chooses the first default independently per scope even under concurrency", async () => {
      const f = await fixture();
      for (const seller of [undefined, f.sellerA, f.sellerB]) {
        // Each caller holds its own session so the two requests overlap.
        const results = await withGatedTestClients(
          databaseUrl,
          async ({ openClient }) =>
            await Promise.all(
              [openClient().db, openClient().db].map(
                async (connection) => await f.create(seller, connection),
              ),
            ),
        );
        for (const result of results) {
          expect(result).toMatchObject({
            id: expect.any(String),
            isDefault: expect.any(Boolean),
          });
        }
        const scope = seller ?? null;
        const rows = (await f.stored())
          .filter((row) => row.sellerProfileId === scope)
          .map(({ id, isDefault }) => ({ id, isDefault }));
        expect(rows).toHaveLength(2);
        expect(rows).toEqual(expect.arrayContaining(results));
        expect(rows.filter((row) => row.isDefault)).toHaveLength(1);
      }
      const defaults = await f.defaults();
      expect(defaults).toHaveLength(3);
      expect(new Set(defaults.map((row) => row.sellerProfileId))).toEqual(
        new Set([null, f.sellerA, f.sellerB]),
      );
    });

    test("creation ignores archived series and rejects absent, archived and foreign sellers", async () => {
      const f = await fixture();
      await f.insert({ sellerProfileId: f.sellerA, archivedAt: new Date() });
      expect(await f.create(f.sellerA)).toMatchObject({
        id: expect.any(String),
        isDefault: true,
      });
      const foreign = await fixture();
      for (const seller of [
        createSafeId<"sellerProfile">(),
        f.archivedSeller,
        foreign.sellerA,
      ]) {
        expect(await f.create(seller)).toEqual({
          code: 404,
          response: { message: "Seller profile not found" },
        });
      }
      expect(await f.defaults()).toHaveLength(1);
    });

    test("concurrent default switches preserve the organization and other seller defaults", async () => {
      const f = await fixture();
      const all = await f.insert({ isDefault: true });
      const a = await f.insert({ sellerProfileId: f.sellerA, isDefault: true });
      const alternate = await f.insert({ sellerProfileId: f.sellerA });
      const b = await f.insert({ sellerProfileId: f.sellerB, isDefault: true });
      const results = await Promise.all([a, alternate].map(f.makeDefault));
      expect(results).toEqual([
        { id: a, isDefault: true },
        { id: alternate, isDefault: true },
      ]);
      const defaults = await f.defaults();
      expect(
        defaults.filter((row) => row.sellerProfileId === f.sellerA),
      ).toHaveLength(1);
      expect(defaults.map((row) => row.id)).toContain(b);
      expect(defaults.map((row) => row.id)).toContain(all);
      expect(defaults).toHaveLength(3);
    });

    test("switching the organization default preserves seller scopes and missing, archived or foreign series cannot become default", async () => {
      const f = await fixture();
      await f.insert({ isDefault: true });
      const replacement = await f.insert();
      const a = await f.insert({ sellerProfileId: f.sellerA, isDefault: true });
      expect(await f.makeDefault(replacement)).toEqual({
        id: replacement,
        isDefault: true,
      });
      expect((await f.defaults()).map((row) => row.id).toSorted()).toEqual(
        [replacement, a].toSorted(),
      );
      const archived = await f.insert({ archivedAt: new Date() });
      const foreign = await fixture();
      const foreignSeries = await foreign.insert();
      for (const id of [
        createSafeId<"numberSeries">(),
        archived,
        foreignSeries,
      ]) {
        expect(await f.makeDefault(id)).toEqual({
          code: 404,
          response: { message: "Number series not found" },
        });
      }
      expect((await f.defaults()).map((row) => row.id).toSorted()).toEqual(
        [replacement, a].toSorted(),
      );
    });

    test("moving a default to a free seller and then the organization scope retains its default status", async () => {
      const f = await fixture();
      const id = await f.insert({
        sellerProfileId: f.sellerA,
        isDefault: true,
      });
      for (const sellerProfileId of [f.sellerC, null]) {
        expect(await f.update(id, sellerProfileId)).toEqual({ id });
        expect(await f.defaults()).toEqual([{ id, sellerProfileId }]);
      }
    });

    test("a default cannot move into an occupied seller or organization scope, while a nondefault can", async () => {
      const f = await fixture();
      const all = await f.insert({ isDefault: true });
      const a = await f.insert({ sellerProfileId: f.sellerA, isDefault: true });
      const b = await f.insert({ sellerProfileId: f.sellerB, isDefault: true });
      const alternate = await f.insert({ sellerProfileId: f.sellerB });
      for (const scope of [f.sellerA, null]) {
        expect(await f.update(b, scope)).toEqual({
          code: 409,
          response: {
            message:
              "A default number series already exists for this seller scope",
          },
        });
        expect(await f.update(alternate, scope)).toEqual({ id: alternate });
        const moved = await db.query.numberSeries.findFirst({
          where: { id: { eq: alternate } },
          columns: { sellerProfileId: true, isDefault: true },
        });
        expect(moved).toEqual({ sellerProfileId: scope, isDefault: false });
      }
      expect(await f.update(a, f.sellerA)).toEqual({ id: a });
      expect((await f.defaults()).map((row) => row.id).toSorted()).toEqual(
        [all, a, b].toSorted(),
      );
    });

    test("scope updates reject absent, archived and foreign sellers and inaccessible series without mutation", async () => {
      const f = await fixture();
      const id = await f.insert({
        sellerProfileId: f.sellerA,
        isDefault: true,
      });
      const foreign = await fixture();
      for (const seller of [
        createSafeId<"sellerProfile">(),
        f.archivedSeller,
        foreign.sellerA,
      ]) {
        expect(await f.update(id, seller)).toEqual({
          code: 404,
          response: { message: "Seller profile not found" },
        });
      }
      const archived = await f.insert({ archivedAt: new Date() });
      const foreignSeries = await foreign.insert();
      for (const inaccessible of [
        createSafeId<"numberSeries">(),
        archived,
        foreignSeries,
      ]) {
        expect(await f.update(inaccessible, f.sellerB)).toEqual({
          code: 404,
          response: { message: "Number series not found" },
        });
      }
      expect(await f.defaults()).toEqual([{ id, sellerProfileId: f.sellerA }]);
    });
  });
}
