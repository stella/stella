import { Result } from "better-result";
import { expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { withActionAdmission } from "@/api/lib/rate-limit/action-admission";
import type { ActionKind } from "@/api/lib/rate-limit/action-kinds";

import { createObservationBuffer } from "./buffer";
import {
  currentActionCostIdentity,
  actionCallObserver,
  type ActionCostObservation,
} from "./context";

const organizationId = toSafeId<"organization">("fixture-org");
const userId = toSafeId<"user">("fixture-user");
const policy = {
  organizationConcurrency: 7,
  userConcurrency: 3,
  leaseMs: 120_000,
};
const recorderFor = (observations: ActionCostObservation[]) => ({
  enqueue: (row: ActionCostObservation) => {
    observations.push(row);
  },
  estimate: () => 17,
  callRate: () => 5,
});
const admissionOptions = {
  organizationId,
  userId,
  policy,
  enabled: true,
  redis: { send: async () => 1 },
};

const registeredKinds = {
  "chat.send": "chat.send",
  "chat.generate-thread-title": "chat.generate-thread-title",
  "chat.improve-prompt": "chat.improve-prompt",
  "chat.suggest-thread-title": "chat.suggest-thread-title",
  "mcp.services/call": "mcp.services/call",
  "mcp.data/call": "mcp.data/call",
} as const satisfies { [Kind in ActionKind]: Kind };

for (const enabled of [true, false]) {
  for (const actionKind of Object.values(registeredKinds)) {
    test(`${actionKind} captures one identity with admission enabled=${enabled}`, async () => {
      const observations: ActionCostObservation[] = [];
      const periodIdentity = { actionKind, logicalPhaseId: "fixture-phase" };
      const outcome = await withActionAdmission({
        ...admissionOptions,
        enabled,
        redis: {
          send: async () => {
            expect(enabled).toBe(true);
            return 1;
          },
        },
        periodIdentity,
        costRecorder: recorderFor(observations),
        run: async (_signal, control) => {
          expect(Result.isOk(await control.reservePeriod(periodIdentity))).toBe(
            true,
          );
          expect(currentActionCostIdentity(organizationId)).toEqual({
            organizationId,
            ...periodIdentity,
          });
          expect(
            currentActionCostIdentity(toSafeId<"organization">("other-org")),
          ).toBeUndefined();
          actionCallObserver(organizationId)("fixture_provider");
          return "done";
        },
      });
      expect(Result.isOk(outcome)).toBe(true);
      expect(observations.map((row) => row.type)).toEqual([
        "action",
        "call",
        "action",
      ]);
      const first = observations.at(0);
      const last = observations.at(-1);
      expect(first?.record).toMatchObject({
        ...periodIdentity,
        settledAt: null,
        estimatedMicroUnits: 17,
      });
      expect(last?.record).toMatchObject({
        ...periodIdentity,
        settledAt: expect.any(Date),
      });
      expect(currentActionCostIdentity(organizationId)).toBeUndefined();
    });
  }
}

test("refused actions produce no observations and disabled recording produces no writes", async () => {
  const rows: ActionCostObservation[] = [];
  let executions = 0;
  const run = async () => {
    executions += 1;
    return "done";
  };
  const denied = await withActionAdmission({
    ...admissionOptions,
    periodIdentity: {
      actionKind: "chat.improve-prompt",
      logicalPhaseId: "refusal",
    },
    costRecorder: recorderFor(rows),
    redis: { send: async () => 0 },
    run,
  });
  expect(Result.isError(denied)).toBe(true);
  expect(executions).toBe(0);
  expect(rows).toEqual([]);
  const allowed = await withActionAdmission({
    ...admissionOptions,
    periodIdentity: {
      actionKind: "chat.improve-prompt",
      logicalPhaseId: "disabled",
    },
    costRecorder: null,
    run: async () => {
      actionCallObserver(organizationId)("fixture_provider");
      return await run();
    },
  });
  expect(Result.isOk(allowed)).toBe(true);
  expect(executions).toBe(1);
  expect(rows).toEqual([]);
});

test("a failing write remains detached from successful work and records the dropped count", async () => {
  let dropped = 0;
  const buffer = createObservationBuffer({
    capacity: 9,
    batchSize: 4,
    write: async (_batch: ActionCostObservation[]) => {
      throw new TypeError("fixture write failure");
    },
    onFailure: (error, count) => {
      expect(error).toBeInstanceOf(TypeError);
      dropped += count;
    },
    onOverflow: () => {
      dropped += 1;
    },
  });
  const outcome = await withActionAdmission({
    ...admissionOptions,
    periodIdentity: {
      actionKind: "chat.improve-prompt",
      logicalPhaseId: "write-failure",
    },
    costRecorder: { ...recorderFor([]), enqueue: buffer.enqueue },
    run: async () => "completed-result",
  });
  expect(outcome).toMatchObject({ value: "completed-result" });
  await buffer.flush();
  expect(dropped).toBe(2);
});

test("nested same-identity work shares its observation scope, distinct phases remain separate", async () => {
  const rows: ActionCostObservation[] = [];
  const recorder = recorderFor(rows);
  const periodIdentity = {
    actionKind: "chat.improve-prompt",
    logicalPhaseId: "outer",
  } as const;
  await withActionAdmission({
    ...admissionOptions,
    periodIdentity,
    costRecorder: recorder,
    run: async () => {
      await withActionAdmission({
        ...admissionOptions,
        periodIdentity,
        costRecorder: recorder,
        run: async () => {
          actionCallObserver(organizationId)("fixture_provider");
        },
      });
      await withActionAdmission({
        ...admissionOptions,
        periodIdentity: {
          actionKind: "chat.improve-prompt",
          logicalPhaseId: "inner",
        },
        costRecorder: recorder,
        run: async () => {
          actionCallObserver(organizationId)("fixture_provider");
        },
      });
    },
  });
  expect(
    rows
      .filter((row) => row.type === "action")
      .map((row) => row.record.logicalPhaseId),
  ).toEqual(["outer", "inner", "inner", "outer"]);
  const calls = rows.filter((row) => row.type === "call");
  expect(calls).toHaveLength(2);
  expect(calls.at(0)?.record.callId).not.toBe(calls.at(1)?.record.callId);
});

test("failed execution still settles its admitted record", async () => {
  const rows: ActionCostObservation[] = [];
  const outcome = await withActionAdmission({
    ...admissionOptions,
    periodIdentity: {
      actionKind: "chat.improve-prompt",
      logicalPhaseId: "failed",
    },
    costRecorder: recorderFor(rows),
    run: async () => {
      throw new TypeError("fixture execution failure");
    },
  });
  expect(Result.isError(outcome)).toBe(true);
  expect(rows.at(-1)?.record).toMatchObject({ settledAt: expect.any(Date) });
});

test("accepted work aborted before execution still has an admitted and settled observation", async () => {
  const rows: ActionCostObservation[] = [];
  let clockReads = 0;
  let executions = 0;
  const outcome = await withActionAdmission({
    ...admissionOptions,
    periodIdentity: {
      actionKind: "chat.improve-prompt",
      logicalPhaseId: "expired-before-start",
    },
    costRecorder: recorderFor(rows),
    timing: {
      now: () => (clockReads++ === 0 ? 0 : policy.leaseMs + 1),
      schedule: () => () => {},
    },
    run: async () => {
      executions += 1;
    },
  });
  expect(Result.isError(outcome)).toBe(true);
  expect(executions).toBe(0);
  expect(rows).toHaveLength(2);
  expect(rows.at(-1)?.record).toMatchObject({ settledAt: expect.any(Date) });
});
