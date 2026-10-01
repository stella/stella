import { expect, spyOn, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import {
  actionCallObserver,
  runObservedAction,
  type ActionCallObserver,
  type ActionCostIdentity,
  type ActionCostObservation,
} from "./context";
import * as failure from "./observation-failure";

const identityFor = (organization: string): ActionCostIdentity => ({
  organizationId: toSafeId<"organization">(organization),
  actionKind: "chat.improve-prompt",
  logicalPhaseId: organization,
});
const recorderFor = (rows: ActionCostObservation[]) => ({
  enqueue: (row: ActionCostObservation) => {
    rows.push(row);
  },
  estimate: () => 17,
  callRate: () => 5,
});
const calls = (rows: ActionCostObservation[]) =>
  rows.filter((row) => row.type === "call");

test("matching capture records each call and settled callbacks stop recording", async () => {
  const identity = identityFor("fixture-org");
  const rows: ActionCostObservation[] = [];
  let captured: ActionCallObserver = () => {
    throw new TypeError("Observer was not captured");
  };
  await runObservedAction({
    identity,
    userId: null,
    recorder: recorderFor(rows),
    run: async () => {
      captured = actionCallObserver(identity.organizationId);
      captured("fixture_call");
      await Promise.resolve();
      captured("fixture_call");
    },
  });
  captured("fixture_late_call");
  expect(calls(rows)).toHaveLength(2);
  for (const call of calls(rows)) {
    expect(call.record).toMatchObject({
      ...identity,
      kind: "fixture_call",
      measuredMicroUnits: 5,
    });
  }
  expect(new Set(calls(rows).map(({ record }) => record.callId)).size).toBe(2);
});

test("mismatched and missing captures report their reason and never record later", async () => {
  const reported = spyOn(
    failure,
    "reportActionCostObservationFailure",
  ).mockImplementation(() => undefined);
  const identity = identityFor("fixture-org");
  const other = identityFor("other-org");
  const rows: ActionCostObservation[] = [];
  try {
    const missing = actionCallObserver(identity.organizationId);
    await runObservedAction({
      identity,
      userId: null,
      recorder: recorderFor(rows),
      run: async () => {
        missing("fixture_missing");
        const mismatched = actionCallObserver(other.organizationId);
        mismatched("fixture_mismatch");
        await runObservedAction({
          identity: other,
          userId: null,
          recorder: recorderFor(rows),
          run: async () => {
            mismatched("fixture_later");
          },
        });
      },
    });
    expect(calls(rows)).toEqual([]);
    expect(reported.mock.calls.map(([cause]) => cause)).toMatchObject([
      { _tag: "ActionCallObserverError", reason: "missing_scope" },
      { _tag: "ActionCallObserverError", reason: "organization_mismatch" },
    ]);
  } finally {
    reported.mockRestore();
  }
});

test("a settled scope cannot capture a fresh observer", async () => {
  const reported = spyOn(
    failure,
    "reportActionCostObservationFailure",
  ).mockImplementation(() => undefined);
  const identity = identityFor("fixture-org");
  const rows: ActionCostObservation[] = [];
  const release = Promise.withResolvers<undefined>();
  let late: Promise<undefined> | undefined;
  try {
    await runObservedAction({
      identity,
      userId: null,
      recorder: recorderFor(rows),
      run: async () => {
        late = release.promise.then(() => {
          actionCallObserver(identity.organizationId)("fixture_late");
          return undefined;
        });
      },
    });
    release.resolve(undefined);
    await late;
    expect(calls(rows)).toEqual([]);
    expect(reported.mock.calls.map(([cause]) => cause)).toMatchObject([
      { reason: "settled_scope" },
    ]);
  } finally {
    reported.mockRestore();
  }
});

test("captured callbacks keep their owner across concurrent interleavings and other active scopes", async () => {
  for (const rounds of [1, 3, 7]) {
    const left = identityFor("left-org");
    const right = identityFor("right-org");
    const leftRows: ActionCostObservation[] = [];
    const rightRows: ActionCostObservation[] = [];
    const leftReady = Promise.withResolvers<ActionCallObserver>();
    const rightReady = Promise.withResolvers<ActionCallObserver>();
    await Promise.all([
      runObservedAction({
        identity: left,
        userId: null,
        recorder: recorderFor(leftRows),
        run: async () => {
          const own = actionCallObserver(left.organizationId);
          leftReady.resolve(own);
          const other = await rightReady.promise;
          for (let round = 0; round < rounds; round += 1) {
            await Promise.resolve();
            own("left_call");
            other("right_call");
          }
        },
      }),
      runObservedAction({
        identity: right,
        userId: null,
        recorder: recorderFor(rightRows),
        run: async () => {
          const own = actionCallObserver(right.organizationId);
          rightReady.resolve(own);
          const other = await leftReady.promise;
          for (let round = 0; round < rounds; round += 1) {
            other("left_call");
            await Promise.resolve();
            own("right_call");
          }
        },
      }),
    ]);
    expect(calls(leftRows)).toHaveLength(rounds * 2);
    expect(calls(rightRows)).toHaveLength(rounds * 2);
    for (const row of calls(leftRows)) {
      expect(row.record).toMatchObject({ ...left, kind: "left_call" });
    }
    for (const row of calls(rightRows)) {
      expect(row.record).toMatchObject({ ...right, kind: "right_call" });
    }
  }
});

test("recorder failure reports the error and preserves the caller outcome", async () => {
  const reported = spyOn(
    failure,
    "reportActionCostObservationFailure",
  ).mockImplementation(() => undefined);
  const identity = identityFor("fixture-org");
  const rows: ActionCostObservation[] = [];
  const cause = new TypeError("fixture recorder failure");
  try {
    const result = await runObservedAction({
      identity,
      userId: null,
      recorder: {
        ...recorderFor(rows),
        callRate: () => {
          throw cause;
        },
      },
      run: async () => {
        actionCallObserver(identity.organizationId)("fixture_call");
        return "done";
      },
    });
    expect(result).toBe("done");
    expect(calls(rows)).toEqual([]);
    expect(reported).toHaveBeenCalledWith(cause);
  } finally {
    reported.mockRestore();
  }
});

test("multi-request registry lookup records every outbound request in its captured scope", async () => {
  const { searchByName } = await import("@stll/business-registries/gcis");
  const { actionRequestObserver, ACTION_COST_CALL_KIND } =
    await import("./context");
  const originalFetch = globalThis.fetch;
  const left = identityFor("left-org");
  const right = identityFor("right-org");
  const leftRows: ActionCostObservation[] = [];
  const rightRows: ActionCostObservation[] = [];
  let outbound = 0;
  globalThis.fetch = Object.assign(
    async () => {
      outbound += 1;
      return new Response("[]", {
        headers: { "content-type": "application/json" },
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    await runObservedAction({
      identity: left,
      userId: null,
      recorder: recorderFor(leftRows),
      run: async () => {
        const observer = actionRequestObserver(
          left.organizationId,
          ACTION_COST_CALL_KIND.registryRequest,
        );
        await runObservedAction({
          identity: right,
          userId: null,
          recorder: recorderFor(rightRows),
          run: async () => {
            expect(await searchByName("fixture", { observer })).toEqual([]);
          },
        });
      },
    });
    expect(outbound).toBe(2);
    expect(calls(leftRows)).toHaveLength(outbound);
    expect(calls(rightRows)).toEqual([]);
    for (const row of calls(leftRows)) {
      expect(row.record).toMatchObject({
        ...left,
        kind: ACTION_COST_CALL_KIND.registryRequest,
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
