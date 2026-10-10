import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import { resultTx } from "@/api/db/safe-db";
import {
  auditLogs,
  clauses,
  clauseVariants,
  clauseVersions,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { createAuditRecorder, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

import { importHandler } from "./import";
import type {
  ClauseExportPayload,
  ClauseExportVariant,
} from "./import-export-schema";
import { getClauseHandler } from "./read";
import { insertClauseVariants } from "./variant-insert";
import { createVariantHandler, listVariantsHandler } from "./variants";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const seedFixture = async ({
  db,
  secondDb,
}: {
  db: GatedTestDb;
  secondDb: GatedTestDb;
}) => {
  const organizationId = mintAuthProviderId<"organization">();
  const otherOrganizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  await db.insert(organization).values(
    [organizationId, otherOrganizationId].map((id) => ({
      id,
      name: "Variant fixture",
      slug: id,
      createdAt: new Date(),
    })),
  );
  await db.insert(user).values({
    id: userId,
    name: "Variant fixture",
    email: `${userId}@variant.test`,
  });
  await db.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId,
    userId,
    role: "admin",
    createdAt: new Date(),
  });
  return {
    db,
    organizationId,
    otherOrganizationId,
    userId,
    safeDb: createSafeDb(markRlsDatabase(db), [], organizationId, userId),
    secondSafeDb: createSafeDb(
      markRlsDatabase(secondDb),
      [],
      organizationId,
      userId,
    ),
    recordAuditEvent: createAuditRecorder({
      organizationId,
      userId,
      workspaceId: null,
      request: new Request("http://localhost/clauses"),
      server: null,
    }),
  };
};

type VariantFixture = Awaited<ReturnType<typeof seedFixture>>;

const withFixture = async (run: (fixture: VariantFixture) => Promise<void>) => {
  if (!databaseUrl) {
    panic("DATABASE_URL required for variant tests");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const connection = { statement_timeout: 10_000, lock_timeout: 10_000 };
    const { db } = openClient({ connection });
    const { db: secondDb } = openClient({ connection });
    const fixture = await seedFixture({ db, secondDb });
    try {
      await run(fixture);
    } finally {
      await db
        .delete(auditLogs)
        .where(eq(auditLogs.organizationId, fixture.organizationId));
      await db
        .delete(clauses)
        .where(
          inArray(clauses.organizationId, [
            fixture.organizationId,
            fixture.otherOrganizationId,
          ]),
        );
      await db
        .delete(organization)
        .where(
          inArray(organization.id, [
            fixture.organizationId,
            fixture.otherOrganizationId,
          ]),
        );
      await db.delete(user).where(eq(user.id, fixture.userId));
    }
  });
};

const seedClause = async (fixture: VariantFixture) => {
  const clauseId = createSafeId<"clause">();
  await fixture.db.insert(clauses).values({
    id: clauseId,
    organizationId: fixture.organizationId,
    title: "Variant capacity",
    body: [{ text: "Primary wording" }],
    createdBy: fixture.userId,
  });
  return clauseId;
};

type SeedVariantsOptions = {
  fixture: VariantFixture;
  clauseId: SafeId<"clause">;
  count: number;
};

const seedVariants = async ({
  fixture,
  clauseId,
  count,
}: SeedVariantsOptions) => {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: createSafeId<"clauseVariant">(),
    organizationId: fixture.organizationId,
    clauseId,
    label: `Saved ${index}`,
    body: [{ text: `Wording ${index}` }],
    sortOrder: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  }));
  await fixture.db.insert(clauseVariants).values(rows.toReversed());
  return rows.toSorted((left, right) => {
    if (left.id === right.id) {
      return 0;
    }
    return left.id < right.id ? -1 : 1;
  });
};

const create = async (fixture: VariantFixture, clauseId: SafeId<"clause">) =>
  await Result.gen(() =>
    createVariantHandler({
      safeDb: fixture.safeDb,
      organizationId: fixture.organizationId,
      clauseId,
      body: { label: "New wording", body: [{ text: "Alternative" }] },
      recordAuditEvent: fixture.recordAuditEvent,
    }),
  );

