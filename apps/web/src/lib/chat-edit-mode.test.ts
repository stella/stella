import { describe, expect, test } from "bun:test";

import {
  CHAT_EDIT_APPLY_MODE,
  CHAT_EDIT_MODE_OPTION_ID,
  chatEditModeSelectionForOptionId,
  docxEditRepresentationForSelection,
  DOCX_EDIT_REPRESENTATION,
  isChatEditModeOptionId,
  resolveActiveDocxEditModeState,
} from "@/lib/chat-edit-mode";

describe("chatEditModeSelectionForOptionId", () => {
  test("maps 'auto · track changes' to the auto/tracked-changes body fields", () => {
    const selection = chatEditModeSelectionForOptionId(
      CHAT_EDIT_MODE_OPTION_ID.autoTrackedChanges,
    );
    expect(selection.editApplyMode).toBe(CHAT_EDIT_APPLY_MODE.auto);
    expect(docxEditRepresentationForSelection(selection)).toBe(
      DOCX_EDIT_REPRESENTATION.trackedChanges,
    );
  });

  test("maps 'auto · rewrite' to the auto/direct body fields", () => {
    const selection = chatEditModeSelectionForOptionId(
      CHAT_EDIT_MODE_OPTION_ID.autoDirect,
    );
    expect(selection.editApplyMode).toBe(CHAT_EDIT_APPLY_MODE.auto);
    expect(docxEditRepresentationForSelection(selection)).toBe(
      DOCX_EDIT_REPRESENTATION.direct,
    );
  });

  test("maps 'manual review' to manual with no representation field", () => {
    const selection = chatEditModeSelectionForOptionId(
      CHAT_EDIT_MODE_OPTION_ID.manual,
    );
    expect(selection.editApplyMode).toBe(CHAT_EDIT_APPLY_MODE.manual);
    expect(docxEditRepresentationForSelection(selection)).toBeUndefined();
  });
});

describe("isChatEditModeOptionId", () => {
  test("accepts every known option id", () => {
    expect(
      isChatEditModeOptionId(CHAT_EDIT_MODE_OPTION_ID.autoTrackedChanges),
    ).toBe(true);
    expect(isChatEditModeOptionId(CHAT_EDIT_MODE_OPTION_ID.autoDirect)).toBe(
      true,
    );
    expect(isChatEditModeOptionId(CHAT_EDIT_MODE_OPTION_ID.manual)).toBe(true);
  });

  test("rejects unknown values (e.g. a legacy or corrupted persisted value)", () => {
    expect(isChatEditModeOptionId("suggested")).toBe(false);
    expect(isChatEditModeOptionId(undefined)).toBe(false);
    expect(isChatEditModeOptionId(null)).toBe(false);
  });
});

describe("resolveActiveDocxEditModeState", () => {
  const autoSelection = chatEditModeSelectionForOptionId(
    CHAT_EDIT_MODE_OPTION_ID.autoTrackedChanges,
  );

  test("keeps the selected auto mode for a locked current document", () => {
    expect(
      resolveActiveDocxEditModeState({
        activeFileEditable: true,
        docxEditable: false,
        hasDocxEditSurface: true,
        selection: autoSelection,
      }),
    ).toEqual({ type: "selectable", selection: autoSelection });
  });

  test("forces manual review while the live editor can contain unsaved bytes", () => {
    expect(
      resolveActiveDocxEditModeState({
        activeFileEditable: true,
        docxEditable: true,
        hasDocxEditSurface: true,
        selection: autoSelection,
      }),
    ).toEqual({
      type: "manual",
      selection: { editApplyMode: CHAT_EDIT_APPLY_MODE.manual },
    });
  });

  test("disables editing for historical and non-editable documents", () => {
    expect(
      resolveActiveDocxEditModeState({
        activeFileEditable: false,
        docxEditable: false,
        hasDocxEditSurface: true,
        selection: autoSelection,
      }),
    ).toEqual({ type: "unavailable" });
  });
});
