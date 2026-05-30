import { describe, expect, test } from "bun:test";
import { Schema } from "prosemirror-model";

import type { ParagraphBlock, TextRun } from "../layout-engine/types";
import { toFlowBlocks } from "./toFlowBlocks";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: {
      content: "inline*",
      group: "block",
      attrs: {
        styleId: { default: null },
        defaultTextFormatting: { default: null },
      },
    },
    text: { group: "inline" },
  },
  marks: {
    allCaps: {},
    smallCaps: {},
    emboss: {},
    imprint: {},
    hidden: {},
    textShadow: {},
    textOutline: {},
    emphasisMark: {
      attrs: { type: { default: "dot" } },
    },
    characterSpacing: {
      attrs: {
        spacing: { default: null },
        position: { default: null },
        scale: { default: null },
        kerning: { default: null },
      },
    },
    textColor: {
      attrs: {
        rgb: { default: null },
        themeColor: { default: null },
        themeTint: { default: null },
        themeShade: { default: null },
      },
    },
    highlight: {
      attrs: { color: {} },
    },
    rtl: {},
    textEffect: {
      attrs: { effect: {} },
    },
  },
});

function buildSingleRunDoc(
  text: string,
  markName: string,
  attrs?: Record<string, unknown>,
) {
  const mark = schema.marks[markName]?.create(attrs);
  if (!mark) {
    throw new Error(`Unknown mark: ${markName}`);
  }
  return schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text(text, [mark])]),
  ]);
}

function firstRun(blocks: unknown[]): TextRun {
  const paragraph = blocks.find(
    (block) => (block as { kind?: string }).kind === "paragraph",
  ) as ParagraphBlock;
  return paragraph.runs[0] as TextRun;
}

