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

  test("rejects malformed paragraph attrs at the layout boundary", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", { lineSpacing: "240" }, [
        schema.text("Invalid paragraph"),
      ]),
    ]);

    expect(() => toFlowBlocks(doc)).toThrow("paragraph.attrs.lineSpacing");
  });

  test("rejects malformed mark attrs at the layout boundary", () => {
    const fontSize = schema.mark("fontSize", { size: "large" });
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("Invalid mark", [fontSize])]),
    ]);

    expect(() => toFlowBlocks(doc)).toThrow("fontSize.attrs.size");
  });

  test("rejects malformed field and math attrs at the layout boundary", () => {
    const fieldDoc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.node("field", {
          fieldType: "NOT_A_FIELD",
          instruction: " PAGE ",
          displayText: "1",
          fieldKind: "simple",
        }),
      ]),
    ]);
    const mathDoc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.node("math", {
          display: "inline",
          ommlXml: 42,
          plainText: "x",
        }),
      ]),
    ]);

    expect(() => toFlowBlocks(fieldDoc)).toThrow("field.attrs.fieldType");
    expect(() => toFlowBlocks(mathDoc)).toThrow("math.attrs.ommlXml");
  });

  test("rejects malformed shape and text box attrs at the layout boundary", () => {
    const shapeDoc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.node("shape", { width: "wide" })]),
    ]);
    const textBoxDoc = schema.node("doc", null, [
      schema.node("textBox", { width: "wide" }, [
        schema.node("paragraph", null, [schema.text("Invalid text box")]),
      ]),
    ]);

    expect(() => toFlowBlocks(shapeDoc)).toThrow("shape.attrs.width");
    expect(() => toFlowBlocks(textBoxDoc)).toThrow("textBox.attrs.width");
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

  // Regression: PAGE field rendered with the painter's default font/colour
  // (eigenpal #575) when the bridge skipped extractRunFormatting for field
  // nodes. Word renders a field result with the result run's own w:rPr, so
  // marks attached to the field node must land on the FieldRun.
  test("propagates field-node character marks to the FieldRun formatting", () => {
    const bold = schema.marks["bold"]?.create();
    // fontSize mark stores half-points (the OOXML <w:sz>) — 28 = 14pt.
    const fontSize = schema.marks["fontSize"]?.create({ size: 28 });
    const textColor = schema.marks["textColor"]?.create({ rgb: "FF0000" });
    if (!bold || !fontSize || !textColor) {
      throw new Error("Expected bold/fontSize/textColor marks in schema");
    }
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.node(
          "field",
          {
            fieldType: "PAGE",
            instruction: " PAGE ",
            displayText: "1",
            fieldKind: "simple",
          },
          undefined,
          [bold, fontSize, textColor],
        ),
      ]),
    ]);

    const blocks = toFlowBlocks(doc);
    const paragraph = blocks.at(0);
    if (paragraph?.kind !== "paragraph") {
      throw new Error("Expected paragraph block");
    }
    const fieldRun = paragraph.runs.at(0);
    if (fieldRun?.kind !== "field") {
      throw new Error("Expected field run");
    }

    expect(fieldRun.bold).toBe(true);
    expect(fieldRun.fontSize).toBe(14);
    expect(fieldRun.color).toBe("#FF0000");
  });
});

