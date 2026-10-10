import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { safeDbFromScoped } from "@/api/db/safe-db";
import {
  legalListVerificationBudgets,
  legalListVerificationRuns,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { DEFAULT_VERIFICATION_RUN_CAPS } from "@/api/lib/lists/verification/run-cap-config";
import type { VerificationRunCaps } from "@/api/lib/lists/verification/run-cap-config";
import {
  checkVerificationDispatchBudget,
  ListVerificationRunCapError,
} from "@/api/lib/lists/verification/run-caps";
import { startVerificationRun } from "@/api/lib/lists/verification/start-run";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { addEntityFeatureFixtureColumns } from "@/api/tests/helpers/entity-feature-fixture-columns";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

type CreateFixtureArgs = {
  db: GatedTestDb;
  connect: () => GatedTestDb;
  schema: string;
};

const createFixture = async ({ db, connect, schema }: CreateFixtureArgs) => {
  const organizationId = toSafeId<"organization">(
    `verification_${Bun.randomUUIDv7()}`,
  );
  const otherOrganizationId = toSafeId<"organization">(
    `verification_${Bun.randomUUIDv7()}`,
  );
  const workspaceId = createSafeId<"workspace">();
  const secondWorkspaceId = createSafeId<"workspace">();
  const otherWorkspaceId = createSafeId<"workspace">();
  await db.execute(
    sql`INSERT INTO organization VALUES (${organizationId}), (${otherOrganizationId})`,
  );
  await db.execute(sql`INSERT INTO workspaces VALUES
    (${workspaceId}, ${organizationId}), (${secondWorkspaceId}, ${organizationId}),
    (${otherWorkspaceId}, ${otherOrganizationId})`);

  const run = (workspace = workspaceId, organization = organizationId) => ({
    id: createSafeId<"legalListVerificationRun">(),
    organizationId: organization,
    workspaceId: workspace,
    entityId: createSafeId<"entity">(),
    fileFieldId: createSafeId<"field">(),
    entityVersionId: createSafeId<"entityVersion">(),
    contentSha256: "a".repeat(64),
    evidence: { listId: createSafeId<"legalList">(), facts: [] },
    requestedBy: null,
  });
  const scoped = (scope: ReturnType<typeof run>) => {
    const connection = connect();
    const database = markRlsDatabase({
      transaction: async <T>(fn: (tx: Transaction) => Promise<T>) =>
        await connection.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('search_path', ${schema}, true)`,
          );
          return await fn(tx);
        }),
    });
    return createScopedDb(
      database,
      [scope.workspaceId],
      scope.organizationId,
      toSafeId<"user">("verification_user"),
    );
  };
  const start = async (
    candidate: ReturnType<typeof run>,
    caps: VerificationRunCaps,
  ) =>
    await startVerificationRun({
      safeDb: safeDbFromScoped(scoped(candidate)),
      run: candidate,
      caps,
      recordAuditEvent: async () => {
        await Promise.resolve();
      },
    });
  const budget = async () =>
    (
      await db
        .select()
        .from(legalListVerificationBudgets)
        .where(eq(legalListVerificationBudgets.organizationId, organizationId))
    ).at(0);
  return {
    db,
    schema,
    organizationId,
    otherOrganizationId,
    workspaceId,
    secondWorkspaceId,
    otherWorkspaceId,
    run,
    scoped,
    start,
    budget,
  };
};

type WithFixtureOptions = {
  beforeCapsMigration?: (db: GatedTestDb) => Promise<void>;
};

const withFixture = async (
  fn: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
  { beforeCapsMigration }: WithFixtureOptions = {},
) => {
  if (databaseUrl === undefined) {
    panic("DATABASE_URL required");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const { db, sql: client } = openClient();
    const schema = `verification_caps_${Bun.randomUUIDv7().replaceAll("-", "")}`;
    await client.unsafe(`CREATE SCHEMA ${schema}`);
    try {
      await client.unsafe(`SET search_path TO ${schema}`);
      await client.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO stella`);
      await client.unsafe(`
        CREATE TABLE organization (id varchar(128) PRIMARY KEY);
        CREATE TABLE "user" (id text PRIMARY KEY);
        CREATE TABLE workspaces (id uuid PRIMARY KEY, organization_id varchar(128), UNIQUE(id, organization_id));
        CREATE TABLE legal_list_items (entity_id uuid, list_id uuid, workspace_id uuid, UNIQUE(entity_id, list_id, workspace_id));
        CREATE VIEW stella_authorized_workspaces AS SELECT NULL::uuid AS authorized_workspace_id WHERE false;
        GRANT SELECT ON stella_authorized_workspaces TO stella;
      `);
      for (const migration of [
        "20260925220000_legal_list_verifications",
        "20261005120300_list_verification_access_revoked",
        "20261005120400_list_verification_run_caps",
      ]) {
        if (migration === "20261005120400_list_verification_run_caps") {
          await beforeCapsMigration?.(db);
        }
        const source = await Bun.file(
          new URL(
            `../../../../drizzle/${migration}/migration.sql`,
            import.meta.url,
          ),
        ).text();
        await db.transaction(async (tx) => {
          for (const statement of source
            .replaceAll("public.", () => `${schema}.`)
            .replaceAll("pg_catalog, public", () => `pg_catalog, ${schema}`)
            .split("--> statement-breakpoint")) {
            await tx.execute(sql.raw(statement));
          }
        });
      }
      await addEntityFeatureFixtureColumns(db, [legalListVerificationRuns]);
      await fn(
        await createFixture({ db, schema, connect: () => openClient().db }),
      );
    } finally {
      await client.unsafe("RESET search_path");
      await client.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    }
  });
};