describe("toFlowBlocks run-level OOXML marks", () => {
  test("propagates caps and text effect marks to run formatting", () => {
    for (const markName of [
      "allCaps",
      "smallCaps",
      "emboss",
      "imprint",
      "textShadow",
      "textOutline",
    ] as const) {
      const blocks = toFlowBlocks(buildSingleRunDoc("text", markName), {});
      expect(firstRun(blocks)[markName]).toBe(true);
    }
  });

  // eigenpal #424 (w:vanish gap 9): the `hidden` PM mark must surface as
  // RunFormatting.hidden so the painter applies the dimmed dotted-underline
  // treatment for the editing view.
  test("propagates the hidden mark (w:vanish) to RunFormatting.hidden", () => {
    const blocks = toFlowBlocks(buildSingleRunDoc("text", "hidden"), {});
    expect(firstRun(blocks).hidden).toBe(true);
  });

  test("propagates character spacing position, scale, and kerning", () => {
    const blocks = toFlowBlocks(
      buildSingleRunDoc("text", "characterSpacing", {
        spacing: 16,
        position: 12,
        scale: 90,
        kerning: 16,
      }),
      {},
    );
    const run = firstRun(blocks);

    expect(run.letterSpacing).toBeCloseTo(1.0667, 3);
    expect(run.positionPx).toBeCloseTo(8, 3);
    expect(run.horizontalScale).toBe(90);
    expect(run.kerningMinPt).toBe(8);
  });

  test("does not emit no-op character spacing values", () => {
    const blocks = toFlowBlocks(
      buildSingleRunDoc("text", "characterSpacing", {
        spacing: 0,
        position: 0,
        scale: 100,
        kerning: 0,
      }),
      {},
    );
    const run = firstRun(blocks);

    expect(run.letterSpacing).toBeUndefined();
    expect(run.positionPx).toBeUndefined();
    expect(run.horizontalScale).toBeUndefined();
    expect(run.kerningMinPt).toBeUndefined();
  });

  test("propagates rtl mark to run formatting", () => {
    // eigenpal #424 (gap 10) — the painter needs `rtl` on the flow run to
    // emit `dir="rtl"`; without this case the PM mark would survive the
    // ProseMirror round-trip but mixed RTL runs would still paint LTR.
    const blocks = toFlowBlocks(buildSingleRunDoc("שלום", "rtl"), {});
    expect(firstRun(blocks).rtl).toBe(true);
  });

  test("propagates textEffect mark to run formatting", () => {
    // eigenpal #424 (gap 11) — host CSS keys off `docx-text-effect-<name>`;
    // the painter only emits those classes when the flow run carries the
    // effect value.
    const blocks = toFlowBlocks(
      buildSingleRunDoc("animated", "textEffect", { effect: "shimmer" }),
      {},
    );
    expect(firstRun(blocks).textEffect).toBe("shimmer");
  });

  test("propagates emphasis mark variants", () => {
    for (const variant of ["dot", "comma", "circle", "underDot"] as const) {
      const blocks = toFlowBlocks(
        buildSingleRunDoc("text", "emphasisMark", { type: variant }),
        {},
      );
      expect(firstRun(blocks).emphasisMark).toBe(variant);
    }
  });

  test("cascades paragraph default text formatting to unmarked runs", () => {
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        {
          defaultTextFormatting: {
            fontFamily: { ascii: "Arial Narrow", hAnsi: "Arial Narrow" },
            fontSize: 22,
            bold: true,
            color: { rgb: "C00000" },
            underline: { style: "single" },
            smallCaps: true,
          },
        },
        [schema.text("body text")],
      ),
    ]);
    const run = firstRun(toFlowBlocks(doc, {}));

    expect(run.fontFamily).toBe("Arial Narrow");
    expect(run.fontSize).toBe(11);
    expect(run.bold).toBe(true);
    expect(run.color).toBe("#C00000");
    expect(run.textColorSource).toBe("paragraphDefault");
    expect(run.underline).toEqual({ style: "single" });
    expect(run.smallCaps).toBe(true);
  });

  test("keeps inherited paragraph default black identifiable on highlighted runs", () => {
    const highlight = schema.marks.highlight.create({ color: "darkBlue" });
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        {
          defaultTextFormatting: {
            color: { rgb: "000000" },
            highlight: "darkBlue",
          },
        },
        [schema.text("body text", [highlight])],
      ),
    ]);
    const run = firstRun(toFlowBlocks(doc, {}));

    expect(run.color).toBe("#000000");
    expect(run.textColorSource).toBe("paragraphDefault");
    expect(run.highlight).toBe("#00008B");
  });

  test("keeps direct black text colors marked as direct when paragraph default is also black", () => {
    const textColor = schema.marks.textColor.create({ rgb: "000000" });
    const highlight = schema.marks.highlight.create({ color: "darkBlue" });
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        {
          defaultTextFormatting: {
            color: { rgb: "000000" },
          },
        },
        [schema.text("body text", [textColor, highlight])],
      ),
    ]);
    const run = firstRun(toFlowBlocks(doc, {}));

    expect(run.color).toBe("#000000");
    expect(run.textColorSource).toBe("direct");
    expect(run.highlight).toBe("#00008B");
  });

  test("keeps distinguishable direct black text colors marked as direct", () => {
    const textColor = schema.marks.textColor.create({ rgb: "000000" });
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        {
          defaultTextFormatting: {
            color: { rgb: "C00000" },
          },
        },
        [schema.text("body text", [textColor])],
      ),
    ]);
    const run = firstRun(toFlowBlocks(doc, {}));

    expect(run.color).toBe("#000000");
    expect(run.textColorSource).toBe("direct");
  });

  test("omits automatic paragraph default text colors from runs", () => {
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        {
          defaultTextFormatting: {
            color: { auto: true },
            highlight: "darkBlue",
          },
        },
        [schema.text("body text")],
      ),
    ]);
    const run = firstRun(toFlowBlocks(doc, {}));

    expect(run.color).toBeUndefined();
    expect(run.highlight).toBe("#00008B");
  });
});
