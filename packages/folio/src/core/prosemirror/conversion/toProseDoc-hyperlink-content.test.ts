// Regression eigenpal #566: tabs (and other non-text run content) inside
// <w:hyperlink> were dropped by convertHyperlink, which only carried
// `content.type === "text"` into the PM doc. TOC entries store the title
// and the right-aligned page number inside a single hyperlink with a
// w:tab between them — without the tab, the page number renders flush
// against the title and the entry no longer looks like a TOC line.

import { describe, expect, test } from "bun:test";

import type { Document, Hyperlink, Paragraph } from "../../types/document";
import { toProseDoc } from "./toProseDoc";

const docWithHyperlink = (hyperlink: Hyperlink): Document => {
  const paragraph: Paragraph = {
    type: "paragraph",
    content: [hyperlink],
  };
  return {
    package: {
      document: {
        content: [paragraph],
      },
    },
  };
};

describe("convertHyperlink preserves non-text run content", () => {
  test("preserves a w:tab inside a hyperlink (TOC title→page-number)", () => {
    const hyperlink: Hyperlink = {
      type: "hyperlink",
      anchor: "_Toc1",
      children: [
        {
          type: "run",
          content: [{ type: "text", text: "Section 1" }],
        },
        {
          type: "run",
          content: [{ type: "tab" }],
        },
        {
          type: "run",
          content: [{ type: "text", text: "5" }],
        },
      ],
    };

    const pmDoc = toProseDoc(docWithHyperlink(hyperlink));
    const paragraph = pmDoc.firstChild;
    expect(paragraph?.type.name).toBe("paragraph");
    const childTypes: string[] = [];
    if (paragraph) {
      for (let i = 0; i < paragraph.childCount; i++) {
        childTypes.push(paragraph.child(i).type.name);
      }
    }
    // The tab node must survive into the PM doc — the bug was dropping it
    // entirely. Text children on both sides must still carry the hyperlink
    // mark (clickable title and page number). The tab node itself doesn't
    // need the mark — PM tabs typically don't accept inline marks.
    expect(childTypes).toContain("tab");
    expect(childTypes.filter((n) => n === "text")).toHaveLength(2);
    if (paragraph) {
      for (let i = 0; i < paragraph.childCount; i++) {
        const child = paragraph.child(i);
        if (child.type.name === "text") {
          expect(child.marks.some((m) => m.type.name === "hyperlink")).toBe(
            true,
          );
        }
      }
    }
  });

  test("preserves a w:br inside a hyperlink", () => {
    const hyperlink: Hyperlink = {
      type: "hyperlink",
      href: "https://example.com",
      children: [
        {
          type: "run",
          content: [{ type: "text", text: "Line A" }],
        },
        {
          type: "run",
          content: [{ type: "break", breakType: "textWrapping" }],
        },
        {
          type: "run",
          content: [{ type: "text", text: "Line B" }],
        },
      ],
    };

    const pmDoc = toProseDoc(docWithHyperlink(hyperlink));
    const paragraph = pmDoc.firstChild;
    const childTypes: string[] = [];
    if (paragraph) {
      for (let i = 0; i < paragraph.childCount; i++) {
        childTypes.push(paragraph.child(i).type.name);
      }
    }
    expect(childTypes).toContain("hardBreak");
    expect(childTypes.filter((n) => n === "text")).toHaveLength(2);
  });
});
