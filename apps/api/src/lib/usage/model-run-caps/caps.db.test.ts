import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { MODEL_RUN_CAP_CODES } from "@stll/api-contract/model-run-caps";

import type { Transaction } from "@/api/db/root";
import { safeDbFromScoped } from "@/api/db/safe-db";
import { legalListVerificationRuns, modelRunBudgets } from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { startVerificationRun } from "@/api/lib/lists/verification/start-run";
import {
  checkModelRunCaps,
  ModelRunCapError,
  startModelRun,
} from "@/api/lib/usage/model-run-caps/caps";
import { DEFAULT_RUN_CAPS } from "@/api/lib/usage/model-run-caps/config";
import type {
  ModelRunCaps,
  ModelRunKind,
} from "@/api/lib/usage/model-run-caps/config";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { addEntityFeatureFixtureColumns } from "@/api/tests/helpers/entity-feature-fixture-columns";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const CAPS_MIGRATION = "20261005120400_list_verification_run_caps";
const OWNER_MIGRATION = "20261112203235_model_run_caps_owner";

/** Every migration that shaped the counter and its triggers, in order. */
const MIGRATIONS = [
  "20260925220000_legal_list_verifications",
  "20261005120300_list_verification_access_revoked",
  CAPS_MIGRATION,
  "20261109190000_list_fact_extraction_runs",
  "20261112080005_legal_list_verification_run_scope",
  OWNER_MIGRATION,
  "20261114103200_legal_list_verification_run_unread_parts",
] as const;

type Scope = {
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
};

type CreateFixtureArgs = {
  db: GatedTestDb;
  connect: () => GatedTestDb;
  schema: string;
};

const createFixture = async ({ db, connect, schema }: CreateFixtureArgs) => {
  const organizationId = toSafeId<"organization">(
    `model_runs_${Bun.randomUUIDv7()}`,
  );
  const otherOrganizationId = toSafeId<"organization">(
    `model_runs_${Bun.randomUUIDv7()}`,
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
  const review = (workspace = workspaceId, organization = organizationId) => ({
    id: createSafeId<"documentReviewRun">(),
    organizationId: organization,
    workspaceId: workspace,
  });
  const scoped = (scope: Scope) => {
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
      toSafeId<"user">("model_run_user"),
    );
  };
  /** A list verification, through its production start. */
  const start = async (candidate: ReturnType<typeof run>, caps: ModelRunCaps) =>
    await startVerificationRun({
      safeDb: safeDbFromScoped(scoped(candidate)),
      run: candidate,
      caps,
      recordAuditEvent: async () => {
        await Promise.resolve();
      },
    });
  /** A document review a person starts, or a table run when uncapped. */
  const startReview = async (
    candidate: ReturnType<typeof review>,
    caps: ModelRunCaps,
    orgCapped = true,
  ) =>
    await startModelRun({
      safeDb: safeDbFromScoped(scoped(candidate)),
      kind: "document-review",
      operation: "document-reviews.runs.create",
      caps,
      start: async (tx) => {
        await tx.execute(sql`INSERT INTO document_review_runs
          (id, organization_id, workspace_id, status, org_capped)
          VALUES (${candidate.id}, ${candidate.organizationId}, ${candidate.workspaceId}, 'queued', ${orgCapped})`);
        return true;
      },
    });
  /** Start one run of either kind; both answer a typed refusal. */
  const startKind = async (kind: ModelRunKind, caps: ModelRunCaps) => {
    switch (kind) {
      case "list-run": {
        const candidate = run();
        return { id: candidate.id, outcome: await start(candidate, caps) };
      }
      case "document-review": {
        const candidate = review();
        return {
          id: candidate.id,
          outcome: await startReview(candidate, caps),
        };
      }
      default: {
        kind satisfies never;
        return panic(`Unhandled run kind: ${String(kind)}`);
      }
    }
  };
  /** End one run of either kind as the scheduler does, freeing its slot. */
  const finishKind = async (kind: ModelRunKind, id: string) => {
    await (kind === "list-run"
      ? db.execute(
          sql`UPDATE legal_list_verification_runs SET status = 'failed', error_code = 'internal' WHERE id = ${id}`,
        )
      : db.execute(
          sql`UPDATE document_review_runs SET status = 'completed' WHERE id = ${id}`,
        ));
  };
  const budget = async (
    kind: ModelRunKind = "list-run",
    organization = organizationId,
  ) =>
    (
      await db
        .select()
        .from(modelRunBudgets)
        .where(
          and(
            eq(modelRunBudgets.organizationId, organization),
            eq(modelRunBudgets.runKind, kind),
          ),
        )
    ).at(0);
  const setBudget = async (
    kind: ModelRunKind,
    values: Partial<typeof modelRunBudgets.$inferInsert>,
  ) =>
    await db
      .update(modelRunBudgets)
      .set(values)
      .where(
        and(
          eq(modelRunBudgets.organizationId, organizationId),
          eq(modelRunBudgets.runKind, kind),
        ),
      );
  return {
    db,
    schema,
    organizationId,
    otherOrganizationId,
    workspaceId,
    secondWorkspaceId,
    otherWorkspaceId,
    run,
    review,
    scoped,
    start,
    startReview,
    startKind,
    finishKind,
    budget,
    setBudget,
  };
};

