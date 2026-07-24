import { describe, expect, test } from "bun:test";

import { hasUnsavedEditorChanges } from "@/routes/_protected.knowledge/-components/template-studio-dirty";

describe("Template Studio document dirty state", () => {
  test("reconciles a delayed editor notification against the current save state", () => {
    let hasPendingChanges = true;
    const editor = {
      hasPendingChanges: () => hasPendingChanges,
    };

    expect(hasUnsavedEditorChanges(editor)).toBe(true);

    // Folio debounces onChange. A notification queued by the edit can arrive
    // after save has serialized the document and cleared its change markers.
    hasPendingChanges = false;
    expect(hasUnsavedEditorChanges(editor)).toBe(false);
  });

  test("does not treat editor initialization as an unsaved edit", () => {
    expect(hasUnsavedEditorChanges(null)).toBe(false);
  });
});
