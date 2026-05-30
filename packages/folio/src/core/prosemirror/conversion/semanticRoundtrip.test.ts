import { describe, expect, test } from "bun:test";

import type {
  Document,
  MathEquation,
  Paragraph,
  Run,
  ShapeContent,
  SimpleField,
  InlineSdt,
} from "../../types/document";
import { pixelsToEmu } from "../../utils/units";
import { validateProseMirrorDocument } from "../validation";
import { fromProseDoc } from "./fromProseDoc";
import { toProseDoc } from "./toProseDoc";

const runText = (text: string, formatting?: Run["formatting"]): Run => {
  const run: Run = {
    type: "run",
    content: [{ type: "text", text }],
  };
  if (formatting) {
    run.formatting = formatting;
  }
  return run;
};

const firstParagraph = (document: Document): Paragraph => {
  const block = document.package.document.content.at(0);
  if (block?.type !== "paragraph") {
    throw new Error("Expected first block to be a paragraph");
  }
  return block;
};

const paragraphAt = (document: Document, index: number): Paragraph => {
  const block = document.package.document.content.at(index);
  if (block?.type !== "paragraph") {
    throw new Error(`Expected block ${index} to be a paragraph`);
  }
  return block;
};

const textOfRun = (run: Run): string =>
  run.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("");

const findRunText = (paragraph: Paragraph, text: string): Run => {
  for (const content of paragraph.content) {
    if (content.type === "run" && textOfRun(content) === text) {
      return content;
    }
  }
  throw new Error(`Expected run text ${text}`);
};

const findSimpleField = (paragraph: Paragraph): SimpleField => {
  const field = paragraph.content.find(
    (content): content is SimpleField => content.type === "simpleField",
  );
  if (!field) {
    throw new Error("Expected simple field");
  }
  return field;
};

const findInlineSdt = (paragraph: Paragraph): InlineSdt => {
  const sdt = paragraph.content.find(
    (content): content is InlineSdt => content.type === "inlineSdt",
  );
  if (!sdt) {
    throw new Error("Expected inline SDT");
  }
  return sdt;
};

const findMathEquation = (paragraph: Paragraph): MathEquation => {
  const math = paragraph.content.find(
    (content): content is MathEquation => content.type === "mathEquation",
  );
  if (!math) {
    throw new Error("Expected math equation");
  }
  return math;
};

const firstShapeContent = (paragraph: Paragraph): ShapeContent => {
  for (const content of paragraph.content) {
    if (content.type !== "run") {
      continue;
    }
    const shape = content.content.find(
      (runContent): runContent is ShapeContent => runContent.type === "shape",
    );
    if (shape) {
      return shape;
    }
  }
  throw new Error("Expected shape content");
};

