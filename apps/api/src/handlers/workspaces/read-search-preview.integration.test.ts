import { panic } from "better-result";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import type { ScopedDb } from "@/api/db/safe-db";
import { entities, flowRuns, flowRunSteps } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { readSearchPreviewHandler } from "./read-search-preview.query";
import readSearchPreview from "./search-preview/get";

const testState = createTestState({ file: import.meta.path, config: env });

let testDb: TestDatabase;
let ids: TestIds;
let scopedDb: ScopedDb;
const seededIds: ReturnType<typeof createSafeId<"entity">>[] = [];

testState.beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
  );
});

afterEach(async () => {
  if (seededIds.length === 0) {
    return;
  }
  await testDb.delete(entities).where(inArray(entities.id, seededIds));
  seededIds.length = 0;
});

afterAll(async () => {
  await releaseRlsFixture();
});

const entityId = () => {
  const id = createSafeId<"entity">();
  seededIds.push(id);
  return id;
};

describe("matter search preview", () => {
  test("returns bounded independent highlights without leaking another matter", async () => {
    const firstTaskId = entityId();
    const secondTaskId = entityId();
    const thirdTaskId = entityId();
    const omittedTaskId = entityId();
    const completedTaskId = entityId();
    const overdueTaskIds = [entityId(), entityId(), entityId()];
    const recentDocumentId = entityId();
    const olderDocumentId = entityId();
    const legacyDocumentId = entityId();
    const otherMatterTaskId = entityId();
    const otherMatterDocumentId = entityId();

    await testDb.insert(entities).values([
      {
        id: firstTaskId,
        workspaceId: ids.wsA1,
        kind: "task",
        name: "Preview first deadline",
        dueDate: "2999-01-01",
        status: "open",
      },
      {
        id: secondTaskId,
        workspaceId: ids.wsA1,
        kind: "task",
        name: "Preview second deadline",
        dueDate: "2999-01-02",
        status: null,
      },
      {
        id: thirdTaskId,
        workspaceId: ids.wsA1,
        kind: "task",
        name: "Preview third deadline",
        dueDate: "2999-01-03",
        status: "in_progress",
      },
      {
        id: omittedTaskId,
        workspaceId: ids.wsA1,
        kind: "task",
        name: "Preview fourth deadline",
        dueDate: "2999-01-04",
        status: "open",
      },
      {
        id: completedTaskId,
        workspaceId: ids.wsA1,
        kind: "task",
        name: "Preview completed deadline",
        dueDate: "2998-01-01",
        status: "done",
      },
      ...overdueTaskIds.map((id, index) => ({
        id,
        workspaceId: ids.wsA1,
        kind: "task" as const,
        name: `Overdue deadline ${index + 1}`,
        dueDate: `1900-01-0${index + 1}`,
        status: "open",
      })),
      {
        id: legacyDocumentId,
        workspaceId: ids.wsA1,
        kind: "document",
        name: "Preview document without edit timestamp",
        createdAt: new Date("2999-01-03T00:00:00.000Z"),
        updatedAt: null,
      },
      {
        id: recentDocumentId,
        workspaceId: ids.wsA1,
        kind: "document",
        name: "Preview latest document",
        updatedAt: new Date("2999-01-02T00:00:00.000Z"),
      },
      {
        id: olderDocumentId,
        workspaceId: ids.wsA1,
        kind: "document",
        name: "Preview older document",
        updatedAt: new Date("2999-01-01T00:00:00.000Z"),
      },
      {
        id: otherMatterTaskId,
        workspaceId: ids.wsB1,
        kind: "task",
        name: "Other matter deadline",
        dueDate: "2998-01-01",
        status: "open",
      },
      {
        id: otherMatterDocumentId,
        workspaceId: ids.wsB1,
        kind: "document",
        name: "Other matter document",
        updatedAt: new Date("3000-01-01T00:00:00.000Z"),
      },
    ]);

    const result = await readSearchPreviewHandler({
      organizationId: ids.orgA,
      userId: ids.userA1,
      scopedDb,
      workspaceId: ids.wsA1,
    });

    expect(result.upcomingAgenda).toHaveLength(
      LIMITS.matterSearchPreviewAgendaItems,
    );
    expect(result.upcomingAgenda.map(({ id }) => id)).toEqual([
      firstTaskId,
      secondTaskId,
      thirdTaskId,
    ]);
    expect(result.recentDocuments).toEqual([
      {
        id: legacyDocumentId,
        name: "Preview document without edit timestamp",
        updatedAt: "2999-01-03T00:00:00.000Z",
      },
      {
        id: recentDocumentId,
        name: "Preview latest document",
        updatedAt: "2999-01-02T00:00:00.000Z",
      },
      {
        id: olderDocumentId,
        name: "Preview older document",
        updatedAt: "2999-01-01T00:00:00.000Z",
      },
    ]);
    expect(
      result.upcomingAgenda.some(({ id }) => id === otherMatterTaskId),
    ).toBe(false);
    expect(
      result.upcomingAgenda.some(({ id }) => overdueTaskIds.includes(id)),
    ).toBe(false);
    expect(
      result.recentDocuments.some(({ id }) => id === otherMatterDocumentId),
    ).toBe(false);
  });

  test("the safe handler carries its session principal into linked review visibility", async () => {
    const reviewTaskId = entityId();
    const ordinaryTaskId = entityId();
    const runId = createSafeId<"flowRun">();
    const previousFlag = env.FEATURE_FLOWS;
    const restoreMode = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
    testState.setConfig("FEATURE_FLOWS", true);
    try {
      await testDb.insert(entities).values([
        {
          id: reviewTaskId,
          workspaceId: ids.wsA1,
          kind: "task",
          name: "Review preview",
          dueDate: "2999-01-01",
          status: "open",
        },
        {
          id: ordinaryTaskId,
          workspaceId: ids.wsA1,
          kind: "task",
          name: "Ordinary preview",
          dueDate: "2999-01-02",
          status: "open",
        },
      ]);
      await testDb.insert(flowRuns).values({
        id: runId,
        workspaceId: ids.wsA1,
        status: "awaiting_review",
        triggerSource: { type: "manual", userId: ids.userA1 },
        definitionSnapshot: {
          name: "Preview flow",
          steps: [
            { kind: "review-gate", name: "Review", instructions: "Review" },
          ],
        },
      });
      await testDb.insert(flowRunSteps).values({
        id: createSafeId<"flowRunStep">(),
        runId,
        workspaceId: ids.wsA1,
        index: 0,
        kind: "review-gate",
        status: "awaiting_review",
        reviewTaskEntityId: reviewTaskId,
      });
      const readThroughHandler = async () => {
        const response = await readSearchPreview.handler(
          asTestRaw<Parameters<typeof readSearchPreview.handler>[0]>({
            memberRole: sessionMemberRole("owner"),
            scopedDb,
            workspaceId: ids.wsA1,
            session: { activeOrganizationId: ids.orgA },
            user: { id: ids.userA1 },
          }),
        );
        if (!("upcomingAgenda" in response)) {
          return panic(
            "Search preview safe handler returned an error response",
          );
        }
        return response.upcomingAgenda.map(({ id }) => id);
      };
      // The RLS fixture grants flows to the standard actor. This exercises
      // the actual transport adapter, not merely its query helper signature.
      expect(await readThroughHandler()).toContain(reviewTaskId);
      expect(await readThroughHandler()).toContain(ordinaryTaskId);
      testState.setConfig("FEATURE_FLOWS", false);
      const hidden = await readThroughHandler();
      expect(hidden).not.toContain(reviewTaskId);
      expect(hidden).toContain(ordinaryTaskId);
    } finally {
      testState.setConfig("FEATURE_FLOWS", previousFlag);
      restoreMode();
      await testDb.delete(flowRuns).where(eq(flowRuns.id, runId));
    }
  });
});
