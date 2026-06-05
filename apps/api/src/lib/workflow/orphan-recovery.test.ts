import { describe, expect, test } from "bun:test";

import {
  parseRunningLockWorkspaceId,
  selectOrphanWorkspaceIds,
  selectRecoverableOrphanWorkspaceIds,
} from "@/api/lib/workflow/orphan-recovery";

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