const readVariants = async (
  fixture: VariantFixture,
  clauseId: SafeId<"clause">,
) => {
  const list = await Result.gen(() =>
    listVariantsHandler({
      safeDb: fixture.safeDb,
      organizationId: fixture.organizationId,
      clauseId,
    }),
  );
  if (list.isErr()) {
    throw list.error;
  }
  const detail = await Result.gen(() =>
    getClauseHandler({
      safeDb: fixture.safeDb,
      organizationId: fixture.organizationId,
      clauseId,
    }),
  );
  if (detail.isErr()) {
    throw detail.error;
  }
  return { list: list.value.variants, detail: detail.value.variants };
};

const variantAuditCount = async (fixture: VariantFixture) =>
  await fixture.db.$count(
    auditLogs,
    and(
      eq(auditLogs.organizationId, fixture.organizationId),
      eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.CLAUSE_VARIANT),
    ),
  );

const importFile = (variants: ClauseExportVariant[]) =>
  new File(
    [
      JSON.stringify({
        version: 1,
        exportedAt: new Date().toISOString(),
        clauses: [
          {
            title: "Imported variants",
            description: null,
            usageNotes: null,
            language: null,
            body: [{ text: "Primary" }],
            variants,
            metadata: null,
            categoryName: null,
            categoryPath: null,
          },
        ],
      } satisfies ClauseExportPayload),
    ],
    "clauses.json",
    { type: "application/json" },
  );

const importVariants = async (fixture: VariantFixture, file: File) =>
  await Result.gen(() =>
    importHandler({
      safeDb: fixture.safeDb,
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      body: { file },
      recordAuditEvent: fixture.recordAuditEvent,
    }),
  );

