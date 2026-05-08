import { describe, expect, test } from "bun:test";

import type { Document } from "../../types/document";
import { toProseDoc } from "./toProseDoc";

describe("toProseDoc", () => {
  test("applies oneNDA paragraph mark defaults to unformatted visible text like Word", () => {
    const document: Document = {
      package: {
        document: {
          content: [
            {
              type: "paragraph",
              formatting: {
                runProperties: {
                  bold: true,
                  fontSize: 21,
                  fontFamily: { ascii: "Arial", hAnsi: "Arial" },
                },
              },
              content: [
                {
                  type: "run",
                  formatting: {},
                  content: [{ type: "text", text: "TERMS" }],
                },
              ],
            },
          ],
        },
      },
    };

    const doc = toProseDoc(document);
    const text = doc.firstChild?.firstChild;

    expect(text?.marks.some((mark) => mark.type.name === "bold")).toBe(true);
    expect(text?.marks.some((mark) => mark.type.name === "italic")).toBe(false);
    expect(
      text?.marks.find((mark) => mark.type.name === "fontSize")?.attrs.size,
    ).toBe(21);
    expect(
      text?.marks.find((mark) => mark.type.name === "fontFamily")?.attrs.ascii,
    ).toBe("Arial");
  });

  test("keeps oneNDA heading direct run formatting ahead of paragraph mark defaults", () => {
    const document: Document = {
      package: {
        document: {
          content: [
            {
              type: "paragraph",
              formatting: {
                runProperties: {
                  italic: true,
                  fontSize: 18,
                },
              },
              content: [
                {
                  type: "run",
                  formatting: {
                    bold: true,
                    fontSize: 20,
                  },
                  content: [{ type: "text", text: "PARTIES AND " }],
                },
              ],
            },
          ],
        },
      },
    };

    const doc = toProseDoc(document);
    const text = doc.firstChild?.firstChild;

    expect(text?.marks.some((mark) => mark.type.name === "bold")).toBe(true);
    expect(text?.marks.some((mark) => mark.type.name === "italic")).toBe(false);
    expect(
      text?.marks.find((mark) => mark.type.name === "fontSize")?.attrs.size,
    ).toBe(20);
  });

  test("applies oneNDA table style run properties before direct run properties", () => {
    const document: Document = {
      package: {
        styles: {
          styles: [
            {
              styleId: "TableStyle",
              type: "table",
              rPr: {
                bold: true,
                fontFamily: {
                  ascii: "Open Sans Light",
                  hAnsi: "Open Sans Light",
                },
              },
            },
          ],
        },
        document: {
          content: [
            {
              type: "table",
              formatting: { styleId: "TableStyle" },
              rows: [
                {
                  cells: [
                    {
                      content: [
                        {
                          type: "paragraph",
                          content: [
                            {
                              type: "run",
                              content: [{ type: "text", text: "Styled cell" }],
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

    const doc = toProseDoc(document, { styles: document.package.styles });
    const text = doc.firstChild?.firstChild?.firstChild?.firstChild?.firstChild;

    expect(text?.marks.some((mark) => mark.type.name === "bold")).toBe(true);
    expect(
      text?.marks.find((mark) => mark.type.name === "fontFamily")?.attrs.ascii,
    ).toBe("Open Sans Light");
  });

  test("applies built-in Word Normal defaults when styles.xml is absent", () => {
    const document: Document = {
      package: {
        document: {
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "run",
                  content: [{ type: "text", text: "Plain paragraph" }],
                },
              ],
            },
          ],
        },
      },
    };

    const doc = toProseDoc(document);
    const paragraph = doc.firstChild;

    expect(paragraph?.attrs.spaceAfter).toBe(160);
    expect(paragraph?.attrs.lineSpacing).toBe(259);
    expect(paragraph?.attrs.lineSpacingRule).toBe("auto");
  });

  test("keeps paragraph style run defaults above default character style", () => {
    const document: Document = {
      package: {
        styles: {
          styles: [
            {
              styleId: "Normal",
              type: "paragraph",
              default: true,
              rPr: {
                fontFamily: { ascii: "Arial", hAnsi: "Arial" },
              },
            },
            {
              styleId: "DefaultChar",
              type: "character",
              default: true,
              rPr: {
                fontFamily: { ascii: "Cambria", hAnsi: "Cambria" },
              },
            },
          ],
        },
        document: {
          content: [
            {
              type: "paragraph",
              formatting: { styleId: "Normal" },
              content: [
                {
                  type: "run",
                  content: [{ type: "text", text: "Plain paragraph" }],
                },
              ],
            },
          ],
        },
      },
    };

    const doc = toProseDoc(document, { styles: document.package.styles });
    const defaultTextFormatting = doc.firstChild?.attrs.defaultTextFormatting;

    expect(defaultTextFormatting?.fontFamily?.ascii).toBe("Arial");
    expect(defaultTextFormatting?.fontFamily?.hAnsi).toBe("Arial");
  });

  test("uses default character style when paragraph style has no run defaults", () => {
    const document: Document = {
      package: {
        styles: {
          styles: [
            {
              styleId: "Normal",
              type: "paragraph",
              default: true,
            },
            {
              styleId: "DefaultChar",
              type: "character",
              default: true,
              rPr: {
                fontFamily: { ascii: "Cambria", hAnsi: "Cambria" },
              },
            },
          ],
        },
        document: {
          content: [
            {
              type: "paragraph",
              formatting: { styleId: "Normal" },
              content: [
                {
                  type: "run",
                  content: [{ type: "text", text: "Plain paragraph" }],
                },
              ],
            },
          ],
        },
      },
    };

    const doc = toProseDoc(document, { styles: document.package.styles });
    const defaultTextFormatting = doc.firstChild?.attrs.defaultTextFormatting;

    expect(defaultTextFormatting?.fontFamily?.ascii).toBe("Cambria");
    expect(defaultTextFormatting?.fontFamily?.hAnsi).toBe("Cambria");
  });

  test("preserves DOCX field instruction and cached display text", () => {
    const document: Document = {
      package: {
        document: {
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "simpleField",
                  instruction: ' MERGEFIELD "Client Name" \\* MERGEFORMAT ',
                  fieldType: "MERGEFIELD",
                  content: [
                    {
                      type: "run",
                      content: [{ type: "text", text: "Acme s.r.o." }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    };

    const doc = toProseDoc(document);
    const field = doc.firstChild?.firstChild;

    expect(field?.type.name).toBe("field");
    expect(field?.attrs.fieldType).toBe("MERGEFIELD");
    expect(field?.attrs.instruction).toBe(
      ' MERGEFIELD "Client Name" \\* MERGEFORMAT ',
    );
    expect(field?.attrs.displayText).toBe("Acme s.r.o.");
    expect(field?.attrs.fieldKind).toBe("simple");
  });

  test("anchors point comments to nearby text for display", () => {
    const document: Document = {
      package: {
        document: {
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "run",
                  content: [{ type: "text", text: "Commented text" }],
                },
                { type: "commentReference", id: 42 },
              ],
            },
          ],
        },
      },
    };

    const doc = toProseDoc(document);
    const text = doc.firstChild?.firstChild;
    const commentMark = text?.marks.find(
      (mark) => mark.type.name === "comment",
    );

    expect(commentMark?.attrs.commentId).toBe(42);
  });

  test("applies active comment ranges to every text-emitting inline branch", () => {
    const document: Document = {
      package: {
        document: {
          content: [
            {
              type: "paragraph",
              content: [
                { type: "commentRangeStart", id: 99 },
                {
                  type: "run",
                  content: [{ type: "text", text: "plain" }],
                },
                {
                  type: "hyperlink",
                  href: "https://stella.law",
                  children: [
                    {
                      type: "run",
                      content: [{ type: "text", text: "link" }],
                    },
                  ],
                },
                {
                  type: "simpleField",
                  instruction: " PAGE ",
                  fieldType: "PAGE",
                  content: [
                    {
                      type: "run",
                      content: [{ type: "text", text: "1" }],
                    },
                  ],
                },
                {
                  type: "insertion",
                  info: { id: "rev-1", author: "User" },
                  content: [
                    {
                      type: "run",
                      content: [{ type: "text", text: "inserted" }],
                    },
                  ],
                },
                {
                  type: "mathEquation",
                  display: "inline",
                  ommlXml: "<m:oMath />",
                  plainText: "x",
                },
                { type: "commentRangeEnd", id: 99 },
              ],
            },
          ],
        },
      },
    };

    const doc = toProseDoc(document);
    const paragraph = doc.firstChild;
    const commentMarkedNodeTypes: string[] = [];

    for (let index = 0; index < (paragraph?.childCount ?? 0); index++) {
      const node = paragraph?.child(index);
      if (!node) {
        continue;
      }
      if (
        node.marks.some(
          (mark) => mark.type.name === "comment" && mark.attrs.commentId === 99,
        )
      ) {
        commentMarkedNodeTypes.push(node.type.name);
      }
    }

    expect(commentMarkedNodeTypes).toEqual(["text", "text", "text"]);
  });
});
