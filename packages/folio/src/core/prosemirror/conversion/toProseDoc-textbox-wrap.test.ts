/**
 * Ensures DOCX-imported text boxes carry their wrap attributes (wrapType,
 * wrapText, dist*, displayMode, cssFloat) into the PM `textBox` node so the
 * page renderer can build floating exclusion rects (eigenpal #474). Without
 * this mapping the imported text box would stay with the schema default
 * `wrapType: 'inline'` and the renderer would never wrap body text around it.
 */

import { describe, expect, test } from "bun:test";

import type { Document } from "../../types/document";
import { toProseDoc } from "./toProseDoc";

type TextBoxAttrs = Record<string, unknown>;

function textBoxAttrsFromImport(args: {
  wrapType:
    | "inline"
    | "square"
    | "tight"
    | "through"
    | "topAndBottom"
    | "behind"
    | "inFront";
  wrapText?: "bothSides" | "left" | "right" | "largest";
  hAlign?: "left" | "right" | "center";
  distTEmu?: number;
  distBEmu?: number;
  distLEmu?: number;
  distREmu?: number;
}): TextBoxAttrs {
  const document: Document = {
    package: {
      document: {
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "run",
                content: [
                  {
                    type: "shape",
                    shape: {
                      type: "shape",
                      shapeType: "textBox",
                      size: { width: 914_400, height: 457_200 },
                      position: {
                        horizontal: {
                          relativeTo: "column",
                          ...(args.hAlign ? { alignment: args.hAlign } : {}),
                        },
                        vertical: { relativeTo: "paragraph" },
                      },
                      wrap: {
                        type: args.wrapType,
                        ...(args.wrapText ? { wrapText: args.wrapText } : {}),
                        ...(args.distTEmu !== undefined
                          ? { distT: args.distTEmu }
                          : {}),
                        ...(args.distBEmu !== undefined
                          ? { distB: args.distBEmu }
                          : {}),
                        ...(args.distLEmu !== undefined
                          ? { distL: args.distLEmu }
                          : {}),
                        ...(args.distREmu !== undefined
                          ? { distR: args.distREmu }
                          : {}),
                      },
                      textBody: {
                        content: [
                          {
                            type: "paragraph",
                            content: [
                              {
                                type: "run",
                                content: [{ type: "text", text: "Body" }],
                              },
                            ],
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  };

  const pmDoc = toProseDoc(document);
  // Standalone text box becomes its own top-level node (the wrapper paragraph
  // is dropped because it contained only the shape).
  const textBoxNode = pmDoc.firstChild;
  if (!textBoxNode || textBoxNode.type.name !== "textBox") {
    throw new Error(
      `Expected first child to be textBox, got ${textBoxNode?.type.name}`,
    );
  }
  return textBoxNode.attrs as TextBoxAttrs;
}

describe("toProseDoc propagates text-box wrap attributes", () => {
  test("wrap='square' + wrapText='right' becomes a left-floating wrap", () => {
    const attrs = textBoxAttrsFromImport({
      wrapType: "square",
      wrapText: "right",
      distLEmu: 114_300, // ~12px at 96dpi
      distREmu: 114_300,
    });

    expect(attrs["wrapType"]).toBe("square");
    expect(attrs["wrapText"]).toBe("right");
    expect(attrs["displayMode"]).toBe("float");
    expect(attrs["cssFloat"]).toBe("left");
    expect(attrs["distLeft"]).toBe(12);
    expect(attrs["distRight"]).toBe(12);
  });

  test("wrap='tight' + wrapText='left' becomes a right-floating wrap", () => {
    const attrs = textBoxAttrsFromImport({
      wrapType: "tight",
      wrapText: "left",
    });

    expect(attrs["wrapType"]).toBe("tight");
    expect(attrs["wrapText"]).toBe("left");
    expect(attrs["displayMode"]).toBe("float");
    expect(attrs["cssFloat"]).toBe("right");
  });

  test("wrap='topAndBottom' becomes a block (no float)", () => {
    const attrs = textBoxAttrsFromImport({ wrapType: "topAndBottom" });

    expect(attrs["wrapType"]).toBe("topAndBottom");
    expect(attrs["displayMode"]).toBe("block");
    expect(attrs["cssFloat"]).toBe("none");
  });

  test("wrap='behind' becomes a float (anchored, paints over text)", () => {
    const attrs = textBoxAttrsFromImport({ wrapType: "behind" });

    expect(attrs["wrapType"]).toBe("behind");
    expect(attrs["displayMode"]).toBe("float");
  });

  test("wrap='inline' stays inline", () => {
    const attrs = textBoxAttrsFromImport({ wrapType: "inline" });

    expect(attrs["wrapType"]).toBe("inline");
    expect(attrs["displayMode"]).toBe("inline");
    expect(attrs["cssFloat"]).toBe("none");
  });

  test("wrap='square' without wrapText falls back to position alignment", () => {
    const attrs = textBoxAttrsFromImport({
      wrapType: "square",
      hAlign: "right",
    });

    expect(attrs["cssFloat"]).toBe("right");
    expect(attrs["displayMode"]).toBe("float");
  });
});
