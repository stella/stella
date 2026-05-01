import { describe, expect, test } from "bun:test";

import { schema } from "../prosemirror/schema";
import { toFlowBlocks } from "./toFlowBlocks";

describe("toFlowBlocks paragraph formatting", () => {
  test("assigns stable block ids for repeated conversions of the same document", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("First paragraph")]),
      schema.node("paragraph", null, [schema.text("Second paragraph")]),
    ]);

    const first = toFlowBlocks(doc).map((block) => block.id);
    const second = toFlowBlocks(doc).map((block) => block.id);

    expect(second).toEqual(first);
  });

  test("does not convert absent paragraph spacing defaults to zero line height", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("First paragraph")]),
    ]);

    const blocks = toFlowBlocks(doc);
    const paragraph = blocks.at(0);

    expect(paragraph?.kind).toBe("paragraph");
    expect(paragraph?.attrs?.spacing).toBeUndefined();
    expect(paragraph?.attrs?.indent).toBeUndefined();
  });

  test("preserves explicit automatic line spacing", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", { lineSpacing: 240, lineSpacingRule: "auto" }, [
        schema.text("First paragraph"),
      ]),
    ]);

    const blocks = toFlowBlocks(doc);
    const paragraph = blocks.at(0);

    expect(paragraph?.kind).toBe("paragraph");
    expect(paragraph?.attrs?.spacing).toEqual({
      line: 1,
      lineRule: "auto",
      lineUnit: "multiplier",
    });
  });
});

describe("toFlowBlocks field handling", () => {
  test("keeps dynamically-rendered field types distinct in layout runs", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.node("field", {
          fieldType: "PAGE",
          instruction: " PAGE ",
          displayText: "1",
          fieldKind: "simple",
        }),
        schema.text(" / "),
        schema.node("field", {
          fieldType: "NUMPAGES",
          instruction: " NUMPAGES ",
          displayText: "5",
          fieldKind: "simple",
        }),
        schema.text(" "),
        schema.node("field", {
          fieldType: "DATE",
          instruction: ' DATE \\@ "d MMMM yyyy" ',
          displayText: "29 April 2026",
          fieldKind: "simple",
        }),
      ]),
    ]);

    const blocks = toFlowBlocks(doc);
    const paragraph = blocks.at(0);

    expect(paragraph?.kind).toBe("paragraph");
    if (paragraph?.kind !== "paragraph") {
      throw new Error("Expected paragraph block");
    }

    expect(paragraph.runs.at(0)).toMatchObject({
      kind: "field",
      fieldType: "PAGE",
      fallback: "1",
    });
    expect(paragraph.runs.at(2)).toMatchObject({
      kind: "field",
      fieldType: "NUMPAGES",
      fallback: "5",
    });
    expect(paragraph.runs.at(4)).toMatchObject({
      kind: "field",
      fieldType: "DATE",
      fallback: "29 April 2026",
    });
  });

  test("preserves cached text for field types that are not recomputed by layout", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.node("field", {
          fieldType: "MERGEFIELD",
          instruction: ' MERGEFIELD "Client Name" \\* MERGEFORMAT ',
          displayText: "Acme s.r.o.",
          fieldKind: "simple",
        }),
        schema.text(" "),
        schema.node("field", {
          fieldType: "REF",
          instruction: " REF _Ref123 \\h ",
          displayText: "Clause 4.2",
          fieldKind: "complex",
        }),
      ]),
    ]);

    const blocks = toFlowBlocks(doc);
    const paragraph = blocks.at(0);

    expect(paragraph?.kind).toBe("paragraph");
    if (paragraph?.kind !== "paragraph") {
      throw new Error("Expected paragraph block");
    }

    expect(paragraph.runs.at(0)).toMatchObject({
      kind: "field",
      fieldType: "OTHER",
      fallback: "Acme s.r.o.",
    });
    expect(paragraph.runs.at(2)).toMatchObject({
      kind: "field",
      fieldType: "OTHER",
      fallback: "Clause 4.2",
    });
  });
});

describe("toFlowBlocks list numbering", () => {
  test("formats numbered markers using the paragraph number format", () => {
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        {
          numPr: { numId: 1, ilvl: 0 },
          listMarker: "%1.",
          listNumFmt: "upperRoman",
        },
        [schema.text("First")],
      ),
      schema.node(
        "paragraph",
        {
          numPr: { numId: 1, ilvl: 0 },
          listMarker: "%1.",
          listNumFmt: "upperRoman",
        },
        [schema.text("Second")],
      ),
    ]);

    const blocks = toFlowBlocks(doc);

    expect(blocks.at(0)?.kind).toBe("paragraph");
    expect(blocks.at(0)?.attrs?.listMarker).toBe("I.");
    expect(blocks.at(1)?.kind).toBe("paragraph");
    expect(blocks.at(1)?.attrs?.listMarker).toBe("II.");
  });

  test("drops unresolved child placeholders with their following punctuation", () => {
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        {
          numPr: { numId: 2, ilvl: 0 },
          listMarker: "%1.%2.",
          listNumFmt: "decimal",
        },
        [schema.text("Parent")],
      ),
    ]);

    const blocks = toFlowBlocks(doc);

    expect(blocks.at(0)?.kind).toBe("paragraph");
    expect(blocks.at(0)?.attrs?.listMarker).toBe("1.");
  });

  test("formats each level in a multi-level marker with its own number format", () => {
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        {
          numPr: { numId: 3, ilvl: 0 },
          listMarker: "%1.",
          listNumFmt: "upperRoman",
          listLevelNumFmts: ["upperRoman"],
        },
        [schema.text("Parent")],
      ),
      schema.node(
        "paragraph",
        {
          numPr: { numId: 3, ilvl: 1 },
          listMarker: "%1.%2)",
          listNumFmt: "lowerLetter",
          listLevelNumFmts: ["upperRoman", "lowerLetter"],
        },
        [schema.text("Child")],
      ),
    ]);

    const blocks = toFlowBlocks(doc);

    expect(blocks.at(0)?.attrs?.listMarker).toBe("I.");
    expect(blocks.at(1)?.attrs?.listMarker).toBe("I.a)");
  });

  test("continues numbering inside text boxes", () => {
    const textBoxNode = schema.nodes.textBox;
    if (!textBoxNode) {
      throw new Error("Expected textBox node in schema");
    }

    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        { numPr: { numId: 4, ilvl: 0 }, listMarker: "%1." },
        [schema.text("Before")],
      ),
      textBoxNode.create(null, [
        schema.node(
          "paragraph",
          { numPr: { numId: 4, ilvl: 0 }, listMarker: "%1." },
          [schema.text("Inside")],
        ),
      ]),
    ]);

    const blocks = toFlowBlocks(doc);
    const textBox = blocks.at(1);

    expect(blocks.at(0)?.attrs?.listMarker).toBe("1.");
    expect(textBox?.kind).toBe("textBox");
    if (textBox?.kind !== "textBox") {
      throw new Error("Expected textBox block");
    }
    expect(textBox.content.at(0)?.attrs?.listMarker).toBe("2.");
  });

  test("substitutes style-inherited marker templates without paragraph numPr", () => {
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        { numPr: { numId: 5, ilvl: 0 }, listMarker: "%1." },
        [schema.text("Numbered")],
      ),
      schema.node("paragraph", { listMarker: "%1." }, [
        schema.text("Style inherited"),
      ]),
    ]);

    const blocks = toFlowBlocks(doc);

    expect(blocks.at(0)?.attrs?.listMarker).toBe("1.");
    expect(blocks.at(1)?.attrs?.listMarker).toBe("1.");
  });
});
