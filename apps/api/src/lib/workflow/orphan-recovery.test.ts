import { describe, expect, test } from "bun:test";

import {
  isCurrentWorkflowRequestState,
  parseRunningLockWorkspaceId,
  selectOrphanWorkspaceIds,
  selectRecoverableOrphanWorkspaceIds,
  selectRunningLockReservation,
} from "@/api/lib/workflow/orphan-recovery";

const LEGACY_RUNNING_LOCK_VALUE = "1";
const RECOVERY_LOCK_VALUE = "recovery";

describe("parseRunningLockWorkspaceId", () => {
  test("extracts the workspace id from a running-lock key", () => {
    expect(parseRunningLockWorkspaceId("workflow:ws-123:running")).toBe(
      "ws-123",
    );
  });

  test("ignores sibling run-state keys so only locks are reconciled", () => {
    expect(parseRunningLockWorkspaceId("workflow:ws-123:completed")).toBeNull();
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
      }),
    ).toEqual([]);
  });

  test("recovers a bare lock with no request id", () => {
    expect(
      selectRecoverableOrphanWorkspaceIds({
        candidateWorkspaceIds: ["a"],
        currentRequestIds: new Map([["a", null]]),
        initialRequestIds: new Map([["a", null]]),
        liveWorkspaceIds: new Set(),
        pendingWorkspaceIds: new Set(),
      }),
    ).toEqual(["a"]);
  });
});

describe("isCurrentWorkflowRequestState", () => {
  test("accepts the request-owned running lock", () => {
    expect(
      isCurrentWorkflowRequestState({
        currentRequestId: "request-a",
        legacyRunningLockValue: LEGACY_RUNNING_LOCK_VALUE,
        requestId: "request-a",
        runningValue: "request-a",
      }),
    ).toBe(true);
  });

  test("keeps legacy locks current for in-flight workers", () => {
    expect(
      isCurrentWorkflowRequestState({
        currentRequestId: "request-a",
        legacyRunningLockValue: LEGACY_RUNNING_LOCK_VALUE,
        requestId: "request-a",
        runningValue: LEGACY_RUNNING_LOCK_VALUE,
      }),
    ).toBe(true);
  });

  test("does not let a recovery reservation look current", () => {
    expect(
      isCurrentWorkflowRequestState({
        currentRequestId: "request-a",
        legacyRunningLockValue: LEGACY_RUNNING_LOCK_VALUE,
        requestId: "request-a",
        runningValue: RECOVERY_LOCK_VALUE,
      }),
    ).toBe(false);
  });
});

describe("selectRunningLockReservation", () => {
  test("reserves request-valued locks for the matching request", () => {
    expect(
      selectRunningLockReservation({
        expectedRequestId: "request-a",
        legacyRunningLockValue: LEGACY_RUNNING_LOCK_VALUE,
        recoveryLockValue: RECOVERY_LOCK_VALUE,
        requestId: "request-a",
        runningValue: "request-a",
      }),
    ).toEqual({ status: "reserve", expectedRunningValue: "request-a" });
  });

  test("keeps request-valued locks owned by another request untouched", () => {
    expect(
      selectRunningLockReservation({
        expectedRequestId: "request-a",
        legacyRunningLockValue: LEGACY_RUNNING_LOCK_VALUE,
        recoveryLockValue: RECOVERY_LOCK_VALUE,
        requestId: "request-a",
        runningValue: "request-b",
      }),
    ).toEqual({ status: "skip" });
  });

  test("settles legacy locks before reserving them", () => {
    expect(
      selectRunningLockReservation({
        expectedRequestId: "request-a",
        legacyRunningLockValue: LEGACY_RUNNING_LOCK_VALUE,
        recoveryLockValue: RECOVERY_LOCK_VALUE,
        requestId: "request-a",
        runningValue: LEGACY_RUNNING_LOCK_VALUE,
      }),
    ).toEqual({ status: "settle-legacy" });
  });
});
