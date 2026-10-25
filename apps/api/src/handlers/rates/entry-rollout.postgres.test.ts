import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  featureEnrolments,
  rateEntries,
  rateTables,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { withTimeBillingEnrolment } from "@/api/tests/helpers/time-billing-enrolment";
import { waitForBlockedPid } from "@/api/tests/helpers/wait-for-blocked-pid";

import updateRateEntry from "./entries/update";
import updateRateTable from "./update";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

type GatedTestClient = ReturnType<
  Parameters<Parameters<typeof withGatedTestClients>[1]>[0]["openClient"]
>;

const record: AuditRecorder = async () => {};
const pidColumns = { pid: sql<number>`pg_backend_pid()` };
const identity = sql`(SELECT 1) AS backend_identity`;
const backendPid = (rows: { pid: number }[]) =>
  rows.at(0)?.pid ?? panic("Backend identity missing");

type RolloutFixture = {
  setup: GatedTestClient;
  writer: GatedTestClient;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  rateTableId: SafeId<"rateTable">;
  januaryEntryId: SafeId<"rateEntry">;
  februaryEntryId: SafeId<"rateEntry">;
  writerPid: number;
  /**
   * The previous build's entry create: the per-table lock alone, then the
   * insert, held open until `release` resolves.
   */
  holdLegacyCreate: (release: Promise<undefined>) => Promise<{
    legacyPid: number;
    committed: Promise<void>;
  }>;
};

const withRolloutFixture = async (
  run: (fixture: RolloutFixture) => Promise<void>,
) => {
  await withGatedTestClients(
    databaseUrl ?? panic("DATABASE_URL required"),
    async ({ openClient }) => {
      const setup = openClient({ max: 1 });
      const legacy = openClient({ max: 1 });
      const writer = openClient({ max: 1 });
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const rateTableId = createSafeId<"rateTable">();
      const januaryEntryId = createSafeId<"rateEntry">();
      const februaryEntryId = createSafeId<"rateEntry">();
      try {
        await setup.db.insert(user).values({
          id: userId,
          name: "Rate rollout",
          email: `${userId}@rate-rollout.test`,
          emailVerified: true,
        });
        await setup.db.insert(organization).values({
          id: organizationId,
          name: "Rate rollout",
          slug: organizationId,
          createdAt: new Date(),
        });
        await setup.db.insert(member).values({
          id: mintAuthProviderIdValue(),
          organizationId,
          userId,
          role: "owner",
          createdAt: new Date(),
        });
        await setup.db.insert(featureEnrolments).values({
          organizationId,
          userId,
          featureId: "time-billing",
        });
        await setup.db.insert(workspaces).values({
          id: workspaceId,
          organizationId,
          name: "Rate rollout matter",
          reference: workspaceId,
        });
        await setup.db.insert(workspaceMembers).values({ workspaceId, userId });
        await setup.db.insert(rateTables).values({
          id: rateTableId,
          organizationId,
          workspaceId,
          name: "Default rates",
          currency: "USD",
          isDefault: true,
        });
        await setup.db.insert(rateEntries).values({
          id: januaryEntryId,
          workspaceId,
          rateTableId,
          userId: null,
          role: null,
          hourlyRate: cents(10_000),
          effectiveFrom: "2026-01-01",
          effectiveTo: "2026-01-31",
        });
        const writerPid = backendPid(
          await writer.db.select(pidColumns).from(identity),
        );
        const holdLegacyCreate = async (release: Promise<undefined>) => {
          const holds = Promise.withResolvers<number>();
          const committed = legacy.db.transaction(async (tx) => {
            await tx.execute(
              sql`SELECT pg_advisory_xact_lock(hashtext(${rateTableId}))`,
            );
            await tx.insert(rateEntries).values({
              id: februaryEntryId,
              workspaceId,
              rateTableId,
              userId: null,
              role: null,
              hourlyRate: cents(12_000),
              effectiveFrom: "2026-02-01",
              effectiveTo: "2026-02-28",
            });
            holds.resolve(
              backendPid(await tx.select(pidColumns).from(identity)),
            );
            await release;
          });
          const legacyPid = await Promise.race([
            holds.promise,
            committed.then(() => null),
          ]);
          if (legacyPid === null) {
            return panic("The previous build's create committed early");
          }
          return { legacyPid, committed };
        };
        await run({
          setup,
          writer,
          organizationId,
          userId,
          workspaceId,
          rateTableId,
          januaryEntryId,
          februaryEntryId,
          writerPid,
          holdLegacyCreate,
        });
      } finally {
        await setup.db
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await setup.db.delete(user).where(eq(user.id, userId));
      }
    },
  );
};

