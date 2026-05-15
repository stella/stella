import { describe, expect, test } from "bun:test";

import type { SelectionState } from "../core/prosemirror";
import {
  buildSelectionFormatting,
  extractListState,
} from "./selectionFormattingBuilder";

function makeSelection(
  textFormatting: Partial<SelectionState["textFormatting"]> = {},
  paragraphFormatting: Partial<SelectionState["paragraphFormatting"]> = {},
  styleId: string | null = null,
): SelectionState {
  return {
    hasSelection: false,
    isMultiParagraph: false,
    textFormatting,
    paragraphFormatting,
    styleId,
    startParagraphIndex: 0,
    endParagraphIndex: 0,
  };
}

describe("extractListState", () => {
  test("returns undefined when the paragraph is not in a list", () => {
    expect(extractListState(undefined)).toBeUndefined();
  });

  test("treats numId === 1 as a bullet list", () => {
    expect(extractListState({ numId: 1, ilvl: 2 })).toEqual({
      type: "bullet",
      level: 2,
      isInList: true,
      numId: 1,
    });
  });

  test("treats any other numId as a numbered list", () => {
    expect(extractListState({ numId: 7 })).toEqual({
      type: "numbered",
      level: 0,
      isInList: true,
      numId: 7,
    });
  });

  test("omits numId from the result when it is absent from numPr", () => {
    expect(extractListState({ ilvl: 1 })).toEqual({
      type: "numbered",
      level: 1,
      isInList: true,
    });
  });
});

describe("buildSelectionFormatting", () => {
  test("emits the always-present derived booleans", () => {
    const formatting = buildSelectionFormatting({
      selectionState: makeSelection(),
      fontFamily: undefined,
      fontSize: undefined,
      textColor: undefined,
      listState: undefined,
    });
    expect(formatting).toEqual({
      underline: false,
      superscript: false,
      subscript: false,
      bidi: false,
    });
  });

  test("derives superscript / subscript from vertAlign", () => {
    expect(
      buildSelectionFormatting({
        selectionState: makeSelection({ vertAlign: "superscript" }),
        fontFamily: undefined,
        fontSize: undefined,
        textColor: undefined,
        listState: undefined,
      }).superscript,
    ).toBe(true);
    expect(
      buildSelectionFormatting({
        selectionState: makeSelection({ vertAlign: "subscript" }),
        fontFamily: undefined,
        fontSize: undefined,
        textColor: undefined,
        listState: undefined,
      }).subscript,
    ).toBe(true);
  });

  test("copies optional fields only when their source is defined", () => {
    const formatting = buildSelectionFormatting({
      selectionState: makeSelection(
        { bold: true, italic: false },
        { alignment: "center" },
      ),
      fontFamily: undefined,
      fontSize: undefined,
      textColor: undefined,
      listState: undefined,
    });
    expect(formatting.bold).toBe(true);
    expect(formatting.italic).toBe(false);
    expect(formatting.alignment).toBe("center");
    // Fields whose sources were `undefined` must be absent (not `undefined`)
    // so the prop shape stays compatible with exactOptionalPropertyTypes.
    expect("strike" in formatting).toBe(false);
    expect("fontFamily" in formatting).toBe(false);
    expect("fontSize" in formatting).toBe(false);
  });

  test("passes through resolved font / color / list state", () => {
    const formatting = buildSelectionFormatting({
      selectionState: makeSelection(),
      fontFamily: "Arimo",
      fontSize: 22,
      textColor: "var(--test-color)",
      listState: { type: "bullet", level: 0, isInList: true, numId: 1 },
    });
    expect(formatting.fontFamily).toBe("Arimo");
    expect(formatting.fontSize).toBe(22);
    expect(formatting.color).toBe("var(--test-color)");
    expect(formatting.listState).toEqual({
      type: "bullet",
      level: 0,
      isInList: true,
      numId: 1,
    });
  });

  test("copies the paragraph styleId for any non-null source value", () => {
    expect(
      buildSelectionFormatting({
        selectionState: makeSelection({}, {}, "Heading1"),
        fontFamily: undefined,
        fontSize: undefined,
        textColor: undefined,
        listState: undefined,
      }).styleId,
    ).toBe("Heading1");
    // Empty string is technically permitted by `SelectionState.styleId`
    // (`string | null`) and must be passed through — only `null` means
    // "no paragraph style".
    expect(
      buildSelectionFormatting({
        selectionState: makeSelection({}, {}, ""),
        fontFamily: undefined,
        fontSize: undefined,
        textColor: undefined,
        listState: undefined,
      }).styleId,
    ).toBe("");
    // `null` styleId must not appear on the result.
    expect(
      "styleId" in
        buildSelectionFormatting({
          selectionState: makeSelection({}, {}, null),
          fontFamily: undefined,
          fontSize: undefined,
          textColor: undefined,
          listState: undefined,
        }),
    ).toBe(false);
  });
});
