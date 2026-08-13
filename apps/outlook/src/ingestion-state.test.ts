import { describe, expect, test } from "bun:test";

import {
  ingestTransitionTargets,
  type IngestStateType,
  isLatestSnapshotForSave,
  pendingUploadMatchesSnapshot,
} from "@/ingestion-state";

const REQUIRED_STATES = [
  "idle",
  "downloading",
  "reserved",
  "uploading",
  "finalizing",
  "aborting",
  "complete",
  "error",
] as const satisfies readonly IngestStateType[];

describe("Outlook ingestion state machine", () => {
  test("declares every lifecycle state and no undeclared state", () => {
    const declared = new Set(REQUIRED_STATES);
    for (const state of REQUIRED_STATES) {
      declared.add(state);
      for (const target of ingestTransitionTargets(state)) {
        declared.add(target);
      }
    }

    expect([...declared].sort()).toEqual([...REQUIRED_STATES].sort());
  });

  test("keeps reserved work recoverable through upload, finalize, or abort", () => {
    expect(ingestTransitionTargets("reserved")).toEqual([
      "reserved",
      "uploading",
      "finalizing",
      "aborting",
      "error",
    ]);
    expect(ingestTransitionTargets("uploading")).toContain("finalizing");
    expect(ingestTransitionTargets("finalizing")).toContain("complete");
    expect(ingestTransitionTargets("aborting")).toContain("downloading");
  });
});

describe("Outlook ingestion message identity", () => {
  test("rejects a newly selected message even when it is current", () => {
    expect(
      isLatestSnapshotForSave({
        initialItemInstanceKey: "item-1",
        latestIsCurrent: true,
        latestItemInstanceKey: "item-2",
      }),
    ).toBe(false);
  });

  test("rejects a superseded read of the same message", () => {
    expect(
      isLatestSnapshotForSave({
        initialItemInstanceKey: "item-1",
        latestIsCurrent: false,
        latestItemInstanceKey: "item-1",
      }),
    ).toBe(false);
  });

  test("accepts only the current read of the original message", () => {
    expect(
      isLatestSnapshotForSave({
        initialItemInstanceKey: "item-1",
        latestIsCurrent: true,
        latestItemInstanceKey: "item-1",
      }),
    ).toBe(true);
  });

  test("does not attribute a pending upload to another message", () => {
    const pending = {
      sourceItemInstanceKey: "item-1",
    };

    expect(pendingUploadMatchesSnapshot(pending, "item-2")).toBe(false);
    expect(pendingUploadMatchesSnapshot(pending, "item-1")).toBe(true);
  });
});
