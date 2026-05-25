import { describe, expect, test } from "bun:test";
import { EditorState } from "prosemirror-state";

import type {
  Document,
  Paragraph,
  Table,
  TableCell,
} from "../../types/document";
import { expectHardBreakAttrs } from "../attrs";
import { schema } from "../schema";
import { fromProseDoc } from "./fromProseDoc";
import { toProseDoc } from "./toProseDoc";

describe("fromProseDoc", () => {
  test("rejects malformed paragraph attrs at the conversion boundary", () => {
    const pmDoc = schema.node("doc", null, [
      schema.node("paragraph", { paraId: 12 }, [schema.text("invalid")]),
    ]);

    expect(() => fromProseDoc(pmDoc)).toThrow("paragraph.attrs.paraId");
  });

  test("rejects malformed hyperlink attrs at the conversion boundary", () => {
    const hyperlinkMark = schema.mark("hyperlink", { href: 123 });
    const pmDoc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("linked", [hyperlinkMark])]),
    ]);

    expect(() => fromProseDoc(pmDoc)).toThrow("hyperlink.attrs.href");
  });

  test("rejects malformed comment attrs at the conversion boundary", () => {
    const commentMark = schema.mark("comment", { commentId: "123" });
    const pmDoc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("commented", [commentMark])]),
    ]);

    expect(() => fromProseDoc(pmDoc)).toThrow("comment.attrs.commentId");
  });

  test("rejects malformed tracked-change attrs at the conversion boundary", () => {
    const insertionMark = schema.mark("insertion", {
      revisionId: "bad",
      author: "Reviewer",
    });
    const pmDoc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("inserted", [insertionMark]),
      ]),
    ]);

    expect(() => fromProseDoc(pmDoc)).toThrow("insertion.attrs.revisionId");
  });

  test("rejects malformed field and math attrs at the conversion boundary", () => {
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

    expect(() => fromProseDoc(fieldDoc)).toThrow("field.attrs.fieldType");
    expect(() => fromProseDoc(mathDoc)).toThrow("math.attrs.ommlXml");
  });

  test("rejects malformed SDT attrs at the conversion boundary", () => {
    const pmDoc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.node(
          "sdt",
          {
            sdtType: "dropdown",
            listItems: JSON.stringify([{ displayText: 7, value: "x" }]),
          },
          [schema.text("Choice")],
        ),
      ]),
    ]);

    expect(() => fromProseDoc(pmDoc)).toThrow(
      "sdt.attrs.listItems[0].displayText",
    );
  });

  test("rejects malformed shape and text box attrs at the conversion boundary", () => {
    const shapeDoc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.node("shape", { width: "wide" })]),
    ]);
    const textBoxDoc = schema.node("doc", null, [
      schema.node("textBox", { width: "wide" }, [
        schema.node("paragraph", null, [schema.text("Inside")]),
      ]),
    ]);

    expect(() => fromProseDoc(shapeDoc)).toThrow("shape.attrs.width");
    expect(() => fromProseDoc(textBoxDoc)).toThrow("textBox.attrs.width");
  });

  test("accepts table header cell attrs at the table-cell boundary", () => {
    const pmDoc = schema.node("doc", null, [
      schema.node("table", null, [
        schema.node("tableRow", null, [
          schema.node("tableHeader", null, [
            schema.node("paragraph", null, [schema.text("Header")]),
          ]),
        ]),
      ]),
    ]);

    const document = fromProseDoc(pmDoc);
    const table = document.package.document.content[0];

    expect(table?.type).toBe("table");
    if (table?.type !== "table") {
      return;
    }
    expect(table.rows[0]?.cells[0]?.content[0]?.type).toBe("paragraph");
  });

  test("coalesces page break blocks into the following paragraph for DOCX output", () => {
    const pmDoc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("Before")]),
      schema.node("pageBreak"),
      schema.node("paragraph", null, [schema.text("After")]),
    ]);

    const document = fromProseDoc(pmDoc);
    const firstBlock = document.package.document.content.at(0);
    const secondBlock = document.package.document.content.at(1);

    expect(document.package.document.content).toHaveLength(2);
    expect(firstBlock?.type).toBe("paragraph");
    expect(secondBlock?.type).toBe("paragraph");
    if (secondBlock?.type !== "paragraph") {
      return;
    }

    expect(paragraphStartsWithPageBreak(secondBlock)).toBe(true);
  });

  test("round-trips imported leading page breaks without inventing paragraphs", () => {
    const document: Document = {
      package: {
        document: {
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "run",
                  content: [{ type: "text", text: "Before" }],
                },
              ],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "run",
                  content: [
                    { type: "break", breakType: "page" },
                    { type: "text", text: "After" },
                  ],
                },
              ],
            },
          ],
        },
      },
    };

    const pmDoc = toProseDoc(document);
    const roundTripped = fromProseDoc(pmDoc, document);
    const secondBlock = roundTripped.package.document.content.at(1);

    expect(roundTripped.package.document.content).toHaveLength(2);
    expect(secondBlock?.type).toBe("paragraph");
    if (secondBlock?.type !== "paragraph") {
      return;
    }
    expect(paragraphStartsWithPageBreak(secondBlock)).toBe(true);
  });

  test("keeps page breaks before tables on the previous paragraph", () => {
    const pmDoc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("Before")]),
      schema.node("pageBreak"),
      schema.node("table", null, [
        schema.node("tableRow", null, [
          schema.node("tableCell", null, [
            schema.node("paragraph", null, [schema.text("Cell")]),
          ]),
        ]),
      ]),
    ]);

    const document = fromProseDoc(pmDoc);
    const firstBlock = document.package.document.content.at(0);
    const secondBlock = document.package.document.content.at(1);

    expect(document.package.document.content).toHaveLength(2);
    expect(firstBlock?.type).toBe("paragraph");
    expect(secondBlock?.type).toBe("table");
    if (firstBlock?.type !== "paragraph") {
      return;
    }
    expect(paragraphEndsWithPageBreak(firstBlock)).toBe(true);
  });

  test("round-trips imported trailing page breaks before tables without inventing paragraphs", () => {
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
                    { type: "text", text: "Before" },
                    { type: "break", breakType: "page" },
                  ],
                },
              ],
            },
            {
              type: "table",
              rows: [
                {
                  type: "tableRow",
                  cells: [
                    {
                      type: "tableCell",
                      content: [
                        {
                          type: "paragraph",
                          content: [
                            {
                              type: "run",
                              content: [{ type: "text", text: "Cell" }],
                            },
                          ],
                        },
                      ],
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
    const roundTripped = fromProseDoc(pmDoc, document);
    const firstBlock = roundTripped.package.document.content.at(0);
    const secondBlock = roundTripped.package.document.content.at(1);

    expect(pmDoc.child(1).type.name).toBe("pageBreak");
    expect(roundTripped.package.document.content).toHaveLength(2);
    expect(firstBlock?.type).toBe("paragraph");
    expect(secondBlock?.type).toBe("table");
    if (firstBlock?.type !== "paragraph") {
      return;
    }
    expect(paragraphEndsWithPageBreak(firstBlock)).toBe(true);
  });

  test("serializes table rowspans as vertical merge continuation cells", () => {
    const pmDoc = schema.node("doc", null, [
      schema.node("table", null, [
        schema.node("tableRow", null, [
          schema.node("tableCell", { rowspan: 2 }, [
            schema.node("paragraph", null, [schema.text("Merged")]),
          ]),
          schema.node("tableCell", null, [
            schema.node("paragraph", null, [schema.text("Top")]),
          ]),
        ]),
        schema.node("tableRow", null, [
          schema.node("tableCell", null, [
            schema.node("paragraph", null, [schema.text("Bottom")]),
          ]),
        ]),
      ]),
    ]);

    const document = fromProseDoc(pmDoc);
    const table = document.package.document.content.at(0);

    expect(table?.type).toBe("table");
    if (table?.type !== "table") {
      return;
    }

    expect(table.rows.at(0)?.cells.at(0)?.formatting?.vMerge).toBe("restart");
    expect(table.rows.at(1)?.cells).toHaveLength(2);
    expect(table.rows.at(1)?.cells.at(0)?.formatting?.vMerge).toBe("continue");
    expect(table.rows.at(1)?.cells.at(0)?.content).toHaveLength(1);
    expect(paragraphText(table.rows.at(1)?.cells.at(1)?.content.at(0))).toBe(
      "Bottom",
    );
  });

  test("preserves unmatched vertical-merge continuation cells", () => {
    const document: Document = {
      package: {
        document: {
          content: [
            {
              type: "table",
              rows: [
                {
                  type: "tableRow",
                  cells: [cellWithText("Top left"), cellWithText("Top right")],
                },
                {
                  type: "tableRow",
                  cells: [
                    cellWithText("Bottom left"),
                    {
                      type: "tableCell",
                      formatting: { vMerge: "continue" },
                      content: [
                        {
                          type: "paragraph",
                          content: [
                            {
                              type: "run",
                              content: [{ type: "text", text: "Metadata" }],
                            },
                          ],
                        },
                      ],
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
    const roundTripped = fromProseDoc(pmDoc, document);
    const table = roundTripped.package.document.content.at(0);

    expect(table?.type).toBe("table");
    if (table?.type !== "table") {
      return;
    }
    expect(table.rows.at(1)?.cells).toHaveLength(2);
    expect(paragraphText(table.rows.at(1)?.cells.at(1)?.content.at(0))).toBe(
      "Metadata",
    );
    expect(table.rows.at(1)?.cells.at(1)?.formatting?.vMerge).toBe("continue");
  });

  test("preserves fully vertically merged continuation rows", () => {
    const document: Document = {
      package: {
        document: {
          content: [
            {
              type: "table",
              rows: [
                {
                  type: "tableRow",
                  cells: [
                    {
                      type: "tableCell",
                      formatting: { vMerge: "restart" },
                      content: [
                        {
                          type: "paragraph",
                          content: [
                            {
                              type: "run",
                              content: [{ type: "text", text: "Merged" }],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
                {
                  type: "tableRow",
                  cells: [
                    {
                      type: "tableCell",
                      formatting: { vMerge: "continue" },
                      content: [{ type: "paragraph", content: [] }],
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
    const roundTripped = fromProseDoc(pmDoc, document);
    const table = roundTripped.package.document.content.at(0);

    expect(table?.type).toBe("table");
    if (table?.type !== "table") {
      return;
    }
    expect(table.rows).toHaveLength(2);
    expect(table.rows.at(0)?.cells.at(0)?.formatting?.vMerge).toBe("restart");
    expect(table.rows.at(1)?.cells.at(0)?.formatting?.vMerge).toBe("continue");
  });

  test("preserves empty hyperlinks through ProseMirror attrs", () => {
    const document: Document = {
      package: {
        document: {
          content: [
            {
              type: "paragraph",
              content: [
                { type: "run", content: [{ type: "text", text: "Before" }] },
                {
                  type: "hyperlink",
                  href: "https://example.test",
                  rId: "rId9",
                  children: [],
                },
                { type: "run", content: [{ type: "text", text: "After" }] },
              ],
            },
          ],
        },
      },
    };

    const pmDoc = toProseDoc(document);
    const roundTripped = fromProseDoc(pmDoc, document);
    const paragraph = roundTripped.package.document.content.at(0);

    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") {
      return;
    }
    expect(paragraph.content.map((content) => content.type)).toEqual([
      "run",
      "hyperlink",
      "run",
    ]);
    expect(paragraphText(paragraph)).toBe("BeforeAfter");
    const hyperlink = paragraph.content.find(
      (content) => content.type === "hyperlink",
    );
    expect(hyperlink?.type).toBe("hyperlink");
    if (hyperlink?.type !== "hyperlink") {
      return;
    }
    expect(hyperlink.href).toBe("https://example.test");
    expect(hyperlink.rId).toBe("rId9");
    expect(hyperlink.children).toHaveLength(0);
  });

  test("converts textBox nodes back to DOCX text box shapes", () => {
    const pmDoc = schema.node("doc", null, [
      schema.node("textBox", { width: 120, height: 60 }, [
        schema.node("paragraph", null, [schema.text("Inside")]),
      ]),
    ]);

    const document = fromProseDoc(pmDoc);
    const block = document.package.document.content.at(0);

    expect(block?.type).toBe("paragraph");
    if (block?.type !== "paragraph") {
      return;
    }

    const firstRun = block.content.at(0);
    const firstRunContent =
      firstRun?.type === "run" ? firstRun.content.at(0) : undefined;

    expect(firstRunContent?.type).toBe("shape");
    if (firstRunContent?.type !== "shape") {
      return;
    }
    expect(firstRunContent.shape.shapeType).toBe("textBox");
    expect(firstRunContent.shape.textBody?.content).toHaveLength(1);
  });

  test("reattaches imported mixed-paragraph text boxes to their source paragraph", () => {
    const document = documentWithTextBoxParagraph({ includeText: true });
    const pmDoc = toProseDoc(document);

    const roundTripped = fromProseDoc(pmDoc, document);
    const block = roundTripped.package.document.content.at(0);

    expect(pmDoc.childCount).toBe(2);
    expect(roundTripped.package.document.content).toHaveLength(1);
    expect(block?.type).toBe("paragraph");
    if (block?.type !== "paragraph") {
      return;
    }
    expect(block.content).toHaveLength(2);
    expect(firstShapeType(block)).toBe("textBox");
  });

  test("keeps imported text-box-only paragraphs as standalone wrappers", () => {
    const document = documentWithTextBoxParagraph({ includeText: false });
    const pmDoc = toProseDoc(document);

    const roundTripped = fromProseDoc(pmDoc, document);
    const block = roundTripped.package.document.content.at(0);

    expect(pmDoc.childCount).toBe(1);
    expect(pmDoc.firstChild?.type.name).toBe("textBox");
    expect(roundTripped.package.document.content).toHaveLength(1);
    expect(block?.type).toBe("paragraph");
    if (block?.type !== "paragraph") {
      return;
    }
    expect(firstShapeType(block)).toBe("textBox");
  });

  test("keeps page breaks before inline text boxes on the source paragraph", () => {
    const pmDoc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("Before")]),
      schema.node("pageBreak"),
      schema.node("textBox", { _docxPlacement: "inlineWithPrevious" }, [
        schema.node("paragraph", null, [schema.text("Inside")]),
      ]),
    ]);

    const document = fromProseDoc(pmDoc);
    const block = document.package.document.content.at(0);

    expect(document.package.document.content).toHaveLength(1);
    expect(block?.type).toBe("paragraph");
    if (block?.type !== "paragraph") {
      return;
    }
    expect(paragraphHasPageBreakBeforeFirstShape(block)).toBe(true);
    expect(firstShapeType(block)).toBe("textBox");
  });

  test("keeps a wrapper paragraph when text-box-only content ends a section", () => {
    const document = documentWithTextBoxParagraph({
      includeText: false,
      sectionProperties: { sectionStart: "continuous" },
    });
    const pmDoc = toProseDoc(document);

    const roundTripped = fromProseDoc(pmDoc, document);
    const block = roundTripped.package.document.content.at(0);

    expect(pmDoc.childCount).toBe(2);
    expect(pmDoc.child(0).type.name).toBe("paragraph");
    expect(pmDoc.child(1).type.name).toBe("textBox");
    expect(roundTripped.package.document.content).toHaveLength(1);
    expect(block?.type).toBe("paragraph");
    if (block?.type !== "paragraph") {
      return;
    }
    expect(block.sectionProperties).toEqual({ sectionStart: "continuous" });
    expect(firstShapeType(block)).toBe("textBox");
  });

  test("preserves imported column breaks", () => {
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
                    { type: "text", text: "Left column" },
                    { type: "break", breakType: "column" },
                    { type: "text", text: "Right column" },
                  ],
                },
              ],
            },
          ],
        },
      },
    };

    const pmDoc = toProseDoc(document);
    const hardBreak = pmDoc.firstChild?.child(1);
    const roundTripped = fromProseDoc(pmDoc, document);
    const block = roundTripped.package.document.content.at(0);

    expect(hardBreak?.type.name).toBe("hardBreak");
    expect(
      hardBreak ? expectHardBreakAttrs(hardBreak).breakType : undefined,
    ).toBe("column");
    expect(block?.type).toBe("paragraph");
    if (block?.type !== "paragraph") {
      return;
    }
    const runContents = block.content.flatMap((content) =>
      content.type === "run" ? content.content : [],
    );
    expect(runContents).toContainEqual({ type: "break", breakType: "column" });
  });

  test("keeps imported page-break text-box-only paragraphs as one wrapper", () => {
    const document = documentWithTextBoxParagraph({
      includeText: false,
      includePageBreak: true,
      textBoxCount: 2,
    });
    const pmDoc = toProseDoc(document);

    const roundTripped = fromProseDoc(pmDoc, document);
    const block = roundTripped.package.document.content.at(0);

    expect(pmDoc.childCount).toBe(3);
    expect(pmDoc.child(0).type.name).toBe("pageBreak");
    expect(pmDoc.child(1).type.name).toBe("textBox");
    expect(pmDoc.child(2).type.name).toBe("textBox");
    expect(roundTripped.package.document.content).toHaveLength(1);
    expect(block?.type).toBe("paragraph");
    if (block?.type !== "paragraph") {
      return;
    }
    expect(paragraphStartsWithPageBreak(block)).toBe(true);
    expect(countShapes(block)).toBe(2);
  });

  test("does not merge adjacent standalone text boxes from different source paragraphs", () => {
    const pmDoc = schema.node("doc", null, [
      schema.node(
        "textBox",
        { _docxPlacement: "standalone", _docxGroupId: "a" },
        [schema.node("paragraph", null, [schema.text("A")])],
      ),
      schema.node(
        "textBox",
        { _docxPlacement: "standalone", _docxGroupId: "b" },
        [schema.node("paragraph", null, [schema.text("B")])],
      ),
    ]);

    const document = fromProseDoc(pmDoc);

    expect(document.package.document.content).toHaveLength(2);
    for (const block of document.package.document.content) {
      expect(block.type).toBe("paragraph");
      if (block.type === "paragraph") {
        expect(countShapes(block)).toBe(1);
      }
    }
  });

  test("preserves comment ranges added to selected text", () => {
    const commentMark = schema.mark("comment", { commentId: 123 });
    const pmDoc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("before "),
        schema.text("commented", [commentMark]),
        schema.text(" after"),
      ]),
    ]);

    const document = fromProseDoc(pmDoc);
    const paragraph = document.package.document.content[0];

    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") {
      return;
    }

    expect(paragraph.content.map((content) => content.type)).toEqual([
      "run",
      "commentRangeStart",
      "run",
      "commentRangeEnd",
      "run",
    ]);

    const roundTripped = toProseDoc(document);
    const markedText = roundTripped.firstChild?.child(1);
    const comment = markedText?.marks.find(
      (mark) => mark.type.name === "comment",
    );

    expect(markedText?.text).toBe("commented");
    expect(comment?.attrs.commentId).toBe(123);
  });

  test("preserves comment ranges across multiple paragraphs", () => {
    const commentMark = schema.mark("comment", { commentId: 456 });
    const pmDoc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("first ", [commentMark]),
        schema.text("paragraph", [commentMark]),
      ]),
      schema.node("paragraph", null, [
        schema.text("second ", [commentMark]),
        schema.text("paragraph", [commentMark]),
      ]),
    ]);

    const document = fromProseDoc(pmDoc);
    const roundTripped = toProseDoc(document);

    const markedTexts: string[] = [];
    roundTripped.descendants((node) => {
      if (
        node.isText &&
        node.marks.some(
          (mark) =>
            mark.type.name === "comment" && mark.attrs.commentId === 456,
        )
      ) {
        markedTexts.push(node.text ?? "");
      }
    });

    expect(markedTexts.join("")).toBe("first paragraphsecond paragraph");
  });

  test("preserves comment ranges inside table cells", () => {
    const commentMark = schema.mark("comment", { commentId: 789 });
    const pmDoc = schema.node("doc", null, [
      schema.node("table", null, [
        schema.node("tableRow", null, [
          schema.node("tableCell", null, [
            schema.node("paragraph", null, [
              schema.text("cell one", [commentMark]),
            ]),
          ]),
          schema.node("tableCell", null, [
            schema.node("paragraph", null, [
              schema.text("cell two", [commentMark]),
            ]),
          ]),
        ]),
      ]),
    ]);

    const document = fromProseDoc(pmDoc);
    const roundTripped = toProseDoc(document);

    const markedTexts: string[] = [];
    roundTripped.descendants((node) => {
      if (
        node.isText &&
        node.marks.some(
          (mark) =>
            mark.type.name === "comment" && mark.attrs.commentId === 789,
        )
      ) {
        markedTexts.push(node.text ?? "");
      }
    });

    expect(markedTexts).toEqual(["cell one", "cell two"]);
  });

  test("preserves comment ranges on hyperlinks", () => {
    const commentMark = schema.mark("comment", { commentId: 321 });
    const hyperlinkMark = schema.mark("hyperlink", {
      href: "https://stella.law",
    });
    const pmDoc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("before "),
        schema.text("linked", [hyperlinkMark, commentMark]),
        schema.text(" after"),
      ]),
    ]);

    const document = fromProseDoc(pmDoc);
    const roundTripped = toProseDoc(document);
    const markedText = roundTripped.firstChild?.child(1);
    const comment = markedText?.marks.find(
      (mark) => mark.type.name === "comment",
    );
    const hyperlink = markedText?.marks.find(
      (mark) => mark.type.name === "hyperlink",
    );

    expect(markedText?.text).toBe("linked");
    expect(comment?.attrs.commentId).toBe(321);
    expect(hyperlink?.attrs.href).toBe("https://stella.law");
  });

  test("keeps adjacent same-target hyperlinks with distinct relationship ids separate", () => {
    const firstLink = schema.mark("hyperlink", {
      href: "mailto:reviewer@example.test",
      rId: "rId1",
    });
    const secondLink = schema.mark("hyperlink", {
      href: "mailto:reviewer@example.test",
      rId: "rId2",
    });
    const pmDoc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("mailto:", [firstLink]),
        schema.text("reviewer@example.test", [secondLink]),
      ]),
    ]);

    const document = fromProseDoc(pmDoc);
    const block = document.package.document.content.at(0);

    expect(block?.type).toBe("paragraph");
    if (block?.type !== "paragraph") {
      return;
    }

    const hyperlinks = block.content.filter(
      (content) => content.type === "hyperlink",
    );
    expect(hyperlinks).toHaveLength(2);
    expect(hyperlinks.at(0)?.type === "hyperlink" && hyperlinks.at(0).rId).toBe(
      "rId1",
    );
    expect(hyperlinks.at(1)?.type === "hyperlink" && hyperlinks.at(1).rId).toBe(
      "rId2",
    );
  });

  test("preserves ProseMirror addMark comments spanning block boundaries", () => {
    const commentId = 999;
    const commentMark = schema.mark("comment", { commentId });
    const initialDoc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("before")]),
      schema.node("table", null, [
        schema.node("tableRow", null, [
          schema.node("tableCell", null, [
            schema.node("paragraph", null, [schema.text("cell one")]),
          ]),
          schema.node("tableCell", null, [
            schema.node("paragraph", null, [schema.text("cell two")]),
          ]),
        ]),
      ]),
      schema.node("paragraph", null, [schema.text("after")]),
    ]);
    const state = EditorState.create({ doc: initialDoc, schema });
    const docWithMark = state.tr.addMark(
      1,
      state.doc.content.size - 1,
      commentMark,
    ).doc;

    const document = fromProseDoc(docWithMark);
    const roundTripped = toProseDoc(document);

    const markedTexts: string[] = [];
    roundTripped.descendants((node) => {
      if (
        node.isText &&
        node.marks.some(
          (mark) =>
            mark.type.name === "comment" && mark.attrs.commentId === commentId,
        )
      ) {
        markedTexts.push(node.text ?? "");
      }
    });

    expect(markedTexts).toEqual(["before", "cell one", "cell two", "after"]);
  });
});

