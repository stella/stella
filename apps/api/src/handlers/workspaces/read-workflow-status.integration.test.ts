import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { extractionRuns } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { readWorkflowHandler } from "./read-workflow-status";

let testDb: TestDatabase;
let ids: TestIds;
let scopedDb: ScopedDb;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
  );
});

afterEach(async () => {
  await testDb
    .delete(extractionRuns)
    .where(eq(extractionRuns.workspaceId, ids.wsA1));
});

afterAll(async () => {
  await releaseRlsFixture();
});

describe("read workflow status", () => {
  test("returns the latest tenant-scoped durable run with Redis compatibility state", async () => {
    const olderRunId = createSafeId<"extractionRun">();
    const latestRunId = createSafeId<"extractionRun">();
    await testDb.insert(extractionRuns).values([
      {
        id: olderRunId,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        requestedBy: ids.userA1,
        scope: "workspace",
        status: "completed",
        total: 2,
        completed: 2,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: latestRunId,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        requestedBy: ids.userA1,
        scope: "properties",
        status: "running",
        total: 5,
        completed: 3,
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    ]);

    const result = await readWorkflowHandler({
      organizationId: ids.orgA,
      readRunningState: async () => await Promise.resolve(true),
      scopedDb,
      workspaceId: ids.wsA1,
    });

    expect(result).toMatchObject({
      running: true,
      run: {
        completed: 3,
        executionVersion: 1,
        id: latestRunId,
        scope: "properties",
        status: "running",
        total: 5,
      },
    });
  });

  test("returns no run when the organization discriminator does not match", async () => {
    await testDb.insert(extractionRuns).values({
      id: createSafeId<"extractionRun">(),
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      requestedBy: ids.userA1,
      scope: "workspace",
    });

    const result = await readWorkflowHandler({
      organizationId: ids.orgB,
      readRunningState: async () => await Promise.resolve(false),
      scopedDb,
      workspaceId: ids.wsA1,
    });

    expect(result).toEqual({ running: false, run: null });
  });

  test("returns a null durable run before the first extraction", async () => {
    const result = await readWorkflowHandler({
      organizationId: ids.orgA,
      readRunningState: async () => await Promise.resolve(false),
      scopedDb,
      workspaceId: ids.wsA1,
    });

    expect(result).toEqual({ running: false, run: null });
  });
});