describe.skipIf(!enabled)(
  "organization verification run caps (postgres)",
  () => {
    test("migration counters derive from persisted run dates across Prague midnight", async () =>
      await withFixture(
        async (fixture) => {
          const seeded = (
            await fixture.db
              .select()
              .from(legalListVerificationBudgets)
              .where(
                eq(
                  legalListVerificationBudgets.organizationId,
                  toSafeId<"organization">("seeded_org"),
                ),
              )
          ).at(0);
          expect(seeded).toMatchObject({
            activeRuns: 1,
            startsDay: "2026-01-02",
            startsToday: 2,
          });
          const nextStart = await fixture.start(
            fixture.run(
              toSafeId<"workspace">("00000000-0000-0000-0000-000000000001"),
              toSafeId<"organization">("seeded_org"),
            ),
            { active: 2, startsPerDay: 1 },
          );
          expect(Result.isOk(nextStart)).toBe(true);
          expect(
            (
              await fixture.db
                .select()
                .from(legalListVerificationBudgets)
                .where(
                  eq(
                    legalListVerificationBudgets.organizationId,
                    toSafeId<"organization">("seeded_org"),
                  ),
                )
            ).at(0),
          ).toMatchObject({ activeRuns: 2, startsToday: 1 });
        },
        {
          beforeCapsMigration: async (db) => {
            await db.execute(
              sql`INSERT INTO organization VALUES ('seeded_org')`,
            );
            await db.execute(
              sql`INSERT INTO workspaces VALUES ('00000000-0000-0000-0000-000000000001', 'seeded_org')`,
            );
            await db.execute(sql`INSERT INTO legal_list_verification_runs
              (id, organization_id, workspace_id, entity_id, file_field_id,
               entity_version_id, content_sha256, evidence, status, created_at)
              SELECT gen_random_uuid(), 'seeded_org', '00000000-0000-0000-0000-000000000001',
                gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), repeat('a', 64),
                '{"facts": [], "listId": "seeded_list"}'::jsonb, status, created_at
              FROM (VALUES
                ('completed', '2026-01-01T22:59:59Z'::timestamptz),
                ('completed', '2026-01-01T23:00:00Z'::timestamptz),
                ('queued', '2026-01-02T10:00:00Z'::timestamptz)
              ) AS persisted_runs(status, created_at)`);
          },
        },
      ));

    test("concurrent starts across matters admit exactly the active cap per organization", async () =>
      await withFixture(async (fixture) => {
        const caps = { active: 2, startsPerDay: 20 };
        const candidates = Array.from({ length: 10 }, (_, index) =>
          fixture.run(
            index % 2 === 0 ? fixture.workspaceId : fixture.secondWorkspaceId,
          ),
        );
        const outcomes = await Promise.all(
          candidates.map(async (run) => await fixture.start(run, caps)),
        );
        expect(
          outcomes.filter((outcome) => Result.isOk(outcome) && outcome.value),
        ).toHaveLength(caps.active);
        const refusals = outcomes.filter(Result.isError);
        expect(refusals).toHaveLength(candidates.length - caps.active);
        for (const refusal of refusals) {
          expect(refusal.error).toBeInstanceOf(ListVerificationRunCapError);
          expect(refusal.error).toMatchObject({ reason: "active" });
        }
        expect(await fixture.budget()).toMatchObject({
          activeRuns: 2,
          startsToday: 2,
        });
        const other = fixture.run(
          fixture.otherWorkspaceId,
          fixture.otherOrganizationId,
        );
        const admittedOther = await fixture.start(other, caps);
        expect(Result.isOk(admittedOther)).toBe(true);
        if (Result.isOk(admittedOther)) {
          expect(admittedOther.value).toBe(true);
        }
      }));

    test("concurrent starts also admit exactly the daily cap", async () =>
      await withFixture(async (fixture) => {
        const caps = { active: 20, startsPerDay: 3 };
        const outcomes = await Promise.all(
          Array.from(
            { length: 10 },
            async () => await fixture.start(fixture.run(), caps),
          ),
        );
        expect(
          outcomes.filter((outcome) => Result.isOk(outcome) && outcome.value),
        ).toHaveLength(3);
        for (const refusal of outcomes.filter(Result.isError)) {
          expect(refusal.error).toMatchObject({ reason: "daily" });
        }
        expect(await fixture.budget()).toMatchObject({
          activeRuns: 3,
          startsToday: 3,
        });
      }));

    test("failed and cancelled work frees active slots and preserves daily starts", async () =>
      await withFixture(async (fixture) => {
        const caps = { active: 1, startsPerDay: 2 };
        const first = fixture.run();
        expect(Result.isOk(await fixture.start(first, caps))).toBe(true);
        // Cancelled queued work uses the existing failed/enqueue_failed terminal state.
        await fixture.db
          .update(legalListVerificationRuns)
          .set({ status: "failed", errorCode: "enqueue_failed" })
          .where(eq(legalListVerificationRuns.id, first.id));
        expect(await fixture.budget()).toMatchObject({
          activeRuns: 0,
          startsToday: 1,
        });
        const second = fixture.run(fixture.secondWorkspaceId);
        expect(Result.isOk(await fixture.start(second, caps))).toBe(true);
        await fixture.db
          .update(legalListVerificationRuns)
          .set({ status: "failed", errorCode: "internal" })
          .where(eq(legalListVerificationRuns.id, second.id));
        const refused = await fixture.start(fixture.run(), caps);
        expect(Result.isError(refused)).toBe(true);
        if (Result.isError(refused)) {
          expect(refused.error).toMatchObject({ reason: "daily" });
        }
        expect(await fixture.budget()).toMatchObject({
          activeRuns: 0,
          startsToday: 2,
        });
        await fixture.db
          .delete(legalListVerificationRuns)
          .where(eq(legalListVerificationRuns.id, first.id));
        expect(await fixture.budget()).toMatchObject({
          activeRuns: 0,
          startsToday: 2,
        });
      }));

    test("a duplicate document and an aborted audit do not spend a start", async () =>
      await withFixture(async (fixture) => {
        const caps = { active: 2, startsPerDay: 20 };
        const first = fixture.run();
        expect(Result.isOk(await fixture.start(first, caps))).toBe(true);
        const duplicate = {
          ...first,
          id: createSafeId<"legalListVerificationRun">(),
        };
        const duplicateResult = await fixture.start(duplicate, caps);
        expect(Result.isOk(duplicateResult)).toBe(true);
        if (Result.isOk(duplicateResult)) {
          expect(duplicateResult.value).toBe(false);
        }
        const run = fixture.run();
        const aborted = await startVerificationRun({
          run,
          caps,
          safeDb: safeDbFromScoped(fixture.scoped(run)),
          recordAuditEvent: async () => {
            throw new TypeError("audit fixture refused");
          },
        });
        expect(Result.isError(aborted)).toBe(true);
        expect(await fixture.budget()).toMatchObject({
          activeRuns: 1,
          startsToday: 1,
        });
        expect(
          await fixture.db.select().from(legalListVerificationRuns),
        ).toHaveLength(1);
      }));

    test("the database day boundary follows Prague winter, summer and DST offsets", async () =>
      await withFixture(async ({ db }) => {
        for (const [instant, day] of [
          ["2026-01-01T22:59:59Z", "2026-01-01"],
          ["2026-01-01T23:00:00Z", "2026-01-02"],
          ["2026-07-01T21:59:59Z", "2026-07-01"],
          ["2026-07-01T22:00:00Z", "2026-07-02"],
          ["2026-03-28T23:00:00Z", "2026-03-29"],
          ["2026-03-29T22:00:00Z", "2026-03-30"],
          ["2026-10-24T22:00:00Z", "2026-10-25"],
          ["2026-10-25T23:00:00Z", "2026-10-26"],
        ]) {
          expect(
            await db.execute(
              sql`SELECT stella_list_verification_day(${instant}::timestamptz)::text AS day`,
            ),
          ).toEqual([{ day }]);
        }
      }));

    test("dispatch honors persisted admission limits when current configuration is higher", async () =>
      await withFixture(async (fixture) => {
        const caps = { active: 2, startsPerDay: 20 };
        const first = fixture.run();
        expect(Result.isOk(await fixture.start(first, caps))).toBe(true);
        expect(Result.isOk(await fixture.start(fixture.run(), caps))).toBe(
          true,
        );
        for (const { limits, reason } of [
          { limits: { activeLimit: 1, dailyLimit: 20 }, reason: "active" },
          { limits: { activeLimit: 2, dailyLimit: 1 }, reason: "daily" },
        ]) {
          await fixture.db
            .update(legalListVerificationBudgets)
            .set(limits)
            .where(
              eq(
                legalListVerificationBudgets.organizationId,
                fixture.organizationId,
              ),
            );
          const refused = await fixture.scoped(first)(
            async (tx) =>
              await checkVerificationDispatchBudget({
                tx,
                organizationId: fixture.organizationId,
                caps,
              }),
          );
          expect(Result.isError(refused)).toBe(true);
          if (Result.isError(refused)) {
            expect(refused.error).toMatchObject({ reason });
          }
        }
      }));

    test("daily rollover preserves active slots and workers reject lowered budgets", async () =>
      await withFixture(async (fixture) => {
        const first = fixture.run();
        expect(
          Result.isOk(
            await fixture.start(first, { active: 2, startsPerDay: 20 }),
          ),
        ).toBe(true);
        const second = fixture.run(fixture.secondWorkspaceId);
        expect(
          Result.isOk(
            await fixture.start(second, { active: 2, startsPerDay: 20 }),
          ),
        ).toBe(true);
        const lowered = await fixture.scoped(first)(
          async (tx) =>
            await checkVerificationDispatchBudget({
              tx,
              organizationId: fixture.organizationId,
              caps: { active: 1, startsPerDay: 20 },
            }),
        );
        expect(Result.isError(lowered)).toBe(true);
        await fixture.db
          .update(legalListVerificationBudgets)
          .set({ startsDay: "2000-01-01", startsToday: 20 })
          .where(
            eq(
              legalListVerificationBudgets.organizationId,
              fixture.organizationId,
            ),
          );
        const activeRefusal = await fixture.start(fixture.run(), {
          active: 2,
          startsPerDay: 1,
        });
        expect(Result.isError(activeRefusal)).toBe(true);
        await fixture.db
          .update(legalListVerificationRuns)
          .set({ status: "failed", errorCode: "internal" })
          .where(eq(legalListVerificationRuns.id, second.id));
        expect(
          Result.isOk(
            await fixture.start(fixture.run(), { active: 2, startsPerDay: 1 }),
          ),
        ).toBe(true);
        expect(await fixture.budget()).toMatchObject({
          activeRuns: 2,
          startsToday: 1,
        });
      }));

    test("scheduler terminal writes maintain a forced counter as a non-bypass owner", async () =>
      await withFixture(async (fixture) => {
        const run = fixture.run();
        expect(
          Result.isOk(
            await fixture.start(run, { active: 2, startsPerDay: 20 }),
          ),
        ).toBe(true);
        const owner = `verification_owner_${Bun.randomUUIDv7().replaceAll("-", "")}`;
        await fixture.db.execute(
          sql.raw(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS`),
        );
        try {
          await fixture.db.execute(
            sql.raw(`GRANT USAGE ON SCHEMA ${fixture.schema} TO ${owner}`),
          );
          await fixture.db.execute(
            sql.raw(
              `ALTER TABLE legal_list_verification_budgets OWNER TO ${owner}`,
            ),
          );
          await fixture.db.execute(
            sql.raw(
              `ALTER TABLE legal_list_verification_runs OWNER TO ${owner}`,
            ),
          );
          await fixture.db.transaction(async (tx) => {
            await tx.execute(sql.raw(`SET LOCAL ROLE ${owner}`));
            await tx
              .update(legalListVerificationRuns)
              .set({ status: "failed", errorCode: "internal" })
              .where(eq(legalListVerificationRuns.id, run.id));
            expect(
              await tx.select().from(legalListVerificationBudgets),
            ).toMatchObject([{ activeRuns: 0, startsToday: 1 }]);
          });
        } finally {
          const role = (
            await fixture.db.execute(sql`SELECT current_user AS name`)
          ).at(0);
          if (typeof role?.["name"] !== "string") {
            panic("Fixture owner required");
          }
          // Restore ownership before dropping the disposable maintenance role.
          await fixture.db.execute(
            sql.raw(
              `ALTER TABLE legal_list_verification_budgets OWNER TO "${role["name"].replaceAll('"', '""')}"`,
            ),
          );
          await fixture.db.execute(
            sql.raw(
              `ALTER TABLE legal_list_verification_runs OWNER TO "${role["name"].replaceAll('"', '""')}"`,
            ),
          );
          await fixture.db.execute(
            sql.raw(`REVOKE USAGE ON SCHEMA ${fixture.schema} FROM ${owner}`),
          );
          await fixture.db.execute(sql.raw(`DROP ROLE ${owner}`));
        }
      }));

    test("the counter's SQL defaults match the typed configuration and deny unscoped reads", async () =>
      await withFixture(async (fixture) => {
        await fixture.db.execute(
          sql`INSERT INTO legal_list_verification_budgets (organization_id) VALUES (${fixture.organizationId})`,
        );
        expect(await fixture.budget()).toMatchObject({
          activeLimit: DEFAULT_VERIFICATION_RUN_CAPS.active,
          dailyLimit: DEFAULT_VERIFICATION_RUN_CAPS.startsPerDay,
        });
        await fixture.db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('role', 'stella', true), set_config('app.organization_id', '', true)`,
          );
          expect(
            await tx.select().from(legalListVerificationBudgets),
          ).toHaveLength(0);
        });
        await fixture.db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('role', 'stella', true), set_config('app.organization_id', ${fixture.otherOrganizationId}, true)`,
          );
          expect(
            await tx.select().from(legalListVerificationBudgets),
          ).toHaveLength(0);
        });
      }));
  },
);
