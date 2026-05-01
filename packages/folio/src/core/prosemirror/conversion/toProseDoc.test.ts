import { describe, expect, test } from "bun:test";

import type { Document } from "../../types/document";
import { toProseDoc } from "./toProseDoc";

describe("toProseDoc", () => {
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
