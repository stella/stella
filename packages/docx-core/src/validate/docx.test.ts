import { describe, expect, test } from "bun:test";

import type {
  BlockContent,
  Comment,
  Document,
  Paragraph,
  ParagraphContent,
  Run,
} from "../model/document";
import { assertValidDocumentModel, validateDocumentModel } from "./docx";

const textRun = (text = "Text"): Run => ({
  type: "run",
  content: [{ type: "text", text }],
});

const paragraph = (content: ParagraphContent[] = [textRun()]): Paragraph => ({
  type: "paragraph",
  content,
});

type CreateDocumentOptions = {
  content?: BlockContent[];
  comments?: Comment[];
  footnotes?: Document["package"]["footnotes"];
  headers?: Document["package"]["headers"];
  numbering?: Document["package"]["numbering"];
};

const createDocument = ({
  content = [paragraph()],
  comments,
  footnotes,
  headers,
  numbering,
}: CreateDocumentOptions = {}): Document => ({
  package: {
    document: {
      content,
      ...(comments !== undefined ? { comments } : {}),
    },
    ...(footnotes !== undefined ? { footnotes } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(numbering !== undefined ? { numbering } : {}),
  },
});

describe("canonical DOCX document model validation", () => {
  test("accepts a document with balanced comments and numbering", () => {
    const doc = createDocument({
      content: [
        paragraph([
          { type: "commentRangeStart", id: 1 },
          textRun("Reviewed clause"),
          { type: "commentRangeEnd", id: 1 },
          { type: "commentReference", id: 1 },
        ]),
        {
          type: "paragraph",
          formatting: { numPr: { numId: 7, ilvl: 0 } },
          content: [textRun("Numbered clause")],
        },
      ],
      comments: [
        {
          id: 1,
          author: "Reviewer",
          content: [paragraph([textRun("Looks good")])],
        },
      ],
      numbering: {
        abstractNums: [
          {
            abstractNumId: 3,
            levels: [{ ilvl: 0, numFmt: "decimal", lvlText: "%1." }],
          },
        ],
        nums: [{ numId: 7, abstractNumId: 3 }],
      },
    });

    const result = validateDocumentModel(doc);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(() => assertValidDocumentModel(doc)).not.toThrow();
  });

  test("rejects comment anchors without a matching comment", () => {
    const result = validateDocumentModel(
      createDocument({
        content: [paragraph([{ type: "commentReference", id: 42 }])],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toContain(
      "Comment 42 is referenced but not present in comments.xml.",
    );
  });

  test("rejects unbalanced comment ranges", () => {
    const result = validateDocumentModel(
      createDocument({
        content: [paragraph([{ type: "commentRangeStart", id: 5 }, textRun()])],
        comments: [{ id: 5, author: "Reviewer", content: [paragraph()] }],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toContain(
      "Unbalanced comment range 5: commentRangeStart=1, commentRangeEnd=0.",
    );
  });

  test("rejects invalid table shape", () => {
    const result = validateDocumentModel(
      createDocument({
        content: [
          {
            type: "table",
            rows: [
              {
                type: "tableRow",
                cells: [{ type: "tableCell", content: [] }],
              },
            ],
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toContain(
      "Table cell must contain block content.",
    );
  });

  test("rejects missing numbering definitions", () => {
    const result = validateDocumentModel(
      createDocument({
        content: [
          {
            type: "paragraph",
            formatting: { numPr: { numId: 9, ilvl: 0 } },
            content: [textRun()],
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toContain(
      "Numbering definition 9 is missing.",
    );
  });

  test("rejects missing footnote packages", () => {
    const result = validateDocumentModel(
      createDocument({
        content: [
          paragraph([
            { type: "run", content: [{ type: "footnoteRef", id: 12 }] },
          ]),
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toContain(
      "Footnote 12 is referenced but not present in the package.",
    );
  });

  test("rejects section header references without a matching header part", () => {
    const result = validateDocumentModel(
      createDocument({
        content: [
          {
            type: "paragraph",
            content: [textRun()],
            sectionProperties: {
              headerReferences: [{ type: "default", rId: "rIdHeader1" }],
            },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toContain(
      "Section references missing header rIdHeader1.",
    );
  });
});