/** The writer's handler context fields; each call names its context type. */
const writerContextFields = (fixture: RolloutFixture) => ({
  scopedDb: NO_DB,
  audit: record,
  workspaceId: fixture.workspaceId,
  session: { activeOrganizationId: fixture.organizationId },
  user: { id: fixture.userId },
  safeDb: createSafeDb(
    markRlsDatabase(fixture.writer.db),
    [fixture.workspaceId],
    fixture.organizationId,
    fixture.userId,
  ),
});

const raceLegacyCreate = async (
  fixture: RolloutFixture,
  write: () => Promise<unknown>,
) => {
  const release = Promise.withResolvers<undefined>();
  const { legacyPid, committed } = await fixture.holdLegacyCreate(
    release.promise,
  );
  const written = write();
  try {
    await waitForBlockedPid(fixture.setup.sql, {
      waitingPid: fixture.writerPid,
      holdingPid: legacyPid,
    });
  } finally {
    release.resolve(undefined);
  }
  await committed;
  return await written;
};

const storedEntries = async (fixture: RolloutFixture) =>
  await fixture.setup.db
    .select({
      id: rateEntries.id,
      effectiveTo: rateEntries.effectiveTo,
      hourlyRate: rateEntries.hourlyRate,
    })
    .from(rateEntries)
    .where(eq(rateEntries.rateTableId, fixture.rateTableId))
    .orderBy(rateEntries.effectiveFrom);

if (!databaseUrl || !runPostgres) {
  describe.skip("rate writers during a rollout (postgres)", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () =>
      expect(true).toBe(true));
  });
} else {
  // timeout: Two real PostgreSQL sessions race a rate window through a lock barrier.
  test("a date change waits for a previous build's entry create and refuses the overlap", async () => {
    await withRolloutFixture(async (fixture) => {
      type EntryContext = Parameters<typeof updateRateEntry.handler>[0];
      const outcome = await raceLegacyCreate(
        fixture,
        async () =>
          await updateRateEntry.handler(
            withTimeBillingEnrolment(
              createTestHandlerContext<EntryContext>({
                ...writerContextFields(fixture),
                params: { rateTableId: fixture.rateTableId },
                body: {
                  id: fixture.januaryEntryId,
                  currency: "USD",
                  effectiveTo: "2026-02-15",
                },
              }),
            ),
          ),
      );
      expect(outcome).toMatchObject({
        code: 400,
        response: {
          message:
            "Date range overlaps with an existing entry for this person, role, or table default",
        },
      });
      expect(await storedEntries(fixture)).toEqual([
        {
          id: fixture.januaryEntryId,
          effectiveTo: "2026-01-31",
          hourlyRate: cents(10_000),
        },
        {
          id: fixture.februaryEntryId,
          effectiveTo: "2026-02-28",
          hourlyRate: cents(12_000),
        },
      ]);
    });
  }, 30_000);

  // timeout: Two real PostgreSQL sessions race a currency change through a lock barrier.
  test("a currency change waits for a previous build's entry create and converts it too", async () => {
    await withRolloutFixture(async (fixture) => {
      type TableContext = Parameters<typeof updateRateTable.handler>[0];
      const outcome = await raceLegacyCreate(
        fixture,
        async () =>
          await updateRateTable.handler(
            withTimeBillingEnrolment(
              createTestHandlerContext<TableContext>({
                ...writerContextFields(fixture),
                body: { id: fixture.rateTableId, currency: "JPY" },
              }),
            ),
          ),
      );
      expect(outcome).toEqual({ id: fixture.rateTableId });
      // USD cents to whole yen: both lines move by the same exponent.
      expect(await storedEntries(fixture)).toEqual([
        {
          id: fixture.januaryEntryId,
          effectiveTo: "2026-01-31",
          hourlyRate: cents(100),
        },
        {
          id: fixture.februaryEntryId,
          effectiveTo: "2026-02-28",
          hourlyRate: cents(120),
        },
      ]);
    });
  }, 30_000);
}
