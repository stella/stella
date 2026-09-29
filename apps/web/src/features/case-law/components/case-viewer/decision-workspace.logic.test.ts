import { describe, expect, test } from "bun:test";

import { resolveVisitorOffer } from "@/features/case-law/components/case-viewer/decision-workspace.logic";

const onRequest = () => undefined;

describe("the visitor's analysis offer", () => {
  test("is withdrawn with the AI notes under the 'mine' filter", () => {
    expect(
      resolveVisitorOffer({
        analysisStatus: "idle",
        notesFilter: "mine",
        onRequest,
      }),
    ).toBeUndefined();
  });

  test("stands while the AI notes are shown and nothing has run", () => {
    for (const notesFilter of ["all", "ai"] as const) {
      expect(
        resolveVisitorOffer({ analysisStatus: "idle", notesFilter, onRequest }),
      ).toBe(onRequest);
    }
  });

  test("gives way once an analysis exists or is under way", () => {
    for (const analysisStatus of ["generating", "done", "error"] as const) {
      expect(
        resolveVisitorOffer({ analysisStatus, notesFilter: "all", onRequest }),
      ).toBeUndefined();
    }
  });
});