describe("toFlowBlocks TOC hyperlink style strip", () => {
  // Regression eigenpal #566: in TOCx paragraphs, Word renders hyperlinks in
  // the paragraph's own colour (no blue + underline). Without stripping the
  // resolved Hyperlink character-style here, the painter's link fallback
  // applies blue + underline and TOC entries look like web links.
  test("strips resolved color/underline on hyperlink text in a TOC paragraph", () => {
    const linkMark = schema.marks["hyperlink"]?.create({
      href: "#_Toc1",
    });
    const underline = schema.marks["underline"]?.create({ style: "single" });
    const textColor = schema.marks["textColor"]?.create({ rgb: "0563C1" });
    if (!linkMark || !underline || !textColor) {
      throw new Error("Expected hyperlink/underline/textColor marks");
    }

    const doc = schema.node("doc", null, [
      schema.node("paragraph", { styleId: "TOC1" }, [
        schema.text("Section 1", [linkMark, underline, textColor]),
      ]),
    ]);

    const blocks = toFlowBlocks(doc);
    const paragraph = blocks.at(0);
    if (paragraph?.kind !== "paragraph") {
      throw new Error("Expected paragraph block");
    }
    const run = paragraph.runs.at(0);
    if (run?.kind !== "text") {
      throw new Error("Expected text run");
    }

    expect(run.hyperlink?.href).toBe("#_Toc1");
    expect(run.hyperlink?.noDefaultStyle).toBe(true);
    expect(run.color).toBeUndefined();
    expect(run.underline).toBeUndefined();
  });

  // The page-number end of a TOC entry is a PAGEREF field inside the
  // hyperlink — the strip must reach field runs too, not just text runs.
  test("strips resolved color/underline on a field run inside a TOC paragraph", () => {
    const linkMark = schema.marks["hyperlink"]?.create({
      href: "#_Toc1",
    });
    const underline = schema.marks["underline"]?.create({ style: "single" });
    const textColor = schema.marks["textColor"]?.create({ rgb: "0563C1" });
    if (!linkMark || !underline || !textColor) {
      throw new Error("Expected hyperlink/underline/textColor marks");
    }

    const doc = schema.node("doc", null, [
      schema.node("paragraph", { styleId: "TOC2" }, [
        schema.node(
          "field",
          {
            fieldType: "PAGEREF",
            instruction: " PAGEREF _Toc1 \\h ",
            displayText: "5",
            fieldKind: "complex",
          },
          undefined,
          [linkMark, underline, textColor],
        ),
      ]),
    ]);

    const blocks = toFlowBlocks(doc);
    const paragraph = blocks.at(0);
    if (paragraph?.kind !== "paragraph") {
      throw new Error("Expected paragraph block");
    }
    const fieldRun = paragraph.runs.at(0);
    if (fieldRun?.kind !== "field") {
      throw new Error("Expected field run");
    }

    expect(fieldRun.hyperlink?.noDefaultStyle).toBe(true);
    expect(fieldRun.color).toBeUndefined();
    expect(fieldRun.underline).toBeUndefined();
  });

  // Non-TOC paragraphs must NOT be stripped — Word still renders normal-body
  // hyperlinks with the Hyperlink character style (blue + underline). The
  // strip is keyed to styleId /^TOC\d*$/i; everything else passes through.
  test("does not strip hyperlinks in non-TOC paragraphs", () => {
    const linkMark = schema.marks["hyperlink"]?.create({
      href: "https://example.com",
    });
    const underline = schema.marks["underline"]?.create({ style: "single" });
    const textColor = schema.marks["textColor"]?.create({ rgb: "0563C1" });
    if (!linkMark || !underline || !textColor) {
      throw new Error("Expected hyperlink/underline/textColor marks");
    }

    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("body link", [linkMark, underline, textColor]),
      ]),
    ]);

    const blocks = toFlowBlocks(doc);
    const paragraph = blocks.at(0);
    if (paragraph?.kind !== "paragraph") {
      throw new Error("Expected paragraph block");
    }
    const run = paragraph.runs.at(0);
    if (run?.kind !== "text") {
      throw new Error("Expected text run");
    }

    expect(run.hyperlink?.noDefaultStyle).toBeUndefined();
    expect(run.color).toBeDefined();
    expect(run.underline).toBeDefined();
  });

  // TOC, TOC1..TOC9 should all match. TOCHeading (Word's TOC title) is its
  // own styleId and is NOT a TOC entry — no strip.
  test("TOC styleId regex matches TOC and TOC1..N but not TOCHeading", () => {
    const linkMark = schema.marks["hyperlink"]?.create({ href: "#x" });
    if (!linkMark) {
      throw new Error("Expected hyperlink mark");
    }
    const docFor = (styleId: string) =>
      schema.node("doc", null, [
        schema.node("paragraph", { styleId }, [schema.text("x", [linkMark])]),
      ]);
    const firstRunHyperlinkStripped = (styleId: string) => {
      const blocks = toFlowBlocks(docFor(styleId));
      const para = blocks.at(0);
      if (para?.kind !== "paragraph") {
        throw new Error("Expected paragraph block");
      }
      const run = para.runs.at(0);
      if (run?.kind !== "text") {
        throw new Error("Expected text run");
      }
      return run.hyperlink?.noDefaultStyle === true;
    };

    expect(firstRunHyperlinkStripped("TOC")).toBe(true);
    expect(firstRunHyperlinkStripped("TOC1")).toBe(true);
    expect(firstRunHyperlinkStripped("toc3")).toBe(true);
    expect(firstRunHyperlinkStripped("TOCHeading")).toBe(false);
    expect(firstRunHyperlinkStripped("Normal")).toBe(false);
  });
});

