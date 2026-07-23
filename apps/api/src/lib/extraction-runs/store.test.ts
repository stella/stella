import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import { extractionRuns, workspaces } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { createExtractionRunStore, type ExtractionRunDb } from "./store";

let testDb: TestDatabase;
let store: ReturnType<typeof createExtractionRunStore>;

const organizationId = createSafeId<"organization">();
const otherOrganizationId = createSafeId<"organization">();
const workspaceId = createSafeId<"workspace">();
const otherWorkspaceId = createSafeId<"workspace">();
const userId = createSafeId<"user">();

beforeAll(async () => {
  testDb = await getTestDb();
  store = createExtractionRunStore(asTestRaw<ExtractionRunDb>(testDb));

  await testDb.insert(organization).values([
    {
      id: organizationId,
      name: "Extraction run org",
      slug: `extraction-runs-${organizationId}`,
      createdAt: new Date(),
    },
    {
      id: otherOrganizationId,
      name: "Other extraction run org",
      slug: `extraction-runs-${otherOrganizationId}`,
      createdAt: new Date(),
    },
  ]);
  await testDb.insert(user).values({
    id: userId,
    name: "Extraction run user",
    email: `${userId}@test.local`,
  });
  await testDb.insert(workspaces).values([
    {
      id: workspaceId,
      organizationId,
      name: "Extraction matter",
      reference: "EXTRACT",
    },
    {
      id: otherWorkspaceId,
      organizationId: otherOrganizationId,
      name: "Other extraction matter",
      reference: "OTHER",
    },
  ]);
});

afterAll(async () => {
  await releaseTestDb();
});

beforeEach(async () => {
  await testDb
    .delete(extractionRuns)
    .where(
      inArray(extractionRuns.workspaceId, [workspaceId, otherWorkspaceId]),
    );
});

const createRun = async (
  id = createSafeId<"extractionRun">(),
  overrides: Partial<{
    organizationId: typeof organizationId;
    workspaceId: typeof workspaceId;
  }> = {},
) => {
  const key = {
    id,
    organizationId: overrides.organizationId ?? organizationId,
    workspaceId: overrides.workspaceId ?? workspaceId,
  };
  await store.create({
    ...key,
    requestedBy: userId,
    scope: "workspace",
  });
  return key;
};

const readRun = async (
  id: ReturnType<typeof createSafeId<"extractionRun">>,
) => {
  const [run] = await testDb
    .select()
    .from(extractionRuns)
    .where(eq(extractionRuns.id, id));
  if (!run) {
    throw new Error(`Expected extraction run ${id} to exist`);
  }
  return run;
};