function paragraphStartsWithPageBreak(paragraph: Paragraph): boolean {
  const firstContent = paragraph.content.at(0);
  const firstRunContent =
    firstContent?.type === "run" ? firstContent.content.at(0) : undefined;
  return (
    firstRunContent?.type === "break" && firstRunContent.breakType === "page"
  );
}

function paragraphEndsWithPageBreak(paragraph: Paragraph): boolean {
  const lastContent = paragraph.content.at(-1);
  const lastRunContent =
    lastContent?.type === "run" ? lastContent.content.at(-1) : undefined;
  return (
    lastRunContent?.type === "break" && lastRunContent.breakType === "page"
  );
}

function paragraphHasPageBreakBeforeFirstShape(paragraph: Paragraph): boolean {
  let sawPageBreak = false;
  for (const content of paragraph.content) {
    if (content.type !== "run") {
      continue;
    }
    for (const runContent of content.content) {
      if (runContent.type === "break" && runContent.breakType === "page") {
        sawPageBreak = true;
      }
      if (runContent.type === "shape") {
        return sawPageBreak;
      }
    }
  }
  return false;
}

function paragraphText(block: Paragraph | Table | undefined): string {
  if (!block || block.type !== "paragraph") {
    return "";
  }
  return block.content
    .flatMap((content) =>
      content.type === "run"
        ? content.content.flatMap((runContent) =>
            runContent.type === "text" ? [runContent.text] : [],
          )
        : [],
    )
    .join("");
}

