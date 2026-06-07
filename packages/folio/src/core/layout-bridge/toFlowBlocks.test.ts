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

describe("toFlowBlocks table cell formatting", () => {
  // Regression eigenpal #424 gap 14: the parser captured w:noWrap and the PM
  // schema carried it, but convertTableCell dropped the field, so cells like
  // case numbers / citations wrapped where Word kept them on one line.
  test("threads the cell noWrap attribute into the engine TableCell", () => {
    const doc = schema.node("doc", null, [
      schema.node("table", null, [
        schema.node("tableRow", null, [
          schema.node("tableCell", { noWrap: true }, [
            schema.node("paragraph", null, [schema.text("CASE 123-456")]),
          ]),
          schema.node("tableCell", null, [
            schema.node("paragraph", null, [schema.text("default")]),
          ]),
        ]),
      ]),
    ]);

    const blocks = toFlowBlocks(doc);
    const table = blocks.at(0);
    if (table?.kind !== "table") {
      throw new Error("Expected table block");
    }
    const row = table.rows.at(0);
    if (!row) {
      throw new Error("Expected table row");
    }

    expect(row.cells.at(0)?.noWrap).toBe(true);
    expect(row.cells.at(1)?.noWrap).toBeUndefined();
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

  test("marks newly added numbering as a tracked insertion", () => {
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        {
          numPr: { numId: 1, ilvl: 0 },
          listMarker: "%1.",
          _propertyChanges: [
            {
              type: "paragraphPropertyChange",
              info: { id: 12, author: "Reviewer", date: "2026-01-01" },
              previousFormatting: { numPr: null },
            },
          ],
        },
        [schema.text("Inserted list item")],
      ),
    ]);

    const blocks = toFlowBlocks(doc);

    expect(blocks.at(0)?.attrs?.listMarkerRevision).toEqual({
      kind: "ins",
      author: "Reviewer",
      date: "2026-01-01",
      revisionId: 12,
    });
  });

  test("renders removed numbering as a tracked deletion marker", () => {
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        {
          _propertyChanges: [
            {
              type: "paragraphPropertyChange",
              info: { id: 13, author: "Reviewer", date: "2026-01-02" },
              previousFormatting: {
                numPr: { numId: 1, ilvl: 0 },
                listIsBullet: false,
                listNumFmt: "decimal",
                listMarker: "%1.",
              },
            },
          ],
        },
        [schema.text("Removed list item")],
      ),
    ]);

    const blocks = toFlowBlocks(doc);

    expect(blocks.at(0)?.attrs?.listMarker).toBe("1.");
    expect(blocks.at(0)?.attrs?.listMarkerRevision).toEqual({
      kind: "del",
      author: "Reviewer",
      date: "2026-01-02",
      revisionId: 13,
    });
  });

  test("removed-numbering deletion numbers off the original stream", () => {
    // An inserted list item (numId 6) advances the final stream to (1). The
    // next item shares that numId but had its numbering removed; in the
    // pre-revision document the inserted item did not exist, so the deleted
    // marker restarts at 1 rather than continuing to 2 off the insertion.
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        {
          numPr: { numId: 6, ilvl: 0 },
          listMarker: "%1.",
          _propertyChanges: [
            {
              type: "paragraphPropertyChange",
              info: { id: 21, author: "Reviewer", date: "2026-01-01" },
              previousFormatting: { numPr: null },
            },
          ],
        },
        [schema.text("Inserted list item")],
      ),
      schema.node(
        "paragraph",
        {
          _propertyChanges: [
            {
              type: "paragraphPropertyChange",
              info: { id: 22, author: "Reviewer", date: "2026-01-02" },
              previousFormatting: {
                numPr: { numId: 6, ilvl: 0 },
                listIsBullet: false,
                listNumFmt: "decimal",
                listMarker: "%1.",
              },
            },
          ],
        },
        [schema.text("Numbering removed")],
      ),
    ]);

    const blocks = toFlowBlocks(doc);
    const inserted = blocks.at(0);
    const removed = blocks.at(1);
    if (inserted?.kind !== "paragraph" || removed?.kind !== "paragraph") {
      throw new Error("Expected paragraph blocks");
    }

    expect(inserted.attrs?.listMarkerRevision?.kind).toBe("ins");
    expect(removed.attrs?.listMarker).toBe("1.");
    expect(removed.attrs?.listMarkerRevision?.kind).toBe("del");
  });

  test("consecutive removed-numbering deletions advance the original stream", () => {
    // Two adjacent items (numId 6) whose numbering was removed keep their
    // original 1, 2 ordering: the deletion stream advances between them.
    const removedItem = (id: number, text: string) =>
      schema.node(
        "paragraph",
        {
          _propertyChanges: [
            {
              type: "paragraphPropertyChange",
              info: { id, author: "Reviewer", date: "2026-01-02" },
              previousFormatting: {
                numPr: { numId: 6, ilvl: 0 },
                listIsBullet: false,
                listNumFmt: "decimal",
                listMarker: "%1.",
              },
            },
          ],
        },
        [schema.text(text)],
      );
    const doc = schema.node("doc", null, [
      removedItem(31, "first"),
      removedItem(32, "second"),
    ]);

    const blocks = toFlowBlocks(doc);
    const first = blocks.at(0);
    const second = blocks.at(1);
    if (first?.kind !== "paragraph" || second?.kind !== "paragraph") {
      throw new Error("Expected paragraph blocks");
    }

    expect(first.attrs?.listMarker).toBe("1.");
    expect(second.attrs?.listMarker).toBe("2.");
  });

  test("marks changed numbering as a tracked insertion marker", () => {
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        {
          numPr: { numId: 1, ilvl: 0 },
          listIsBullet: true,
          listMarker: "\u00b7",
          _propertyChanges: [
            {
              type: "paragraphPropertyChange",
              info: { id: 14, author: "Reviewer", date: "2026-01-03" },
              previousFormatting: {
                numPr: { numId: 2, ilvl: 0 },
                listIsBullet: false,
                listNumFmt: "decimal",
                listMarker: "%1.",
              },
            },
          ],
        },
        [schema.text("Changed list item")],
      ),
    ]);

    const blocks = toFlowBlocks(doc);

    expect(blocks.at(0)?.attrs?.listMarker).toBe("\u2022");
    expect(blocks.at(0)?.attrs?.listMarkerRevision).toEqual({
      kind: "ins",
      author: "Reviewer",
      date: "2026-01-03",
      revisionId: 14,
    });
  });

  test("does not mark unrelated paragraph property changes as list insertions", () => {
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        {
          numPr: { numId: 1, ilvl: 0 },
          listMarker: "%1.",
          _propertyChanges: [
            {
              type: "paragraphPropertyChange",
              info: { id: 12, author: "Reviewer", date: "2026-01-01" },
              previousFormatting: { alignment: "left" },
            },
          ],
        },
        [schema.text("Plain list item")],
      ),
    ]);

    const blocks = toFlowBlocks(doc);

    expect(blocks.at(0)?.attrs?.listMarkerRevision).toBeUndefined();
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

  test("carries anchored text-box position into flow blocks", () => {
    const textBoxNode = schema.nodes.textBox;
    if (!textBoxNode) {
      throw new Error("Expected textBox node in schema");
    }

    const position = {
      horizontal: { relativeTo: "margin", align: "center" },
      vertical: { relativeTo: "page", posOffset: 123_456 },
    } as const;
    const doc = schema.node("doc", null, [
      textBoxNode.create(
        {
          wrapType: "topAndBottom",
          position,
        },
        [schema.node("paragraph", null, [schema.text("Inside")])],
      ),
    ]);

    const textBox = toFlowBlocks(doc).at(0);

    expect(textBox?.kind).toBe("textBox");
    if (textBox?.kind !== "textBox") {
      throw new Error("Expected textBox block");
    }
    expect(textBox.wrapType).toBe("topAndBottom");
    expect(textBox.position).toEqual(position);
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

// Regression guard for the eigenpal #424 opacity render pipeline. PR #517
// review (gemini-code-assist) flagged that `attrs.opacity !== undefined` in
// buildImageRun allowed the PM schema's null default to leak into
// ImageRun.opacity (typed `number | undefined`). The bridge now gates with
// `!= null`; these tests pin the contract for inline images, which is the
// only path the schema permits (images are inline-only in PM).
describe("toFlowBlocks image opacity null-default leak", () => {
  test("drops PM null default for inline image opacity (ImageRun)", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.nodes.image.create({
          src: "media/image.png",
          width: 100,
          height: 100,
        }),
      ]),
    ]);

    const blocks = toFlowBlocks(doc);
    const paragraph = blocks.at(0);
    if (paragraph?.kind !== "paragraph") {
      throw new Error("Expected paragraph block");
    }
    const imageRun = paragraph.runs.find((run) => run.kind === "image");
    if (imageRun?.kind !== "image") {
      throw new Error("Expected image run");
    }
    // Critical: must be `undefined`, not `null`. The PM schema default is
    // `null` and the bridge must filter it so downstream consumers (the
    // painter, the floating-image collector) see only valid numbers.
    expect(imageRun.opacity).toBeUndefined();
  });

  test("preserves explicit inline image opacity (ImageRun)", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.nodes.image.create({
          src: "media/image.png",
          width: 100,
          height: 100,
          opacity: 0.5,
        }),
      ]),
    ]);

    const blocks = toFlowBlocks(doc);
    const paragraph = blocks.at(0);
    if (paragraph?.kind !== "paragraph") {
      throw new Error("Expected paragraph block");
    }
    const imageRun = paragraph.runs.find((run) => run.kind === "image");
    if (imageRun?.kind !== "image") {
      throw new Error("Expected image run");
    }
    expect(imageRun.opacity).toBe(0.5);
  });
});
