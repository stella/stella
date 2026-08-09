import { describe, expect, test } from "bun:test";

import {
  isCurrentWorkflowRequestState,
  parseRunningLockWorkspaceId,
  selectExpiredStaleRunWorkspaceIds,
  selectOrphanWorkspaceIds,
  selectRecoverableOrphanWorkspaceIds,
  selectRunningLockReservation,
} from "@/api/lib/workflow/orphan-recovery";

const RECOVERY_LOCK_VALUE = "recovery";
const TRANSITIONAL_RUNNING_LOCK_VALUE = "1";

describe("selectExpiredStaleRunWorkspaceIds", () => {
  test("uses stale rows only after both Redis run-state keys expire", () => {
    expect(
      selectExpiredStaleRunWorkspaceIds({
        currentRequestIds: new Map([
          ["expired", null],
          ["planning", "request-planning"],
          ["partial-expiry", "request-partial"],
        ]),
        currentRunningValues: new Map([
          ["expired", null],
          ["planning", "request-planning"],
          ["partial-expiry", null],
        ]),
        staleWorkspaceIds: ["expired", "planning", "partial-expiry", "expired"],
      }),
    ).toEqual(["expired"]);
  });
});

describe("parseRunningLockWorkspaceId", () => {
  test("extracts the workspace id from a running-lock key", () => {
    expect(parseRunningLockWorkspaceId("workflow:ws-123:running")).toBe(
      "ws-123",
    );
  });

  test("ignores sibling run-state keys so only locks are reconciled", () => {
    expect(
      parseRunningLockWorkspaceId("workflow:ws-123:completed-entities"),
    ).toBeNull();
    expect(
      parseRunningLockWorkspaceId("workflow:ws-123:request-id"),
    ).toBeNull();
    expect(parseRunningLockWorkspaceId("workflow:ws-123:total")).toBeNull();
  });

  test("ignores malformed keys", () => {
    expect(parseRunningLockWorkspaceId("running")).toBeNull();
    expect(parseRunningLockWorkspaceId("workflow::running")).toBeNull();
    expect(parseRunningLockWorkspaceId("other:ws-123:running")).toBeNull();
  });
});

describe("selectOrphanWorkspaceIds", () => {
  test("returns candidates with no live job", () => {
    expect(
      selectOrphanWorkspaceIds({
        candidateWorkspaceIds: ["a", "b", "c"],
        liveWorkspaceIds: new Set(["b"]),
      }),
    ).toEqual(["a", "c"]);
  });

  test("treats a workspace with any live job as healthy", () => {
    expect(
      selectOrphanWorkspaceIds({
        candidateWorkspaceIds: ["a"],
        liveWorkspaceIds: new Set(["a"]),
      }),
    ).toEqual([]);
  });

  test("deduplicates a workspace surfaced by both the lock and pending scans", () => {
    expect(
      selectOrphanWorkspaceIds({
        candidateWorkspaceIds: ["a", "a", "b"],
        liveWorkspaceIds: new Set(),
      }),
    ).toEqual(["a", "b"]);
  });
});

describe("selectRecoverableOrphanWorkspaceIds", () => {
  test("recovers stable candidates with pending cells", () => {
    expect(
      selectRecoverableOrphanWorkspaceIds({
        candidateWorkspaceIds: ["a"],
        currentRequestIds: new Map([["a", "request-a"]]),
        initialRequestIds: new Map([["a", "request-a"]]),
        liveWorkspaceIds: new Set(),
        pendingWorkspaceIds: new Set(["a"]),
        recoveryWorkspaceIds: new Set(),
      }),
    ).toEqual(["a"]);
  });

  test("skips candidates whose request id changed during the settle window", () => {
    expect(
      selectRecoverableOrphanWorkspaceIds({
        candidateWorkspaceIds: ["a"],
        currentRequestIds: new Map([["a", "request-b"]]),
        initialRequestIds: new Map([["a", "request-a"]]),
        liveWorkspaceIds: new Set(),
        pendingWorkspaceIds: new Set(["a"]),
        recoveryWorkspaceIds: new Set(),
      }),
    ).toEqual([]);
  });

  test("does not recover a planning workflow with an established request id", () => {
    expect(
      selectRecoverableOrphanWorkspaceIds({
        candidateWorkspaceIds: ["a"],
        currentRequestIds: new Map([["a", "request-a"]]),
        initialRequestIds: new Map([["a", "request-a"]]),
        liveWorkspaceIds: new Set(),
        pendingWorkspaceIds: new Set(),
        recoveryWorkspaceIds: new Set(),
      }),
    ).toEqual([]);
  });

  test("skips a bare lock with no pending-cell evidence", () => {
    expect(
      selectRecoverableOrphanWorkspaceIds({
        candidateWorkspaceIds: ["a"],
        currentRequestIds: new Map([["a", null]]),
        initialRequestIds: new Map([["a", null]]),
        liveWorkspaceIds: new Set(),
        pendingWorkspaceIds: new Set(),
        recoveryWorkspaceIds: new Set(),
      }),
    ).toEqual([]);
  });

  test("recovers a recovery-owned lock with no pending-cell evidence", () => {
    expect(
      selectRecoverableOrphanWorkspaceIds({
        candidateWorkspaceIds: ["a"],
        currentRequestIds: new Map([["a", "request-a"]]),
        initialRequestIds: new Map([["a", "request-a"]]),
        liveWorkspaceIds: new Set(),
        pendingWorkspaceIds: new Set(),
        recoveryWorkspaceIds: new Set(["a"]),
      }),
    ).toEqual(["a"]);
  });
});

