import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resetCanvasContext } from "../layout-engine/measure/measureContainer";
import type { Layout, Measure, ParagraphBlock } from "../layout-engine/types";
import { getCaretPosition } from "./selectionRects";

const originalDocument = globalThis.document;

beforeEach(() => {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement(tagName: string) {
        if (tagName !== "canvas") {
          return {};
        }
        return {
          getContext() {
            return {
              font: "",
              measureText(text: string) {
                return { width: text.length * 7 };
              },
            };
          },
        };
      },
    },
  });
  resetCanvasContext();
});

afterEach(() => {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: originalDocument,
  });
  resetCanvasContext();
});

describe("selection rect geometry", () => {
  test("caret positions advance over atomic math runs", () => {
    const block: ParagraphBlock = {
      kind: "paragraph",
      id: "p1",
      pmStart: 0,
      pmEnd: 5,
      runs: [
        {
          kind: "math",
          display: "inline",
          ommlXml: "<m:oMath />",
          plainText: "xx",
          fontFamily: "Cambria Math",
          fontSize: 11,
          pmStart: 1,
          pmEnd: 2,
        },
        {
          kind: "text",
          text: "abc",
          fontFamily: "Calibri",
          fontSize: 11,
          pmStart: 2,
          pmEnd: 5,
        },
      ],
    };
    const measures: Measure[] = [
      {
        kind: "paragraph",
        lines: [
          {
            fromRun: 0,
            toRun: 1,
            fromChar: 0,
            toChar: 3,
            width: 35,
            lineHeight: 16,
            ascent: 12,
            descent: 4,
          },
        ],
        width: 35,
        height: 16,
      },
    ];
    const layout: Layout = {
      pageGap: 0,
      pages: [
        {
          number: 1,
          size: { w: 600, h: 800 },
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          fragments: [
            {
              kind: "paragraph",
              blockId: "p1",
              x: 0,
              y: 0,
              width: 500,
              height: 16,
              fromLine: 0,
              toLine: 1,
            },
          ],
        },
      ],
    };

    const caret = getCaretPosition(layout, [block], measures, 2);

    expect(caret?.x).toBe(14);
  });
});
