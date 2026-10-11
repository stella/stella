import type { Document, RunContent } from "@stll/docx-core/model";

type VisibleRunCases = {
  [Kind in RunContent["type"]]: {
    item: RunContent & { type: Kind };
    text: string;
  };
};

/** Total over the producer union: a new run kind requires a visibility decision. */
export const VISIBLE_RUN_CASES = {
  text: { item: { type: "text", text: "Visible" }, text: "Visible" },
  tab: { item: { type: "tab" }, text: "\t" },
  break: { item: { type: "break" }, text: "\n" },
  symbol: {
    item: { type: "symbol", font: "Symbol", char: "03A9" },
    text: "\u03a9",
  },
  footnoteRef: { item: { type: "footnoteRef", id: 1 }, text: "" },
  endnoteRef: { item: { type: "endnoteRef", id: 1 }, text: "" },
  noteMarker: { item: { type: "noteMarker", kind: "footnote" }, text: "" },
  fieldChar: { item: { type: "fieldChar", charType: "begin" }, text: "" },
  instrText: {
    item: { type: "instrText", text: "HIDDEN INSTRUCTION" },
    text: "",
  },
  softHyphen: { item: { type: "softHyphen" }, text: "" },
  noBreakHyphen: { item: { type: "noBreakHyphen" }, text: "\u2011" },
  renderedPageBreak: { item: { type: "renderedPageBreak" }, text: "" },
  preservedXml: {
    item: { type: "preservedXml", xml: "<w:ruby/>", text: "Visible" },
    text: "Visible",
  },
  drawing: {
    item: {
      type: "drawing",
      image: {
        type: "image",
        size: { width: 1, height: 1 },
        wrap: { type: "inline" },
      },
    },
    text: "",
  },
  shape: {
    item: {
      type: "shape",
      shape: {
        type: "shape",
        shapeType: "rect",
        size: { width: 1, height: 1 },
      },
    },
    text: "",
  },
} as const satisfies VisibleRunCases;

export const visibleRunDocument = (item: RunContent): Document => ({
  package: {
    document: {
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "run",
              content: [
                { type: "text", text: "word" },
                item,
                { type: "text", text: "word" },
              ],
            },
          ],
        },
      ],
    },
    footnotes: [{ type: "footnote", id: 1, content: [] }],
  },
});

export const VISIBLE_FIELD_DOCUMENT = {
  package: {
    document: {
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "complexField",
              instruction: "HIDDEN INSTRUCTION",
              fieldType: "UNKNOWN",
              fieldCode: [
                {
                  type: "run",
                  content: [{ type: "instrText", text: "HIDDEN INSTRUCTION" }],
                },
              ],
              fieldResult: [
                {
                  type: "run",
                  content: [
                    { type: "text", text: "word" },
                    { type: "noBreakHyphen" },
                    { type: "text", text: "word" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  },
} satisfies Document;