describe("extraction run store contract", () => {
  test("creates tenant-scoped planning metadata without workflow payloads", async () => {
    const key = await createRun();

    const run = await readRun(key.id);

    expect(run).toMatchObject({
      completed: 0,
      executionVersion: 1,
      organizationId,
      requestedBy: userId,
      scope: "workspace",
      status: "planning",
      total: 0,
      workspaceId,
    });
    expect(run.startedAt).toBeNull();
  });

  test("syncs absolute progress monotonically and bounds it to the target", async () => {
    const key = await createRun();
    await store.start({ ...key, total: 5 });

    expect((await readRun(key.id)).startedAt).not.toBeNull();

    await store.syncProgress({ ...key, completed: 3, total: 5 });
    await store.syncProgress({ ...key, completed: 1, total: 5 });
    expect(await readRun(key.id)).toMatchObject({
      completed: 3,
      status: "running",
      total: 5,
    });

    await store.syncProgress({ ...key, completed: 7, total: 5 });
    expect(await readRun(key.id)).toMatchObject({
      completed: 5,
      status: "finalizing",
      total: 5,
    });
  });

  test("rejects invalid counters before issuing a database mutation", async () => {
    const key = await createRun();

    const invalidTotal: unknown = await store.start({ ...key, total: -1 }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(invalidTotal).toBeInstanceOf(Error);
    expect(invalidTotal instanceof Error ? invalidTotal.message : "").toBe(
      "total must be a nonnegative safe integer",
    );
    await store.start({ ...key, total: 2 });
    const invalidCompleted: unknown = await store
      .syncProgress({ ...key, completed: Number.NaN, total: 2 })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(invalidCompleted).toBeInstanceOf(Error);
    expect(
      invalidCompleted instanceof Error ? invalidCompleted.message : "",
    ).toBe("completed must be a nonnegative safe integer");

    expect(await readRun(key.id)).toMatchObject({
      completed: 0,
      status: "running",
      total: 2,
    });
  });

  test("recovers a missed start write from the first absolute progress snapshot", async () => {
    const key = await createRun();

    await store.syncProgress({ ...key, completed: 1, total: 3 });

    const run = await readRun(key.id);
    expect(run).toMatchObject({ completed: 1, status: "running", total: 3 });
    expect(run.startedAt).not.toBeNull();
  });

  test("keeps terminal states immutable under late delivery", async () => {
    const key = await createRun();
    await store.start({ ...key, total: 2 });
    await store.complete(key);

    await store.syncProgress({ ...key, completed: 1, total: 2 });
    await store.fail({ ...key, errorCode: "LateFailure" });

    const run = await readRun(key.id);
    expect(run).toMatchObject({
      completed: 2,
      errorCode: null,
      status: "completed",
      total: 2,
    });
    expect(run.finishedAt).not.toBeNull();
  });

  test("records an entity failure without finishing until all work drains", async () => {
    const key = await createRun();
    await store.start({ ...key, total: 2 });

    await store.recordFailure({ ...key, errorCode: "ProviderFailed" });

    expect(await readRun(key.id)).toMatchObject({
      completed: 0,
      errorCode: "ProviderFailed",
      finishedAt: null,
      status: "running",
      total: 2,
    });

    await store.syncProgress({ ...key, completed: 2, total: 2 });
    await store.complete(key);

    const run = await readRun(key.id);
    expect(run).toMatchObject({
      completed: 2,
      errorCode: "ProviderFailed",
      status: "failed",
      total: 2,
    });
    expect(run.finishedAt).not.toBeNull();
  });

  test("requires the complete tenant key for every run mutation", async () => {
    const key = await createRun();

    await store.start({
      ...key,
      organizationId: otherOrganizationId,
      total: 4,
    });
    await store.fail({
      ...key,
      workspaceId: otherWorkspaceId,
      errorCode: "WrongTenant",
    });

    expect(await readRun(key.id)).toMatchObject({
      status: "planning",
      total: 0,
    });
  });

  test("requires both workspace and organization scope for app-role writes", async () => {
    const policyResult = await testDb.execute<{
      cmd: string;
      policyName: string;
      usingExpression: string | null;
      withCheckExpression: string | null;
    }>(sql`
      SELECT
        cmd,
        policyname AS "policyName",
        qual AS "usingExpression",
        with_check AS "withCheckExpression"
      FROM pg_catalog.pg_policies
      WHERE tablename = 'extraction_runs'
    `);
    expect(policyResult.rows).toHaveLength(4);
    for (const policy of policyResult.rows) {
      const expression =
        policy.cmd === "INSERT"
          ? policy.withCheckExpression
          : policy.usingExpression;
      expect(expression).toContain("organization_id");
      expect(expression).toContain("app.organization_id");
      expect(expression).toContain("workspace_id");
    }

    const scopedDb = asTestRaw<ScopedDb>(
      createScopedDb(testDb, [workspaceId], organizationId, userId),
    );
    const runId = createSafeId<"extractionRun">();

    const rejection: unknown = await scopedDb(async (tx) => {
      await tx.insert(extractionRuns).values({
        id: runId,
        organizationId: otherOrganizationId,
        workspaceId,
        requestedBy: userId,
        scope: "workspace",
      });
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(Error);
    const [inserted] = await testDb
      .select({ id: extractionRuns.id })
      .from(extractionRuns)
      .where(eq(extractionRuns.id, runId));
    expect(inserted).toBeUndefined();
  });

  test("skips only planning runs", async () => {
    const planning = await createRun();
    const running = await createRun();
    await store.start({ ...running, total: 1 });

    await store.skip(planning);
    await store.skip(running);

    expect(await readRun(planning.id)).toMatchObject({ status: "skipped" });
    expect(await readRun(running.id)).toMatchObject({ status: "running" });
  });

  test("orphan recovery fails only active runs in its workspace", async () => {
    const planning = await createRun();
    const completed = await createRun();
    await store.start({ ...completed, total: 1 });
    await store.complete(completed);
    const otherWorkspace = await createRun(createSafeId<"extractionRun">(), {
      organizationId: otherOrganizationId,
      workspaceId: otherWorkspaceId,
    });

    await store.failActiveForWorkspace({
      errorCode: "ExtractionRunOrphaned",
      workspaceId,
    });

    expect(await readRun(planning.id)).toMatchObject({
      errorCode: "ExtractionRunOrphaned",
      status: "failed",
    });
    expect(await readRun(completed.id)).toMatchObject({ status: "completed" });
    expect(await readRun(otherWorkspace.id)).toMatchObject({
      status: "planning",
    });
  });

  test("finds stale active workspaces for recovery without returning terminal runs", async () => {
    const stale = await createRun();
    const recent = await createRun();
    const terminal = await createRun();
    await store.start({ ...terminal, total: 1 });
    await store.complete(terminal);

    await testDb
      .update(extractionRuns)
      .set({ updatedAt: new Date("2026-01-01T00:00:00.000Z") })
      .where(eq(extractionRuns.id, stale.id));

    const workspaceIds = await store.listStaleActiveWorkspaceIds({
      before: new Date("2026-01-02T00:00:00.000Z"),
      limit: 10,
    });

    expect(workspaceIds).toEqual([workspaceId]);
    expect(await readRun(recent.id)).toMatchObject({ status: "planning" });
  });
});
