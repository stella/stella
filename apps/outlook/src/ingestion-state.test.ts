import { describe, expect, test } from "bun:test";

import {
  ingestTransitionTargets,
  type IngestStateType,
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