function documentWithTextBoxParagraph({
  includeText,
  includePageBreak = false,
  textBoxCount = 1,
  sectionProperties,
}: {
  includeText: boolean;
  includePageBreak?: boolean;
  textBoxCount?: number;
  sectionProperties?: Paragraph["sectionProperties"];
}): Document {
  const content: Paragraph["content"] = [];
  if (includePageBreak) {
    content.push({
      type: "run",
      content: [{ type: "break", breakType: "page" }],
    });
  }
  if (includeText) {
    content.push({
      type: "run",
      content: [{ type: "text", text: "Before" }],
    });
  }
  for (let index = 0; index < textBoxCount; index += 1) {
    content.push({
      type: "run",
      content: [
        {
          type: "shape",
          shape: {
            type: "shape",
            shapeType: "textBox",
            size: { width: 914_400, height: 457_200 },
            textBody: {
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "run",
                      content: [{ type: "text", text: `Inside ${index}` }],
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
    });
  }

  return {
    package: {
      document: {
        content: [{ type: "paragraph", content, sectionProperties }],
      },
    },
  };
}

function cellWithText(text: string): TableCell {
  return {
    type: "tableCell",
    content: [
      {
        type: "paragraph",
        content: [{ type: "run", content: [{ type: "text", text }] }],
      },
    ],
  };
}

function firstShapeType(paragraph: Paragraph): string | undefined {
  for (const content of paragraph.content) {
    if (content.type !== "run") {
      continue;
    }
    for (const runContent of content.content) {
      if (runContent.type === "shape") {
        return runContent.shape.shapeType;
      }
    }
  }
  return undefined;
}

function countShapes(paragraph: Paragraph): number {
  let count = 0;
  for (const content of paragraph.content) {
    if (content.type !== "run") {
      continue;
    }
    for (const runContent of content.content) {
      if (runContent.type === "shape") {
        count += 1;
      }
    }
  }
  return count;
}
