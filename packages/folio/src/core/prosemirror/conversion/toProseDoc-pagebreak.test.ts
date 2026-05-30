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