describe("isCurrentWorkflowRequestState", () => {
  test("accepts the request-owned running lock", () => {
    expect(
      isCurrentWorkflowRequestState({
        currentRequestId: "request-a",
        requestId: "request-a",
        runningValue: "request-a",
        transitionalRunningLockValue: TRANSITIONAL_RUNNING_LOCK_VALUE,
      }),
    ).toBe(true);
  });

  test("accepts transitional constant-valued running locks", () => {
    expect(
      isCurrentWorkflowRequestState({
        currentRequestId: "request-a",
        requestId: "request-a",
        runningValue: TRANSITIONAL_RUNNING_LOCK_VALUE,
        transitionalRunningLockValue: TRANSITIONAL_RUNNING_LOCK_VALUE,
      }),
    ).toBe(true);
  });

  test("does not let a recovery reservation look current", () => {
    expect(
      isCurrentWorkflowRequestState({
        currentRequestId: "request-a",
        requestId: "request-a",
        runningValue: RECOVERY_LOCK_VALUE,
        transitionalRunningLockValue: TRANSITIONAL_RUNNING_LOCK_VALUE,
      }),
    ).toBe(false);
  });
});

describe("selectRunningLockReservation", () => {
  test("reserves request-valued locks for the matching request", () => {
    expect(
      selectRunningLockReservation({
        expectedRequestId: "request-a",
        recoveryLockValue: RECOVERY_LOCK_VALUE,
        requestId: "request-a",
        runningValue: "request-a",
        transitionalRunningLockValue: TRANSITIONAL_RUNNING_LOCK_VALUE,
      }),
    ).toEqual({ status: "reserve", expectedRunningValue: "request-a" });
  });

  test("keeps request-valued locks owned by another request untouched", () => {
    expect(
      selectRunningLockReservation({
        expectedRequestId: "request-a",
        recoveryLockValue: RECOVERY_LOCK_VALUE,
        requestId: "request-a",
        runningValue: "request-b",
        transitionalRunningLockValue: TRANSITIONAL_RUNNING_LOCK_VALUE,
      }),
    ).toEqual({ status: "skip" });
  });

  test("reserves a recovery-owned lock", () => {
    expect(
      selectRunningLockReservation({
        expectedRequestId: "request-a",
        recoveryLockValue: RECOVERY_LOCK_VALUE,
        requestId: "request-a",
        runningValue: RECOVERY_LOCK_VALUE,
        transitionalRunningLockValue: TRANSITIONAL_RUNNING_LOCK_VALUE,
      }),
    ).toEqual({
      status: "reserve",
      expectedRunningValue: RECOVERY_LOCK_VALUE,
    });
  });

  test("reserves transitional constant-valued running locks", () => {
    expect(
      selectRunningLockReservation({
        expectedRequestId: "request-a",
        recoveryLockValue: RECOVERY_LOCK_VALUE,
        requestId: "request-a",
        runningValue: TRANSITIONAL_RUNNING_LOCK_VALUE,
        transitionalRunningLockValue: TRANSITIONAL_RUNNING_LOCK_VALUE,
      }),
    ).toEqual({
      status: "reserve",
      expectedRunningValue: TRANSITIONAL_RUNNING_LOCK_VALUE,
    });
  });

  test("does not reserve a transitional lock without a request binding", () => {
    expect(
      selectRunningLockReservation({
        expectedRequestId: null,
        recoveryLockValue: RECOVERY_LOCK_VALUE,
        requestId: null,
        runningValue: TRANSITIONAL_RUNNING_LOCK_VALUE,
        transitionalRunningLockValue: TRANSITIONAL_RUNNING_LOCK_VALUE,
      }),
    ).toEqual({ status: "skip" });
  });
});