describe("toFlowBlocks list numbering", () => {
  test("normalizes Symbol-family bullet markers during flow conversion", () => {
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        {
          numPr: { numId: 8, ilvl: 0 },
          listIsBullet: true,
          listMarker: "\u00b7",
        },
        [schema.text("Bullet")],
      ),
    ]);

    const blocks = toFlowBlocks(doc);

    expect(blocks.at(0)?.kind).toBe("paragraph");
    expect(blocks.at(0)?.attrs?.listMarker).toBe("\u2022");
  });

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

  test("renders repeated placeholders and repeated-letter counters after z", () => {
    const paragraphs = Array.from({ length: 28 }, (_unused, index) =>
      schema.node(
        "paragraph",
        {
          numPr: { numId: 9, ilvl: 0 },
          listMarker: "%1.%1",
          listNumFmt: "lowerLetter",
          listLevelNumFmts: ["lowerLetter"],
        },
        [schema.text(`Item ${index + 1}`)],
      ),
    );

    const blocks = toFlowBlocks(schema.node("doc", null, paragraphs));

    expect(blocks.at(0)?.attrs?.listMarker).toBe("a.a");
    expect(blocks.at(25)?.attrs?.listMarker).toBe("z.z");
    expect(blocks.at(26)?.attrs?.listMarker).toBe("aa.aa");
    expect(blocks.at(27)?.attrs?.listMarker).toBe("bb.bb");
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

  test("formats legal multilevel markers with decimal parent placeholders", () => {
    const paragraphs = [];
    for (let index = 1; index <= 7; index += 1) {
      paragraphs.push(
        schema.node(
          "paragraph",
          {
            numPr: { numId: 7, ilvl: 0 },
            listMarker: "%1",
            listNumFmt: "lowerLetter",
            listLevelNumFmts: ["lowerLetter"],
          },
          [schema.text(`Level ${index}`)],
        ),
      );
    }
    for (let index = 1; index <= 5; index += 1) {
      paragraphs.push(
        schema.node(
          "paragraph",
          {
            numPr: { numId: 7, ilvl: 1 },
            listMarker: "%1.%2",
            listNumFmt: "lowerLetter",
            listLevelNumFmts: ["lowerLetter", "lowerLetter"],
          },
          [schema.text(`Level 7.${index}`)],
        ),
      );
    }
    paragraphs.push(
      schema.node(
        "paragraph",
        {
          numPr: { numId: 7, ilvl: 2 },
          listIsLegal: true,
          listMarker: "%1.%2.%3",
          listNumFmt: "decimal",
          listLevelNumFmts: ["lowerLetter", "lowerLetter", "decimal"],
        },
        [schema.text("Level 7.5.1")],
      ),
    );

    const blocks = toFlowBlocks(schema.node("doc", null, paragraphs));

    expect(blocks.at(-1)?.attrs?.listMarker).toBe("7.5.1");
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
