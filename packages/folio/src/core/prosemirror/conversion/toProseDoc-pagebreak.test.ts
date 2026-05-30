import { describe, expect, test } from "bun:test";

import type { Document } from "../../types/document";
import { toProseDoc } from "./toProseDoc";

function childTypeNames(pmDoc: ReturnType<typeof toProseDoc>): string[] {
  const names: string[] = [];
  for (let i = 0; i < pmDoc.childCount; i++) {
    names.push(pmDoc.child(i).type.name);
  }
  return names;
}

describe('toProseDoc — hard page break (`<w:br w:type="page"/>`)', () => {
  test("emits pageBreak for a paragraph whose only run content is a page break", () => {
    // <w:p><w:r><w:br w:type="page"/></w:r></w:p>
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
                  content: [{ type: "break", breakType: "page" }],
                },
              ],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "run",
                  content: [{ type: "text", text: "After" }],
                },
              ],
            },
          ],
        },
      },
    };

    const pmDoc = toProseDoc(document);
    expect(childTypeNames(pmDoc)).toContain("pageBreak");
  });

  test("emits pageBreak after text for a paragraph with text followed by a break", () => {
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
              type: "paragraph",
              content: [
                {
                  type: "run",
                  content: [{ type: "text", text: "After" }],
                },
              ],
            },
          ],
        },
      },
    };

    const pmDoc = toProseDoc(document);
    expect(childTypeNames(pmDoc)).toEqual([
      "paragraph",
      "pageBreak",
      "paragraph",
    ]);
  });

  test("emits pageBreak when the break sits inside a hyperlink wrapper", () => {
    // <w:p><w:hyperlink><w:r><w:br w:type="page"/></w:r></w:hyperlink></w:p>
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
                  type: "hyperlink",
                  url: "https://example.com",
                  children: [
                    {
                      type: "run",
                      content: [{ type: "break", breakType: "page" }],
                    },
                  ],
                },
              ],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "run",
                  content: [{ type: "text", text: "After" }],
                },
              ],
            },
          ],
        },
      },
    };

    const pmDoc = toProseDoc(document);
    expect(childTypeNames(pmDoc)).toContain("pageBreak");
  });

  test("emits pageBreak when the break sits inside an inlineSdt wrapper", () => {
    // <w:p><w:sdt><w:sdtContent><w:r><w:br w:type="page"/></w:r></w:sdtContent></w:sdt></w:p>
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
                  type: "inlineSdt",
                  properties: { sdtType: "richText" },
                  content: [
                    {
                      type: "run",
                      content: [{ type: "break", breakType: "page" }],
                    },
                  ],
                },
              ],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "run",
                  content: [{ type: "text", text: "After" }],
                },
              ],
            },
          ],
        },
      },
    };

    const pmDoc = toProseDoc(document);
    expect(childTypeNames(pmDoc)).toContain("pageBreak");
  });

  test('classifies a break after a softHyphen as "after"', () => {
    // <w:p><w:r><w:softHyphen/><w:br w:type="page"/></w:r></w:p>
    // The soft hyphen is visible run content, so the break belongs after the
    // paragraph (paragraph stays on the current page, next block starts new).
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
                    { type: "softHyphen" },
                    { type: "break", breakType: "page" },
                  ],
                },
              ],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "run",
                  content: [{ type: "text", text: "After" }],
                },
              ],
            },
          ],
        },
      },
    };

    const pmDoc = toProseDoc(document);
    expect(childTypeNames(pmDoc)).toEqual([
      "paragraph",
      "pageBreak",
      "paragraph",
    ]);
  });

  test('classifies a break after a mathEquation as "after"', () => {
    // Math equation is visible inline content; a subsequent break sits "after".
    const document: Document = {
      package: {
        document: {
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "mathEquation",
                  display: "inline",
                  ommlXml: "<m:oMath/>",
                },
                {
                  type: "run",
                  content: [{ type: "break", breakType: "page" }],
                },
              ],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "run",
                  content: [{ type: "text", text: "After" }],
                },
              ],
            },
          ],
        },
      },
    };

    const pmDoc = toProseDoc(document);
    expect(childTypeNames(pmDoc)).toEqual([
      "paragraph",
      "pageBreak",
      "paragraph",
    ]);
  });

  test('classifies a break after an empty hyperlink as "before"', () => {
    // <w:p><w:hyperlink/><w:r><w:br w:type="page"/></w:r><w:r><w:t>x</w:t></w:r></w:p>
    // Empty hyperlinks (bookmark-only or round-trip placeholders) carry no
    // visible content, so the break must still classify as "before" and the
    // following text belongs on the next page.
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
                  type: "hyperlink",
                  url: "https://example.com",
                  children: [],
                },
                {
                  type: "run",
                  content: [{ type: "break", breakType: "page" }],
                },
                {
                  type: "run",
                  content: [{ type: "text", text: "AfterBreak" }],
                },
              ],
            },
          ],
        },
      },
    };

    const pmDoc = toProseDoc(document);
    const names = childTypeNames(pmDoc);
    // pageBreak must appear BEFORE the paragraph containing "AfterBreak"
    const pageBreakIndex = names.indexOf("pageBreak");
    expect(pageBreakIndex).toBeGreaterThan(-1);
    // The trailing paragraph (with "AfterBreak") must come after the break.
    expect(pageBreakIndex).toBeLessThan(names.length - 1);
    expect(names[pageBreakIndex + 1]).toBe("paragraph");
  });

  test("emits pageBreak when the break sits inside a tracked-change wrapper", () => {
    // <w:p><w:ins><w:r><w:br w:type="page"/></w:r></w:ins></w:p>
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
                  type: "insertion",
                  info: {
                    id: 1,
                    author: "Author",
                    date: "2026-01-01T00:00:00Z",
                  },
                  content: [
                    {
                      type: "run",
                      content: [{ type: "break", breakType: "page" }],
                    },
                  ],
                },
              ],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "run",
                  content: [{ type: "text", text: "After" }],
                },
              ],
            },
          ],
        },
      },
    };

    const pmDoc = toProseDoc(document);
    expect(childTypeNames(pmDoc)).toContain("pageBreak");
  });
});
