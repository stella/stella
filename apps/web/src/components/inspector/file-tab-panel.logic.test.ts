import { describe, expect, test } from "bun:test";

import { getMarkdownDraftSyncDecision } from "./file-tab-panel.logic";

describe("markdown draft sync", () => {
  test("does not replace a dirty draft on same-field refetch", () => {
    expect(
      getMarkdownDraftSyncDecision({
        fieldId: "field-1",
        isDirty: true,
        isMarkdownDisplay: true,
        lastSyncedFieldId: "field-1",
        serverText: "server text",
      }),
    ).toEqual({ type: "skip" });
  });

  test("initializes and resets mode when the field changes", () => {
    expect(
      getMarkdownDraftSyncDecision({
        fieldId: "field-2",
        isDirty: true,
        isMarkdownDisplay: true,
        lastSyncedFieldId: "field-1",
        serverText: "new field text",
      }),
    ).toEqual({
      fieldId: "field-2",
      resetMode: true,
      text: "new field text",
      type: "sync",
    });
  });

  test("refreshes a clean same-field draft without forcing preview mode", () => {
    expect(
      getMarkdownDraftSyncDecision({
        fieldId: "field-1",
        isDirty: false,
        isMarkdownDisplay: true,
        lastSyncedFieldId: "field-1",
        serverText: "fresh server text",
      }),
    ).toEqual({
      fieldId: "field-1",
      resetMode: false,
      text: "fresh server text",
      type: "sync",
    });
  });
});