if (!databaseUrl || !runPostgresTests) {
  describe.skip("clause variants (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("clause variants (postgres)", () => {
    test("two creates at the last slot admit exactly one and expose every saved variant", async () => {
      await withFixture(async (fixture) => {
        const clauseId = await seedClause(fixture);
        const saved = await seedVariants({
          fixture,
          clauseId,
          count: LIMITS.clauseVariantsPerClause - 1,
        });
        const admitted = Promise.withResolvers<undefined>();
        const counted = Promise.withResolvers<undefined>();
        let admissions = 0;
        let counts = 0;
        // Coordinate entry without holding a parent lock at the barrier. If the
        // count escapes its transaction, coordinate both stale counts as well:
        // reverting the transaction fix then deterministically overfills the clause.
        const coordinate = (realSafeDb: SafeDb): SafeDb => {
          let firstCall = true;
          return async (run, retry) => {
            if (firstCall) {
              firstCall = false;
              admissions += 1;
              if (admissions === 2) {
                admitted.resolve(undefined);
              }
              await admitted.promise;
            }
            const result = await realSafeDb(run, retry);
            if (result.isOk() && typeof result.value === "number") {
              counts += 1;
              if (counts === 2) {
                counted.resolve(undefined);
              }
              await counted.promise;
            }
            return result;
          };
        };
        const outcomes = await Promise.all([
          create({ ...fixture, safeDb: coordinate(fixture.safeDb) }, clauseId),
          create(
            { ...fixture, safeDb: coordinate(fixture.secondSafeDb) },
            clauseId,
          ),
        ]);
        expect(admissions).toBe(2);
        expect(outcomes.filter((result) => result.isOk())).toHaveLength(1);
        const refusals = outcomes.filter((result) => result.isErr());
        expect(refusals).toHaveLength(1);
        expect(refusals.at(0)).toMatchObject({
          error: {
            status: 400,
            message: "Variant limit reached for this clause",
          },
        });
        expect(
          await fixture.db.$count(
            clauseVariants,
            eq(clauseVariants.clauseId, clauseId),
          ),
        ).toBe(LIMITS.clauseVariantsPerClause);
        const winner = outcomes.find((result) => result.isOk());
        if (!winner || winner.isErr()) {
          panic("Expected one successful variant create");
        }
        const expectedIds = [...saved.map((row) => row.id), winner.value.id];
        const reads = await readVariants(fixture, clauseId);
        expect(reads.list.map((row) => row.id)).toEqual(expectedIds);
        expect(reads.detail.map((row) => row.id)).toEqual(expectedIds);
        expect(await variantAuditCount(fixture)).toBe(1);
      });
    });

    test("legacy overflow remains visible and ordered across repeated list and detail reads", async () => {
      await withFixture(async (fixture) => {
        const clauseId = await seedClause(fixture);
        const saved = await seedVariants({
          fixture,
          clauseId,
          count: LIMITS.clauseVariantsPerClause + 1,
        });
        const expectedIds = saved.map((row) => row.id);
        for (let repetition = 0; repetition < 3; repetition += 1) {
          const reads = await readVariants(fixture, clauseId);
          expect(reads.list.map((row) => row.id)).toEqual(expectedIds);
          expect(reads.detail.map((row) => row.id)).toEqual(expectedIds);
          expect(reads.list.map((row) => row.body)).toEqual(
            saved.map((row) => row.body),
          );
          expect(reads.detail.map((row) => row.body)).toEqual(
            saved.map((row) => row.body),
          );
        }
        const refusal = await create(fixture, clauseId);
        expect(refusal).toMatchObject({
          error: {
            status: 400,
            message: "Variant limit reached for this clause",
          },
        });
        expect(
          await fixture.db.$count(
            clauseVariants,
            eq(clauseVariants.clauseId, clauseId),
          ),
        ).toBe(saved.length);
        expect(await variantAuditCount(fixture)).toBe(0);
      });
    });

    test("sort order precedes creation time and UUID breaks creation-time ties", async () => {
      await withFixture(async (fixture) => {
        const clauseId = await seedClause(fixture);
        const rows = await seedVariants({ fixture, clauseId, count: 4 });
        const [oldest, firstTie, secondTie, lastSort] = rows;
        if (!oldest || !firstTie || !secondTie || !lastSort) {
          panic("Expected four ordering fixtures");
        }
        await fixture.db
          .update(clauseVariants)
          .set({ createdAt: new Date("2026-02-01T00:00:00Z") })
          .where(inArray(clauseVariants.id, [firstTie.id, secondTie.id]));
        await fixture.db
          .update(clauseVariants)
          .set({ sortOrder: 1 })
          .where(eq(clauseVariants.id, lastSort.id));
        const expectedIds = [oldest.id, firstTie.id, secondTie.id, lastSort.id];
        const reads = await readVariants(fixture, clauseId);
        expect(reads.list.map((row) => row.id)).toEqual(expectedIds);
        expect(reads.detail.map((row) => row.id)).toEqual(expectedIds);
      });
    });

    test("missing and foreign clauses refuse creates and reads without mutation", async () => {
      await withFixture(async (fixture) => {
        const foreignId = await seedClause(fixture);
        await fixture.db
          .update(clauses)
          .set({ organizationId: fixture.otherOrganizationId })
          .where(eq(clauses.id, foreignId));
        for (const clauseId of [foreignId, createSafeId<"clause">()]) {
          const result = await create(fixture, clauseId);
          expect(result).toMatchObject({
            error: { status: 404, message: "Clause not found" },
          });
          const list = await Result.gen(() =>
            listVariantsHandler({
              safeDb: fixture.safeDb,
              organizationId: fixture.organizationId,
              clauseId,
            }),
          );
          const detail = await Result.gen(() =>
            getClauseHandler({
              safeDb: fixture.safeDb,
              organizationId: fixture.organizationId,
              clauseId,
            }),
          );
          expect(list).toMatchObject({ error: { status: 404 } });
          expect(detail).toMatchObject({ error: { status: 404 } });
          expect(
            await fixture.db.$count(
              clauseVariants,
              eq(clauseVariants.clauseId, clauseId),
            ),
          ).toBe(0);
        }
        expect(await variantAuditCount(fixture)).toBe(0);
      });
    });

    test("JSON import applies the shared capacity and audit boundary and reports truncated input", async () => {
      await withFixture(async (fixture) => {
        const variants = Array.from(
          { length: LIMITS.clauseVariantsPerClause + 1 },
          (_, index) => ({
            label: `Imported ${index}`,
            body: [{ text: `Alternative ${index}` }],
          }),
        );
        const result = await importVariants(fixture, importFile(variants));
        if (result.isErr()) {
          throw result.error;
        }
        expect(result.value.created).toBe(1);
        expect(result.value.errors).toHaveLength(1);
        expect(result.value.errors.at(0)).toContain(
          `kept ${LIMITS.clauseVariantsPerClause} of ${variants.length} variants`,
        );
        const clause = await fixture.db.query.clauses.findFirst({
          where: { organizationId: { eq: fixture.organizationId } },
        });
        if (!clause) {
          panic("Expected imported clause");
        }
        const reads = await readVariants(fixture, clause.id);
        const expected = variants.slice(0, LIMITS.clauseVariantsPerClause);
        expect(reads.list.map(({ label, body }) => ({ label, body }))).toEqual(
          expected,
        );
        expect(
          reads.detail.map(({ label, body }) => ({ label, body })),
        ).toEqual(expected);
        expect(await variantAuditCount(fixture)).toBe(
          LIMITS.clauseVariantsPerClause,
        );
        expect(await create(fixture, clause.id)).toMatchObject({
          error: { status: 400 },
        });
      });
    });

    test("a bulk request refuses all writes when any parent would overflow", async () => {
      await withFixture(async (fixture) => {
        const fullClause = await seedClause(fixture);
        const emptyClause = await seedClause(fixture);
        await seedVariants({
          fixture,
          clauseId: fullClause,
          count: LIMITS.clauseVariantsPerClause - 1,
        });
        const result = await resultTx(
          fixture.safeDb,
          async (tx) =>
            await insertClauseVariants({
              tx,
              organizationId: fixture.organizationId,
              recordAuditEvent: fixture.recordAuditEvent,
              variants: [emptyClause, fullClause, fullClause].map(
                (clauseId) => ({
                  clauseId,
                  label: "Bulk",
                  body: [{ text: "Alternative" }],
                }),
              ),
            }),
        );
        expect(result).toMatchObject({
          error: {
            status: 400,
            message: "Variant limit reached for this clause",
          },
        });
        expect(
          await fixture.db.$count(
            clauseVariants,
            eq(clauseVariants.clauseId, fullClause),
          ),
        ).toBe(LIMITS.clauseVariantsPerClause - 1);
        expect(
          await fixture.db.$count(
            clauseVariants,
            eq(clauseVariants.clauseId, emptyClause),
          ),
        ).toBe(0);
        expect(await variantAuditCount(fixture)).toBe(0);
      });
    });

    test("audit failure rolls back variants and the enclosing JSON import", async () => {
      await withFixture(async (fixture) => {
        const failingFixture = {
          ...fixture,
          recordAuditEvent: async () => {
            throw new HandlerError({
              status: 503,
              message: "Audit unavailable",
            });
          },
        };
        const clauseId = await seedClause(fixture);
        expect(await create(failingFixture, clauseId)).toMatchObject({
          error: { status: 503, message: "Audit unavailable" },
        });
        expect(
          await fixture.db.$count(
            clauseVariants,
            eq(clauseVariants.clauseId, clauseId),
          ),
        ).toBe(0);
        expect(
          await importVariants(
            failingFixture,
            importFile([
              { label: "Imported", body: [{ text: "Alternative" }] },
            ]),
          ),
        ).toMatchObject({
          error: { status: 503, message: "Audit unavailable" },
        });
        expect(
          await fixture.db.$count(
            clauses,
            eq(clauses.organizationId, fixture.organizationId),
          ),
        ).toBe(1);
        expect(
          await fixture.db.$count(
            clauseVariants,
            eq(clauseVariants.organizationId, fixture.organizationId),
          ),
        ).toBe(0);
        expect(
          await fixture.db.$count(
            clauseVersions,
            eq(clauseVersions.organizationId, fixture.organizationId),
          ),
        ).toBe(0);
        expect(await variantAuditCount(fixture)).toBe(0);
      });
    });
  });
}
