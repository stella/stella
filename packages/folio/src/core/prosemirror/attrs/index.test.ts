import { describe, expect, test } from "bun:test";

import {
  readFieldAttrs,
  expectParagraphAttrs,
  readCommentMarkAttrs,
  readFontSizeMarkAttrs,
  readHighlightMarkAttrs,
  readHyperlinkMarkAttrs,
  readImageAttrs,
  readMathAttrs,
  readParagraphAttrs,
  readSdtAttrs,
  readShapeAttrs,
  readTextBoxAttrs,
  readTrackedChangeMarkAttrs,
  readUnderlineMarkAttrs,
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

  test("rejects malformed paragraph preservation payloads", () => {
    const node = schema.nodes.paragraph.create({
      borders: { top: { style: "warp", size: "wide" } },
      shading: { pattern: "confetti", fill: { rgb: 12 } },
      tabs: [{ position: "720", alignment: "edge", leader: "spark" }],
      defaultTextFormatting: {
        bold: "yes",
        highlight: "neon",
        underline: { style: "zigzag" },
      },
      _sectionProperties: { pageWidth: "wide", orientation: "diagonal" },
      _propertyChanges: [
        {
          type: "runPropertyChange",
          info: { id: "1", author: 7 },
        },
      ],
    });

    const result = readParagraphAttrs(node);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected paragraph attrs to be rejected");
    }
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "paragraph.attrs.borders.top.style",
        "paragraph.attrs.borders.top.size",
        "paragraph.attrs.shading.pattern",
        "paragraph.attrs.shading.fill.rgb",
        "paragraph.attrs.tabs[0].position",
        "paragraph.attrs.tabs[0].alignment",
        "paragraph.attrs.tabs[0].leader",
        "paragraph.attrs.defaultTextFormatting.bold",
        "paragraph.attrs.defaultTextFormatting.highlight",
        "paragraph.attrs.defaultTextFormatting.underline.style",
        "paragraph.attrs._sectionProperties.pageWidth",
        "paragraph.attrs._sectionProperties.orientation",
        "paragraph.attrs._propertyChanges[0].type",
        "paragraph.attrs._propertyChanges[0].info.id",
        "paragraph.attrs._propertyChanges[0].info.author",
      ]),
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

  test("rejects malformed table preservation payloads", () => {
    const table = schema.nodes.table.create({
      cellMargins: { top: "tight" },
    });
    const cell = schema.nodes.tableCell.create({
      colspan: 1,
      rowspan: 1,
      borders: { left: { style: "cloud", color: { auto: "yes" } } },
      margins: { bottom: "low" },
    });

    const tableResult = readTableAttrs(table);
    const cellResult = readTableCellAttrs(cell);

    expect(tableResult.ok).toBe(false);
    if (!tableResult.ok) {
      expect(tableResult.issues.map((issue) => issue.path)).toContain(
        "table.attrs.cellMargins.top",
      );
    }
    expect(cellResult.ok).toBe(false);
    if (!cellResult.ok) {
      expect(cellResult.issues.map((issue) => issue.path)).toEqual(
        expect.arrayContaining([
          "tableCell.attrs.borders.left.style",
          "tableCell.attrs.borders.left.color.auto",
          "tableCell.attrs.margins.bottom",
        ]),
      );
    }
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

  test("rejects malformed field and math attrs", () => {
    const field = schema.nodes.field.create({
      fieldType: "NOT_A_FIELD",
      fieldKind: "nested",
      fldLock: "true",
    });
    const math = schema.nodes.math.create({
      display: "display",
      ommlXml: 42,
    });

    const fieldResult = readFieldAttrs(field);
    const mathResult = readMathAttrs(math);

    expect(fieldResult.ok).toBe(false);
    if (!fieldResult.ok) {
      expect(fieldResult.issues.map((issue) => issue.path)).toContain(
        "field.attrs.fieldType",
      );
      expect(fieldResult.issues.map((issue) => issue.path)).toContain(
        "field.attrs.fieldKind",
      );
      expect(fieldResult.issues.map((issue) => issue.path)).toContain(
        "field.attrs.fldLock",
      );
    }
    expect(mathResult.ok).toBe(false);
    if (!mathResult.ok) {
      expect(mathResult.issues.map((issue) => issue.path)).toContain(
        "math.attrs.display",
      );
      expect(mathResult.issues.map((issue) => issue.path)).toContain(
        "math.attrs.ommlXml",
      );
    }
  });

  test("rejects malformed SDT list item attrs", () => {
    const sdt = schema.nodes.sdt.create({
      sdtType: "custom",
      lock: "frozen",
      listItems: JSON.stringify([{ displayText: 7, value: null }]),
      checked: "true",
    });

    const result = readSdtAttrs(sdt);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected SDT attrs to be rejected");
    }
    expect(result.issues.map((issue) => issue.path)).toContain(
      "sdt.attrs.sdtType",
    );
    expect(result.issues.map((issue) => issue.path)).toContain(
      "sdt.attrs.lock",
    );
    expect(result.issues.map((issue) => issue.path)).toContain(
      "sdt.attrs.listItems[0].displayText",
    );
    expect(result.issues.map((issue) => issue.path)).toContain(
      "sdt.attrs.checked",
    );
  });

  test("rejects malformed shape and text box attrs", () => {
    const shape = schema.nodes.shape.create({
      fillType: "custom",
      gradientStops: JSON.stringify([{ position: "0", color: 7 }]),
      displayMode: "sideways",
    });
    const textBox = schema.nodes.textBox.create({
      width: "wide",
      cssFloat: "center",
    });

    const shapeResult = readShapeAttrs(shape);
    const textBoxResult = readTextBoxAttrs(textBox);

    expect(shapeResult.ok).toBe(false);
    if (!shapeResult.ok) {
      expect(shapeResult.issues.map((issue) => issue.path)).toContain(
        "shape.attrs.fillType",
      );
      expect(shapeResult.issues.map((issue) => issue.path)).toContain(
        "shape.attrs.gradientStops[0].position",
      );
      expect(shapeResult.issues.map((issue) => issue.path)).toContain(
        "shape.attrs.displayMode",
      );
    }
    expect(textBoxResult.ok).toBe(false);
    if (!textBoxResult.ok) {
      expect(textBoxResult.issues.map((issue) => issue.path)).toContain(
        "textBox.attrs.width",
      );
      expect(textBoxResult.issues.map((issue) => issue.path)).toContain(
        "textBox.attrs.cssFloat",
      );
    }
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

  test("rejects malformed text formatting mark attrs", () => {
    const underline = schema.marks.underline.create({
      style: "diagonal",
      color: { rgb: 123 },
    });
    const fontSize = schema.marks.fontSize.create({ size: "24" });
    const highlight = schema.marks.highlight.create({ color: "customYellow" });

    const underlineResult = readUnderlineMarkAttrs(underline);
    const fontSizeResult = readFontSizeMarkAttrs(fontSize);
    const highlightResult = readHighlightMarkAttrs(highlight);

    expect(underlineResult.ok).toBe(false);
    if (!underlineResult.ok) {
      expect(underlineResult.issues.map((issue) => issue.path)).toContain(
        "underline.attrs.style",
      );
      expect(underlineResult.issues.map((issue) => issue.path)).toContain(
        "underline.attrs.color.rgb",
      );
    }
    expect(fontSizeResult.ok).toBe(false);
    if (!fontSizeResult.ok) {
      expect(fontSizeResult.issues).toContainEqual({
        path: "fontSize.attrs.size",
        message: "Expected a number.",
      });
    }
    expect(highlightResult.ok).toBe(false);
    if (!highlightResult.ok) {
      expect(highlightResult.issues.map((issue) => issue.path)).toContain(
        "highlight.attrs.color",
      );
    }
  });

  test("rejects malformed comment and tracked-change mark attrs", () => {
    const comment = schema.marks.comment.create({ commentId: "7" });
    const insertion = schema.marks.insertion.create({
      revisionId: "42",
      author: 12,
      moveKind: "moveAround",
    });

    const commentResult = readCommentMarkAttrs(comment);
    const insertionResult = readTrackedChangeMarkAttrs(insertion);

    expect(commentResult.ok).toBe(false);
    if (!commentResult.ok) {
      expect(commentResult.issues).toContainEqual({
        path: "comment.attrs.commentId",
        message: "Expected a number.",
      });
    }
    expect(insertionResult.ok).toBe(false);
    if (!insertionResult.ok) {
      expect(insertionResult.issues.map((issue) => issue.path)).toContain(
        "insertion.attrs.revisionId",
      );
      expect(insertionResult.issues.map((issue) => issue.path)).toContain(
        "insertion.attrs.author",
      );
      expect(insertionResult.issues.map((issue) => issue.path)).toContain(
        "insertion.attrs.moveKind",
      );
    }
  });
});
