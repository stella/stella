import { describe, expect, test } from "bun:test";

import {
  expectParagraphAttrs,
  readHyperlinkMarkAttrs,
  readImageAttrs,
  readParagraphAttrs,
  readTableAttrs,
  readTableCellAttrs,
  readTableRowAttrs,
} from ".";
import { schema } from "../schema";

const issueMessages = (result: ReturnType<typeof readParagraphAttrs>) => {
  if (result.ok) {
    return [];
  }

  return result.issues.map((issue) => issue.message);
};

describe("ProseMirror attr readers", () => {
  test("accepts valid paragraph attrs with preservation payloads", () => {
    const node = schema.nodes.paragraph.create({
      paraId: "para-1",
      numPr: { numId: 4, ilvl: 1 },
      bookmarks: [{ id: 7, name: "_Ref7" }],
      _sectionProperties: { sectionStart: "nextPage" },
      _propertyChanges: [],
    });

    const result = readParagraphAttrs(node);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected paragraph attrs to parse");
    }
    expect(result.value.numPr?.numId).toBe(4);
    expect(result.value.bookmarks?.at(0)?.name).toBe("_Ref7");
    expect(expectParagraphAttrs(node).paraId).toBe("para-1");
  });

  test("rejects malformed paragraph attrs", () => {
    const node = schema.nodes.paragraph.create({
      numPr: { numId: "bad" },
      bookmarks: [{ id: "bad", name: 7 }],
    });

    const result = readParagraphAttrs(node);

    expect(result.ok).toBe(false);
    expect(issueMessages(result)).toContain("Expected a number.");
    expect(() => expectParagraphAttrs(node)).toThrow(
      "Invalid ProseMirror paragraph attrs",
    );
  });

  test("rejects malformed table column widths", () => {
    const node = schema.nodes.table.create({
      columnWidths: [1200, "bad"],
    });

    const result = readTableAttrs(node);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected table attrs to be rejected");
    }
    expect(result.issues.map((issue) => issue.path)).toContain(
      "table.attrs.columnWidths[1]",
    );
  });

  test("rejects invalid table row finite attrs", () => {
    const node = schema.nodes.tableRow.create({
      heightRule: "sometimes",
    });

    const result = readTableRowAttrs(node);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected table row attrs to be rejected");
    }
    expect(result.issues.map((issue) => issue.path)).toContain(
      "tableRow.attrs.heightRule",
    );
  });

  test("accepts nullable ProseMirror table cell colwidth", () => {
    const node = schema.nodes.tableCell.create({
      colspan: 1,
      rowspan: 1,
      colwidth: null,
    });

    const result = readTableCellAttrs(node);

    expect(result.ok).toBe(true);
  });

  test("rejects invalid image finite and nested position attrs", () => {
    const node = schema.nodes.image.create({
      src: "media/image.png",
      wrapText: "diagonal",
      position: {
        horizontal: { relativeTo: "viewport", posOffset: "bad" },
      },
    });

    const result = readImageAttrs(node);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected image attrs to be rejected");
    }
    expect(result.issues.map((issue) => issue.path)).toContain(
      "image.attrs.wrapText",
    );
    expect(result.issues.map((issue) => issue.path)).toContain(
      "image.attrs.position.horizontal.relativeTo",
    );
    expect(result.issues.map((issue) => issue.path)).toContain(
      "image.attrs.position.horizontal.posOffset",
    );
  });

  test("rejects malformed hyperlink mark attrs", () => {
    const mark = schema.marks.hyperlink.create({ href: 42 });

    const result = readHyperlinkMarkAttrs(mark);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected hyperlink attrs to be rejected");
    }
    expect(result.issues).toContainEqual({
      path: "hyperlink.attrs.href",
      message: "Expected a string.",
    });
  });
});