type Fixture = Awaited<ReturnType<typeof createFixture>>;

type WithFixtureOptions = {
  /** Runs against the schema as it stands just before `migration`. */
  before?: {
    migration: (typeof MIGRATIONS)[number];
    run: (db: GatedTestDb) => Promise<void>;
  };
  /** Runs right after the counter's owner migration applied. */
  afterOwnerMigration?: (db: GatedTestDb) => Promise<void>;
};

const withFixture = async (
  fn: (fixture: Fixture) => Promise<void>,
  { before, afterOwnerMigration }: WithFixtureOptions = {},
) => {
  if (databaseUrl === undefined) {
    panic("DATABASE_URL required");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const { db, sql: client } = openClient();
    const schema = `model_run_caps_${Bun.randomUUIDv7().replaceAll("-", "")}`;
    await client.unsafe(`CREATE SCHEMA ${schema}`);
    try {
      await client.unsafe(`SET search_path TO ${schema}`);
      await client.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO stella`);
      // The run tables the counter's triggers attach to, reduced to the
      // columns the triggers read; the list verification tables come from
      // their own migrations.
      await client.unsafe(`
        CREATE TABLE organization (id varchar(128) PRIMARY KEY);
        CREATE TABLE "user" (id text PRIMARY KEY);
        CREATE TABLE workspaces (id uuid PRIMARY KEY, organization_id varchar(128), UNIQUE(id, organization_id));
        CREATE TABLE legal_list_items (entity_id uuid, list_id uuid, workspace_id uuid, UNIQUE(entity_id, list_id, workspace_id));
        CREATE VIEW stella_authorized_workspaces AS SELECT NULL::uuid AS authorized_workspace_id WHERE false;
        GRANT SELECT ON stella_authorized_workspaces TO stella;
        CREATE TABLE legal_list_generation_runs (
          id uuid PRIMARY KEY, organization_id varchar(128) NOT NULL,
          status text NOT NULL, producer text NOT NULL);
        CREATE TABLE document_review_runs (
          id uuid PRIMARY KEY, organization_id varchar(128) NOT NULL,
          workspace_id uuid NOT NULL, status text NOT NULL);
        GRANT SELECT, INSERT, UPDATE, DELETE ON legal_list_generation_runs, document_review_runs TO stella;
      `);
      for (const migration of MIGRATIONS) {
        if (before?.migration === migration) {
          await before.run(db);
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
        if (migration === OWNER_MIGRATION) {
          await afterOwnerMigration?.(db);
        }
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

const expectRefusal = (
  outcome: Result<unknown, unknown>,
  kind: ModelRunKind,
  reason: keyof typeof MODEL_RUN_CAP_CODES,
) => {
  if (Result.isOk(outcome)) {
    panic(`Expected a ${reason} refusal for ${kind}`);
  }
  expect(outcome.error).toBeInstanceOf(ModelRunCapError);
  expect(outcome.error).toMatchObject({
    kind,
    reason,
    code: MODEL_RUN_CAP_CODES[reason],
  });
};

const expectAdmitted = (outcome: Result<boolean, unknown>) => {
  expect(outcome).toEqual(Result.ok(true));
};

const SEEDED_ORG = "seeded_org";
const SEEDED_WORKSPACE = "00000000-0000-0000-0000-000000000001";

const seedVerificationRuns = async (
  db: GatedTestDb,
  runs: readonly (readonly [status: string, createdAt: string])[],
) => {
  for (const [status, createdAt] of runs) {
    await db.execute(sql`INSERT INTO legal_list_verification_runs
      (id, organization_id, workspace_id, entity_id, file_field_id,
       entity_version_id, content_sha256, evidence, status, error_code, created_at)
      VALUES (gen_random_uuid(), ${SEEDED_ORG}, ${SEEDED_WORKSPACE},
        gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), repeat('a', 64),
        '{"facts": [], "listId": "seeded_list"}'::jsonb, ${status},
        ${status === "failed" ? "internal" : null}, ${createdAt}::timestamptz)`);
  }
};

const seedOrganization = async (db: GatedTestDb) => {
  await db.execute(sql`INSERT INTO organization VALUES (${SEEDED_ORG})`);
  await db.execute(
    sql`INSERT INTO workspaces VALUES (${SEEDED_WORKSPACE}, ${SEEDED_ORG})`,
  );
};

describe.skipIf(!enabled)("organization model run caps (postgres)", () => {
  test("the owner migration keeps every list counter, and runs in flight free the slots they took", async () => {
    let before: Record<string, unknown>[] = [];
    await withFixture(
      async (fixture) => {
        const seeded = toSafeId<"organization">(SEEDED_ORG);
        const migrated: unknown = await fixture.budget("list-run", seeded);
        expect(migrated).toEqual({ ...before.at(0), runKind: "list-run" });
        expect(await fixture.budget("document-review", seeded)).toBeUndefined();
        // Ending the two runs that were active across the migration frees
        // exactly their two slots and no start.
        await fixture.db.execute(sql`UPDATE legal_list_verification_runs
          SET status = 'failed', error_code = 'internal'
          WHERE organization_id = ${SEEDED_ORG} AND status = 'queued'`);
        await fixture.db.execute(sql`UPDATE legal_list_generation_runs
          SET status = 'completed' WHERE organization_id = ${SEEDED_ORG}`);
        expect(await fixture.budget("list-run", seeded)).toMatchObject({
          activeRuns: 0,
          startsToday: before[0]?.["startsToday"],
        });
      },
      {
        before: {
          migration: OWNER_MIGRATION,
          run: async (db) => {
            await seedOrganization(db);
            await seedVerificationRuns(db, [
              ["completed", "2026-01-02T08:00:00Z"],
              ["queued", "2026-01-02T09:00:00Z"],
            ]);
            await db.execute(sql`INSERT INTO legal_list_generation_runs
              VALUES (gen_random_uuid(), ${SEEDED_ORG}, 'queued', 'stella'),
                     (gen_random_uuid(), ${SEEDED_ORG}, 'queued', 'external')`);
            // Limits an operator lowered must survive too.
            await db.execute(sql`UPDATE legal_list_verification_budgets
              SET active_limit = 3, daily_limit = 7
              WHERE organization_id = ${SEEDED_ORG}`);
            before = await db.execute(sql`SELECT
              organization_id AS "organizationId", active_runs AS "activeRuns",
              starts_day::text AS "startsDay", starts_today AS "startsToday",
              active_limit AS "activeLimit", daily_limit AS "dailyLimit"
              FROM legal_list_verification_budgets`);
            // The fixture's premise: one list counter holding a queued
            // verification and a queued fact extraction, and every start
            // stella produced (the external run is never counted).
            expect(before).toEqual([
              {
                organizationId: SEEDED_ORG,
                activeRuns: 2,
                startsDay: expect.any(String),
                startsToday: 3,
                activeLimit: 3,
                dailyLimit: 7,
              },
            ]);
          },
        },
        afterOwnerMigration: async (db) => {
          expect(
            await db.execute(
              sql`SELECT count(*)::integer AS rows FROM model_run_budgets`,
            ),
          ).toEqual([{ rows: before.length }]);
        },
      },
    );
  });

  test("counters derived at the caps migration count persisted run dates across Prague midnight", async () =>
    await withFixture(
      async (fixture) => {
        const seeded = toSafeId<"organization">(SEEDED_ORG);
        expect(await fixture.budget("list-run", seeded)).toMatchObject({
          activeRuns: 1,
          startsDay: "2026-01-02",
          startsToday: 2,
        });
        const nextStart = await fixture.start(
          fixture.run(toSafeId<"workspace">(SEEDED_WORKSPACE), seeded),
          { active: 2, startsPerDay: 1 },
        );
        expectAdmitted(nextStart);
        expect(await fixture.budget("list-run", seeded)).toMatchObject({
          activeRuns: 2,
          startsToday: 1,
        });
      },
      {
        before: {
          migration: CAPS_MIGRATION,
          run: async (db) => {
            await seedOrganization(db);
            await seedVerificationRuns(db, [
              ["completed", "2026-01-01T22:59:59Z"],
              ["completed", "2026-01-01T23:00:00Z"],
              ["queued", "2026-01-02T10:00:00Z"],
            ]);
          },
        },
      },
    ));

  for (const kind of ["list-run", "document-review"] as const) {
    test(`${kind}: a start under the active cap is admitted, one at it is refused, and an ended run frees its slot`, async () =>
      await withFixture(async (fixture) => {
        const caps = { active: 2, startsPerDay: 20 };
        const first = await fixture.startKind(kind, caps);
        expectAdmitted(first.outcome);
        expectAdmitted((await fixture.startKind(kind, caps)).outcome);
        expectRefusal(
          (await fixture.startKind(kind, caps)).outcome,
          kind,
          "active",
        );
        expect(await fixture.budget(kind)).toMatchObject({
          activeRuns: 2,
          startsToday: 2,
        });
        await fixture.finishKind(kind, first.id);
        expect(await fixture.budget(kind)).toMatchObject({
          activeRuns: 1,
          startsToday: 2,
        });
        expectAdmitted((await fixture.startKind(kind, caps)).outcome);
      }));

    test(`${kind}: the daily window refuses at the cap and rolls over at Prague midnight`, async () =>
      await withFixture(async (fixture) => {
        const caps = { active: 20, startsPerDay: 2 };
        expectAdmitted((await fixture.startKind(kind, caps)).outcome);
        expectAdmitted((await fixture.startKind(kind, caps)).outcome);
        expectRefusal(
          (await fixture.startKind(kind, caps)).outcome,
          kind,
          "daily",
        );
        // The same counter, a day later: the starts belong to yesterday.
        await fixture.setBudget(kind, { startsDay: "2000-01-01" });
        expectAdmitted((await fixture.startKind(kind, caps)).outcome);
        expect(await fixture.budget(kind)).toMatchObject({
          activeRuns: 3,
          startsToday: 1,
        });
      }));

    test(`${kind}: concurrent starts admit exactly the active cap and exactly the daily cap`, async () =>
      await withFixture(async (fixture) => {
        for (const [caps, reason] of [
          [{ active: 3, startsPerDay: 20 }, "active"],
          [{ active: 20, startsPerDay: 3 }, "daily"],
        ] as const) {
          await fixture.setBudget(kind, {
            activeRuns: 0,
            startsToday: 0,
          });
          const outcomes = await Promise.all(
            Array.from(
              { length: 10 },
              async () => (await fixture.startKind(kind, caps)).outcome,
            ),
          );
          expect(outcomes.filter(Result.isOk)).toHaveLength(3);
          for (const refusal of outcomes.filter(Result.isError)) {
            expectRefusal(refusal, kind, reason);
          }
          expect(await fixture.budget(kind)).toMatchObject({
            activeRuns: 3,
            startsToday: 3,
          });
        }
      }));
  }

  test("each kind keeps its own counter: a full list counter leaves document reviews open", async () =>
    await withFixture(async (fixture) => {
      const caps = { active: 1, startsPerDay: 1 };
      expectAdmitted((await fixture.startKind("list-run", caps)).outcome);
      expectRefusal(
        (await fixture.startKind("list-run", caps)).outcome,
        "list-run",
        "active",
      );
      expectAdmitted(
        (await fixture.startKind("document-review", caps)).outcome,
      );
      expect(await fixture.budget("list-run")).toMatchObject({
        activeRuns: 1,
        startsToday: 1,
      });
      expect(await fixture.budget("document-review")).toMatchObject({
        activeRuns: 1,
        startsToday: 1,
      });
      // Another organization starts with an empty counter.
      expectAdmitted(
        await fixture.start(
          fixture.run(fixture.otherWorkspaceId, fixture.otherOrganizationId),
          caps,
        ),
      );
    }));

  test("a document review admitted as a table batch is never counted", async () =>
    await withFixture(async (fixture) => {
      const caps = { active: 1, startsPerDay: 1 };
      for (let index = 0; index < 3; index += 1) {
        expectAdmitted(
          await fixture.startReview(fixture.review(), caps, false),
        );
      }
      expect(await fixture.budget("document-review")).toBeUndefined();
      const counted = fixture.review();
      expectAdmitted(await fixture.startReview(counted, caps));
      await fixture.db.execute(
        sql`UPDATE document_review_runs SET status = 'completed' WHERE org_capped = false`,
      );
      expect(await fixture.budget("document-review")).toMatchObject({
        activeRuns: 1,
        startsToday: 1,
      });
    }));

  test("failed and cancelled work frees active slots and preserves daily starts", async () =>
    await withFixture(async (fixture) => {
      const caps = { active: 1, startsPerDay: 2 };
      const first = fixture.run();
      expectAdmitted(await fixture.start(first, caps));
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
      expectAdmitted(await fixture.start(second, caps));
      await fixture.db
        .update(legalListVerificationRuns)
        .set({ status: "failed", errorCode: "internal" })
        .where(eq(legalListVerificationRuns.id, second.id));
      expectRefusal(
        await fixture.start(fixture.run(), caps),
        "list-run",
        "daily",
      );
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
      expectAdmitted(await fixture.start(first, caps));
      const duplicate = {
        ...first,
        id: createSafeId<"legalListVerificationRun">(),
      };
      expect(await fixture.start(duplicate, caps)).toEqual(Result.ok(false));
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
            sql`SELECT stella_model_run_day(${instant}::timestamptz)::text AS day`,
          ),
        ).toEqual([{ day }]);
      }
    }));

  test("dispatch honors persisted admission limits when current configuration is higher", async () =>
    await withFixture(async (fixture) => {
      const caps = { active: 2, startsPerDay: 20 };
      const first = fixture.run();
      expectAdmitted(await fixture.start(first, caps));
      expectAdmitted(await fixture.start(fixture.run(), caps));
      for (const { limits, reason } of [
        { limits: { activeLimit: 1, dailyLimit: 20 }, reason: "active" },
        { limits: { activeLimit: 2, dailyLimit: 1 }, reason: "daily" },
      ] as const) {
        await fixture.setBudget("list-run", limits);
        expectRefusal(
          await fixture.scoped(first)(
            async (tx) =>
              await checkModelRunCaps({
                tx,
                kind: "list-run",
                organizationId: fixture.organizationId,
                operation: "lists.verifications.create",
                phase: "dispatch",
                caps,
              }),
          ),
          "list-run",
          reason,
        );
      }
    }));

  test("daily rollover preserves active slots and workers reject lowered budgets", async () =>
    await withFixture(async (fixture) => {
      const first = fixture.run();
      expectAdmitted(
        await fixture.start(first, { active: 2, startsPerDay: 20 }),
      );
      const second = fixture.run(fixture.secondWorkspaceId);
      expectAdmitted(
        await fixture.start(second, { active: 2, startsPerDay: 20 }),
      );
      expectRefusal(
        await fixture.scoped(first)(
          async (tx) =>
            await checkModelRunCaps({
              tx,
              kind: "list-run",
              organizationId: fixture.organizationId,
              operation: "lists.verifications.create",
              phase: "dispatch",
              caps: { active: 1, startsPerDay: 20 },
            }),
        ),
        "list-run",
        "active",
      );
      await fixture.setBudget("list-run", {
        startsDay: "2000-01-01",
        startsToday: 20,
      });
      expectRefusal(
        await fixture.start(fixture.run(), { active: 2, startsPerDay: 1 }),
        "list-run",
        "active",
      );
      await fixture.db
        .update(legalListVerificationRuns)
        .set({ status: "failed", errorCode: "internal" })
        .where(eq(legalListVerificationRuns.id, second.id));
      expectAdmitted(
        await fixture.start(fixture.run(), { active: 2, startsPerDay: 1 }),
      );
      expect(await fixture.budget()).toMatchObject({
        activeRuns: 2,
        startsToday: 1,
      });
    }));

  test("scheduler terminal writes maintain a forced counter as a non-bypass owner", async () =>
    await withFixture(async (fixture) => {
      const run = fixture.run();
      expectAdmitted(await fixture.start(run, { active: 2, startsPerDay: 20 }));
      const owner = `model_run_owner_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      await fixture.db.execute(
        sql.raw(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS`),
      );
      try {
        await fixture.db.execute(
          sql.raw(
            `GRANT ${owner} TO CURRENT_USER WITH INHERIT TRUE, SET TRUE; GRANT USAGE, CREATE ON SCHEMA ${fixture.schema} TO ${owner}`,
          ),
        );
        await fixture.db.execute(
          sql.raw(`ALTER TABLE model_run_budgets OWNER TO ${owner}`),
        );
        await fixture.db.execute(
          sql.raw(`ALTER TABLE legal_list_verification_runs OWNER TO ${owner}`),
        );
        await fixture.db.transaction(async (tx) => {
          await tx.execute(sql.raw(`SET LOCAL ROLE ${owner}`));
          await tx
            .update(legalListVerificationRuns)
            .set({ status: "failed", errorCode: "internal" })
            .where(eq(legalListVerificationRuns.id, run.id));
          expect(await tx.select().from(modelRunBudgets)).toMatchObject([
            { runKind: "list-run", activeRuns: 0, startsToday: 1 },
          ]);
        });
      } finally {
        const role = (
          await fixture.db.execute(sql`SELECT current_user AS name`)
        ).at(0);
        if (typeof role?.["name"] !== "string") {
          panic("Fixture owner required");
        }
        const current = `"${role["name"].replaceAll('"', '""')}"`;
        // Restore ownership before dropping the disposable maintenance role.
        await fixture.db.execute(
          sql.raw(`ALTER TABLE model_run_budgets OWNER TO ${current}`),
        );
        await fixture.db.execute(
          sql.raw(
            `ALTER TABLE legal_list_verification_runs OWNER TO ${current}`,
          ),
        );
        await fixture.db.execute(
          sql.raw(
            `REVOKE USAGE, CREATE ON SCHEMA ${fixture.schema} FROM ${owner}`,
          ),
        );
        await fixture.db.execute(sql.raw(`DROP ROLE ${owner}`));
      }
    }));

  test("the counter's SQL defaults match the typed configuration and deny unscoped reads", async () =>
    await withFixture(async (fixture) => {
      await fixture.db.execute(
        sql`INSERT INTO model_run_budgets (organization_id, run_kind) VALUES (${fixture.organizationId}, 'document-review')`,
      );
      expect(await fixture.budget("document-review")).toMatchObject({
        activeLimit: DEFAULT_RUN_CAPS.active,
        dailyLimit: DEFAULT_RUN_CAPS.startsPerDay,
      });
      for (const organization of ["", fixture.otherOrganizationId]) {
        await fixture.db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('role', 'stella', true), set_config('app.organization_id', ${organization}, true)`,
          );
          expect(await tx.select().from(modelRunBudgets)).toHaveLength(0);
        });
      }
    }));
});