const buildSemanticFixture = (): Document => ({
  package: {
    document: {
      content: [
        {
          type: "paragraph",
          content: [
            { type: "commentRangeStart", id: 7 },
            runText("Clause ", {
              bold: true,
              color: { rgb: "C00000" },
              highlight: "yellow",
            }),
            {
              type: "simpleField",
              instruction: " PAGE ",
              fieldType: "PAGE",
              content: [runText("1", { italic: true })],
            },
            {
              type: "inlineSdt",
              properties: {
                sdtType: "dropdown",
                alias: "Party choice",
                tag: "party",
                listItems: [{ displayText: "Acme", value: "acme" }],
              },
              content: [runText("Acme")],
            },
            {
              type: "mathEquation",
              display: "inline",
              ommlXml: "<m:oMath />",
              plainText: "x=1",
            },
            {
              type: "run",
              content: [
                {
                  type: "shape",
                  shape: {
                    type: "shape",
                    shapeType: "rect",
                    id: "shape-1",
                    size: {
                      width: pixelsToEmu(80),
                      height: pixelsToEmu(40),
                    },
                    fill: {
                      type: "solid",
                      color: { rgb: "FFAA00" },
                    },
                    outline: {
                      width: pixelsToEmu(1),
                      style: "solid",
                      cap: "round",
                      color: { rgb: "000000" },
                    },
                    wrap: {
                      type: "square",
                      wrapText: "bothSides",
                      distT: pixelsToEmu(3),
                      distB: pixelsToEmu(4),
                      distL: pixelsToEmu(5),
                      distR: pixelsToEmu(6),
                    },
                    position: {
                      horizontal: {
                        relativeTo: "column",
                        posOffset: 100_000,
                      },
                      vertical: {
                        relativeTo: "paragraph",
                        posOffset: 200_000,
                      },
                    },
                  },
                },
              ],
            },
            { type: "commentRangeEnd", id: 7 },
          ],
        },
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
                    shapeType: "rect",
                    id: "text-box-1",
                    size: {
                      width: pixelsToEmu(220),
                      height: pixelsToEmu(90),
                    },
                    fill: {
                      type: "solid",
                      color: { rgb: "FFFFFF" },
                    },
                    textBody: {
                      margins: {
                        top: pixelsToEmu(4),
                        bottom: pixelsToEmu(4),
                        left: pixelsToEmu(7),
                        right: pixelsToEmu(7),
                      },
                      content: [
                        {
                          type: "paragraph",
                          content: [runText("Inside text box")],
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
});

describe("semantic ProseMirror round-trip fixture", () => {
  test("preserves canonical inline and drawing semantics", () => {
    const document = buildSemanticFixture();
    const pmDoc = toProseDoc(document);
    const pmValidation = validateProseMirrorDocument(pmDoc);
    const roundtripped = fromProseDoc(pmDoc, document);
    const paragraph = firstParagraph(roundtripped);

    expect(pmValidation.valid).toBe(true);
    // The shape now carries marks (eigenpal #641 — `Shape.nodeSpec.marks = "_"`
    // so a tracked or commented shape survives the round-trip), so the
    // comment range correctly re-opens around the shape-bearing run too. The
    // mid-paragraph atom inserts split it from `mathEquation`.
    expect(paragraph.content.map((content) => content.type)).toEqual([
      "commentRangeStart",
      "run",
      "commentRangeEnd",
      "simpleField",
      "commentRangeStart",
      "inlineSdt",
      "commentRangeEnd",
      "mathEquation",
      "commentRangeStart",
      "run",
      "commentRangeEnd",
    ]);
    expect(findRunText(paragraph, "Clause ").formatting).toMatchObject({
      bold: true,
      color: { rgb: "C00000" },
      highlight: "yellow",
    });
    expect(findSimpleField(paragraph)).toMatchObject({
      instruction: " PAGE ",
      fieldType: "PAGE",
    });
    expect(findInlineSdt(paragraph).properties).toMatchObject({
      sdtType: "dropdown",
      alias: "Party choice",
      tag: "party",
      listItems: [{ displayText: "Acme", value: "acme" }],
    });
    expect(findMathEquation(paragraph)).toMatchObject({
      display: "inline",
      ommlXml: "<m:oMath />",
      plainText: "x=1",
    });
    expect(firstShapeContent(paragraph).shape).toMatchObject({
      type: "shape",
      shapeType: "rect",
      id: "shape-1",
      fill: { type: "solid", color: { rgb: "FFAA00" } },
      outline: { cap: "round" },
      wrap: {
        type: "square",
        wrapText: "bothSides",
        distT: pixelsToEmu(3),
        distB: pixelsToEmu(4),
        distL: pixelsToEmu(5),
        distR: pixelsToEmu(6),
      },
      position: {
        horizontal: { relativeTo: "column", posOffset: 100_000 },
        vertical: { relativeTo: "paragraph", posOffset: 200_000 },
      },
    });

    const textBoxShape = firstShapeContent(paragraphAt(roundtripped, 1)).shape;
    expect(textBoxShape).toMatchObject({
      type: "shape",
      shapeType: "textBox",
      id: "text-box-1",
      textBody: {
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "run",
                content: [{ type: "text", text: "Inside text box" }],
              },
            ],
          },
        ],
      },
    });
  });
});
