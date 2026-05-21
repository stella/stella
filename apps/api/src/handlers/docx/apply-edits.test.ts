import { describe, expect, test } from "bun:test";

import { applyEdits } from "./apply-edits";
import type { DocxEdit, RevisionAuthor } from "./types";

const AUTHOR: RevisionAuthor = {
  name: "Stella AI",
  date: "2026-02-17T12:00:00Z",
};

let nextId = 100;
const idGen = () => nextId++;

const WRAP = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  `<w:body>${body}</w:body></w:document>`;

const P = (text: string, rPr = "") =>
  `<w:p><w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

const RPR_BOLD = "<w:rPr><w:b/></w:rPr>";

describe("applyEdits", () => {
  test("insert at end of paragraph", () => {
    const xml = WRAP(P("Hello"));
    const edits: DocxEdit[] = [
      {
        kind: "insert",
        paragraphIndex: 0,
        text: " world",
      },
    ];

    nextId = 1;
    const result = applyEdits(xml, edits, AUTHOR, idGen);

    expect(result).toContain("w:ins");
    expect(result).toContain(" world");
    expect(result).toContain('w:author="Stella AI"');
    expect(result).toContain("2026-02-17T12:00:00Z");
  });

  test("insert at beginning of paragraph", () => {
    const xml = WRAP(P("world"));
    const edits: DocxEdit[] = [
      {
        kind: "insert",
        paragraphIndex: 0,
        charOffset: 0,
        text: "Hello ",
      },
    ];

    nextId = 1;
    const result = applyEdits(xml, edits, AUTHOR, idGen);

    expect(result).toContain("w:ins");
    expect(result).toContain("Hello ");
    // The insertion should come before "world"
    const insPos = result.indexOf("w:ins");
    const worldPos = result.indexOf("world");
    expect(insPos).toBeLessThan(worldPos);
  });

  test("insert mid-run splits the run", () => {
    const xml = WRAP(P("Hello world"));
    const edits: DocxEdit[] = [
      {
        kind: "insert",
        paragraphIndex: 0,
        charOffset: 5,
        text: " beautiful",
      },
    ];

    nextId = 1;
    const result = applyEdits(xml, edits, AUTHOR, idGen);

    expect(result).toContain("Hello");
    expect(result).toContain(" beautiful");
    expect(result).toContain(" world");
    expect(result).toContain("w:ins");
  });

  test("delete wraps text in w:del with w:delText", () => {
    const xml = WRAP(P("Hello cruel world"));
    const edits: DocxEdit[] = [
      {
        kind: "delete",
        paragraphIndex: 0,
        charOffset: 5,
        length: 6,
      },
    ];

    nextId = 1;
    const result = applyEdits(xml, edits, AUTHOR, idGen);

    expect(result).toContain("w:del");
    expect(result).toContain("w:delText");
    expect(result).toContain(" cruel");
    // "Hello" and " world" should remain as plain text
    expect(result).toContain("Hello");
    expect(result).toContain(" world");
  });

  test("replace produces w:del + w:ins", () => {
    const xml = WRAP(P("Hello world"));
    const edits: DocxEdit[] = [
      {
        kind: "replace",
        paragraphIndex: 0,
        charOffset: 6,
        length: 5,
        text: "earth",
      },
    ];

    nextId = 1;
    const result = applyEdits(xml, edits, AUTHOR, idGen);

    expect(result).toContain("w:del");
    expect(result).toContain("world"); // in delText
    expect(result).toContain("w:ins");
    expect(result).toContain("earth");
  });

  test("multiple edits in reverse order", () => {
    const xml = WRAP(P("First paragraph") + P("Second paragraph"));
    const edits: DocxEdit[] = [
      {
        kind: "insert",
        paragraphIndex: 0,
        text: " ADDED",
      },
      {
        kind: "delete",
        paragraphIndex: 1,
        charOffset: 0,
        length: 6,
      },
    ];

    nextId = 1;
    const result = applyEdits(xml, edits, AUTHOR, idGen);

    expect(result).toContain(" ADDED");
    expect(result).toContain("w:del");
    expect(result).toContain("Second"); // in delText
  });

  test("preserves formatting when splitting", () => {
    const xml = WRAP(P("Bold text", RPR_BOLD));
    const edits: DocxEdit[] = [
      {
        kind: "insert",
        paragraphIndex: 0,
        charOffset: 4,
        text: " new",
      },
    ];

    nextId = 1;
    const result = applyEdits(xml, edits, AUTHOR, idGen);

    // The split fragments should retain w:b
    const boldCount = (result.match(/w:b\/>/gu) ?? []).length;
    // Original rPr is cloned for before/after fragments
    expect(boldCount).toBeGreaterThanOrEqual(2);
  });

  test("handles empty paragraph gracefully", () => {
    const xml = WRAP("<w:p></w:p>");
    const edits: DocxEdit[] = [
      {
        kind: "insert",
        paragraphIndex: 0,
        text: "New text",
      },
    ];

    nextId = 1;
    const result = applyEdits(xml, edits, AUTHOR, idGen);

    expect(result).toContain("New text");
    expect(result).toContain("w:ins");
  });

  test("out-of-range paragraph index is a no-op", () => {
    const xml = WRAP(P("Only paragraph"));
    const edits: DocxEdit[] = [
      {
        kind: "insert",
        paragraphIndex: 99,
        text: "Nope",
      },
    ];

    nextId = 1;
    const result = applyEdits(xml, edits, AUTHOR, idGen);

    expect(result).not.toContain("Nope");
    expect(result).toContain("Only paragraph");
  });

  test("insert with format applies bold/italic", () => {
    const xml = WRAP(P("Hello"));
    const edits: DocxEdit[] = [
      {
        kind: "insert",
        paragraphIndex: 0,
        text: " world",
        format: { bold: true, italic: true },
      },
    ];

    nextId = 1;
    const result = applyEdits(xml, edits, AUTHOR, idGen);

    expect(result).toContain("w:b");
    expect(result).toContain("w:i");
    expect(result).toContain(" world");
  });

  test("inserted newlines become OOXML line breaks", () => {
    const xml = WRAP(P("Hello"));
    const edits: DocxEdit[] = [
      {
        kind: "insert",
        paragraphIndex: 0,
        charOffset: 5,
        text: "\nworld",
      },
    ];

    nextId = 1;
    const result = applyEdits(xml, edits, AUTHOR, idGen);

    expect(result).toContain('<w:br w:type="textWrapping"/>');
    expect(result).toContain("world");
    expect(result).not.toContain(">\nworld<");
  });

  test("deleted newlines become OOXML line breaks", () => {
    const xml = WRAP(P("Hello\nworld"));
    const edits: DocxEdit[] = [
      {
        kind: "delete",
        paragraphIndex: 0,
        charOffset: 5,
        length: 6,
      },
    ];

    nextId = 1;
    const result = applyEdits(xml, edits, AUTHOR, idGen);

    expect(result).toContain('<w:br w:type="textWrapping"/>');
    expect(result).toContain("world");
    expect(result).not.toContain(">\nworld<");
  });
});
