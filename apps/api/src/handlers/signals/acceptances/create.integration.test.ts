import {
  afterAll,
  beforeAll,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import {
  SCOUT_KEY,
  SIGNAL_KIND,
  SIGNAL_KIND_ORIGIN,
  SIGNAL_SEVERITY,
  SIGNAL_STATUS,
  SUGGESTION_KIND,
} from "@stll/api-contract/signals";

import { entities, signals } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const flushEntitySearchRepairsMock = mock(async () => ({
  failed: 0,
  repaired: 0,
}));
const { createAcceptSignal } =
  await import("@/api/handlers/signals/acceptances/create");
const acceptSignal = createAcceptSignal({
  flushEntitySearchRepairs: flushEntitySearchRepairsMock,
});

setDefaultTimeout(120_000);

type AcceptContext = Parameters<typeof acceptSignal.handler>[0];

let testDb: TestDatabase;
let ids: TestIds;
const signalIds: SafeId<"signal">[] = [];
const taskIds: SafeId<"entity">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  try {
    if (signalIds.length > 0) {
      await testDb.delete(signals).where(inArray(signals.id, signalIds));
    }
    if (taskIds.length > 0) {
      await testDb.delete(entities).where(inArray(entities.id, taskIds));
    }
  } finally {
    await releaseRlsFixture();
  }
});

const accept = async (signalId: SafeId<"signal">) => {
  const scopedDb = createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
  const safeDb = createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
  const recordAuditEvent: AcceptContext["recordAuditEvent"] = async () =>
    undefined;

  return await acceptSignal.handler(
    asTestRaw<AcceptContext>({
      body: { suggestionKind: SUGGESTION_KIND.CREATE_TASK },
      createAuditRecorder: () => recordAuditEvent,
      getAccessibleWorkspaces: async () => [{ id: ids.wsA1, status: "active" }],
      getActiveWorkspaceIds: async () => [ids.wsA1],
      getWorkspaceAccess: async () => ({ id: ids.wsA1, status: "active" }),
      memberRole: { role: "owner" },
      orgAIConfig: null,
      params: { signalId },
      promptCachingEnabled: false,
      recordAuditEvent,
      request: new Request("https://example.test/signals/acceptances"),
      route: "/test/signals/acceptances",
      safeDb,
      scopedDb,
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
    }),
  );
};

describe("signal acceptance", () => {
  test("concurrent task acceptance creates exactly one task", async () => {
    const signalId = createSafeId<"signal">();
    signalIds.push(signalId);
    const taskName = `Concurrent signal task ${signalId}`;
    await testDb.insert(signals).values({
      id: signalId,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      kind: SIGNAL_KIND.REQUEST_SUBMITTED,
      origin: SIGNAL_KIND_ORIGIN[SIGNAL_KIND.REQUEST_SUBMITTED],
      scoutKey: SCOUT_KEY.MANUAL_REQUEST,
      severity: SIGNAL_SEVERITY.NOTICE,
      title: taskName,
      summary: taskName,
      subject: {
        type: "entity",
        workspaceId: ids.wsA1,
        entityId: ids.entityA1,
      },
      evidence: {
        kind: SIGNAL_KIND.REQUEST_SUBMITTED,
        description: taskName,
        attachments: [],
      },
      suggestions: [
        {
          kind: SUGGESTION_KIND.CREATE_TASK,
          workspaceId: ids.wsA1,
          name: taskName,
          dueAt: null,
        },
      ],
      dedupeKey: `acceptance-race:${signalId}`,
    });

    const outcomes = await Promise.all([accept(signalId), accept(signalId)]);
    expect(outcomes.filter((outcome) => "status" in outcome)).toHaveLength(1);
    expect(outcomes.filter((outcome) => "code" in outcome)).toEqual([
      {
        code: 409,
        response: {
          message: "Signal is no longer in a state that allows this action",
        },
      },
    ]);

    const accepted = await testDb.query.signals.findFirst({
      where: { id: { eq: signalId } },
      columns: { acceptedResult: true, status: true },
    });
    expect(accepted?.status).toBe(SIGNAL_STATUS.ACCEPTED);
    expect(accepted?.acceptedResult).toMatchObject({
      result: { type: "entity", workspaceId: ids.wsA1 },
      suggestionKind: SUGGESTION_KIND.CREATE_TASK,
    });

    const createdTasks = await testDb
      .select({ id: entities.id })
      .from(entities)
      .where(
        and(
          eq(entities.workspaceId, ids.wsA1),
          eq(entities.kind, "task"),
          eq(entities.name, taskName),
        ),
      );
    expect(createdTasks).toHaveLength(1);
    const createdTask = createdTasks.at(0);
    expect(createdTask).toBeDefined();
    if (createdTask) {
      taskIds.push(createdTask.id);
      expect(accepted?.acceptedResult).toMatchObject({
        result: { entityId: createdTask.id },
      });
      const obligation = await testDb.query.workObligations.findFirst({
        where: { entityId: { eq: createdTask.id } },
        columns: { sourceEntityId: true },
      });
      expect(obligation?.sourceEntityId).toBe(ids.entityA1);
    }
    expect(flushEntitySearchRepairsMock).toHaveBeenCalledTimes(1);
  });
});
