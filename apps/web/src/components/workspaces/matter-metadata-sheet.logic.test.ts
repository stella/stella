import { describe, expect, it } from "bun:test";

import { resolveReferenceEdit } from "@/components/workspaces/matter-metadata-sheet.logic";

describe("resolving a matter reference edit", () => {
  it("discards an edit that only changes surrounding whitespace", () => {
    expect(
      resolveReferenceEdit({
        currentReference: "2026/001",
        nextReference: "  2026/001  ",
        stampedVersionCount: 4,
      }),
    ).toEqual({ type: "discard" });
  });

  it("discards an emptied field instead of clearing the reference", () => {
    expect(
      resolveReferenceEdit({
        currentReference: "2026/001",
        nextReference: "   ",
        stampedVersionCount: 0,
      }),
    ).toEqual({ type: "discard" });
  });

  it("saves a new reference directly while no version carries a stamp", () => {
    expect(
      resolveReferenceEdit({
        currentReference: "2026/001",
        nextReference: " 2026/002 ",
        stampedVersionCount: 0,
      }),
    ).toEqual({ type: "save", reference: "2026/002" });
  });

  it("confirms a new reference once a single version carries a stamp", () => {
    expect(
      resolveReferenceEdit({
        currentReference: "2026/001",
        nextReference: "2026/002",
        stampedVersionCount: 1,
      }),
    ).toEqual({ type: "confirm", reference: "2026/002" });
  });
});
