import { describe, expect, test } from "bun:test";

import type { WorkspaceJustification } from "@/lib/types";
import { selectJustificationByFieldId } from "@/routes/_protected.workspaces/$workspaceId/-store";

const justification = (
  id: string,
  fieldId: string,
): WorkspaceJustification => ({
  id,
  fieldId,
  content: { version: 1, blocks: [] },
  boundingBoxes: null,
  fileFieldIds: [],
});

describe("selectJustificationByFieldId", () => {
  test("returns undefined when the field has no justification", () => {
    const justifications = [justification("j1", "field-a")];
    expect(
      selectJustificationByFieldId(justifications, "field-x"),
    ).toBeUndefined();
    expect(selectJustificationByFieldId([], "field-a")).toBeUndefined();
  });

  test("returns undefined for a null or undefined fieldId", () => {
    const justifications = [justification("j1", "field-a")];
    expect(selectJustificationByFieldId(justifications, null)).toBeUndefined();
    expect(
      selectJustificationByFieldId(justifications, undefined),
    ).toBeUndefined();
  });

  test("returns the exact justification object for a field (referentially stable)", () => {
    const target = justification("j2", "field-b");
    const justifications = [justification("j1", "field-a"), target];

    const first = selectJustificationByFieldId(justifications, "field-b");
    const second = selectJustificationByFieldId(justifications, "field-b");

    // Same object identity across calls is what lets a store selector skip
    // re-rendering when the justification hasn't changed.
    expect(first).toBe(target);
    expect(second).toBe(target);
  });

  test("keeps the first match when a field has duplicate justifications", () => {
    const first = justification("j-old", "field-a");
    const second = justification("j-new", "field-a");
    const justifications = [first, second];

    // Matches the previous `justifications.find(...)`: first in array order wins.
    expect(selectJustificationByFieldId(justifications, "field-a")).toBe(first);
  });

  test("resolves against a fresh array independently of a prior one", () => {
    const before = [justification("j1", "field-a")];
    selectJustificationByFieldId(before, "field-a");

    const renamed = justification("j1", "field-a");
    const after = [renamed];
    // A new array reference must resolve to its own objects, not a stale index.
    expect(selectJustificationByFieldId(after, "field-a")).toBe(renamed);
  });
});
