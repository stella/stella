import { describe, expect, test } from "bun:test";

import {
  parseRunningLockWorkspaceId,
  selectOrphanWorkspaceIds,
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
