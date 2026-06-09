import { describe, expect, test } from "bun:test";

import type {
  FieldRun,
  FlowBlock,
  ParagraphBlock,
  TextBoxBlock,
  TextRun,
} from "../layout-engine/types";
import { buildBookmarkText } from "./bookmarkText";

const text = (value: string): TextRun => ({ kind: "text", text: value });

const para = (
  id: string,
  runs: (TextRun | FieldRun)[],
  bookmarks?: string[],
): ParagraphBlock => ({
  kind: "paragraph",
  id,
  runs,
  ...(bookmarks ? { bookmarks } : {}),
});

describe("buildBookmarkText", () => {
  test("maps each bookmark to its paragraph's trimmed text", () => {
    const blocks: FlowBlock[] = [
      para("h1", [text("  Section 1. Definitions  ")], ["_Ref1"]),
      para("body", [text("ignored")]),
      para("h2", [text("Schedule A")], ["_Ref2", "_Alt"]),
    ];

    const map = buildBookmarkText(blocks);

    expect(map.get("_Ref1")).toBe("Section 1. Definitions");
    expect(map.get("_Ref2")).toBe("Schedule A");
    expect(map.get("_Alt")).toBe("Schedule A");
    expect(map.size).toBe(3);
  });

  test("includes cached field results in paragraph text", () => {
    const field: FieldRun = {
      kind: "field",
      fieldType: "OTHER",
      instruction: "SEQ Figure",
      fallback: "1",
    };
    const blocks: FlowBlock[] = [
      para("h", [text("Figure "), field, text(": Caption")], ["_Ref1"]),
    ];

    expect(buildBookmarkText(blocks).get("_Ref1")).toBe("Figure 1: Caption");
  });

  test("includes live field results in paragraph text", () => {
    const field: FieldRun = {
      kind: "field",
      fieldType: "OTHER",
      instruction: "SEQ Figure \\* ROMAN",
      fallback: "I",
      pmStart: 12,
    };
    const blocks: FlowBlock[] = [
      para("h", [text("Figure "), field, text(": Caption")], ["_Ref1"]),
    ];

    expect(
      buildBookmarkText(blocks, { seqValues: new Map([[12, 4]]) }).get("_Ref1"),
    ).toBe("Figure IV: Caption");
    expect(
      buildBookmarkText(blocks, {
        fieldValues: new Map([[12, "V"]]),
        seqValues: new Map([[12, 4]]),
      }).get("_Ref1"),
    ).toBe("Figure V: Caption");
  });

  test("includes visible list markers in paragraph text", () => {
    const blocks: FlowBlock[] = [
      {
        ...para("h", [text("Definitions")], ["_Heading"]),
        attrs: { listMarker: "1." },
      },
      {
        ...para("hidden", [text("Hidden marker")], ["_Hidden"]),
        attrs: { listMarker: "2.", listMarkerHidden: true },
      },
      {
        ...para("tight", [text("No space")], ["_Tight"]),
        attrs: { listMarker: "3.", listMarkerSuffix: "nothing" },
      },
    ];

    const map = buildBookmarkText(blocks);

    expect(map.get("_Heading")).toBe("1. Definitions");
    expect(map.get("_Hidden")).toBe("Hidden marker");
    expect(map.get("_Tight")).toBe("3.No space");
  });

  test("maps bookmarks inside text boxes", () => {
    const textBox: TextBoxBlock = {
      kind: "textBox",
      id: "box",
      width: 240,
      content: [para("inside", [text("Inside shape")], ["_ShapeRef"])],
    };

    expect(buildBookmarkText([textBox]).get("_ShapeRef")).toBe("Inside shape");
  });

  test("returns empty when no paragraph carries a bookmark", () => {
    const blocks: FlowBlock[] = [para("a", [text("x")])];
    expect(buildBookmarkText(blocks).size).toBe(0);
  });
});
