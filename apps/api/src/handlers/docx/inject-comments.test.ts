import { describe, expect, test } from "bun:test";

import { injectComments } from "./inject-comments";
import type { DocxComment, RevisionAuthor } from "./types";

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

const P = (text: string) =>
  `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

describe("injectComments", () => {
  test("inserts comment anchors into document.xml", () => {
    const xml = WRAP(P("Hello world"));
    const comments: DocxComment[] = [
      {
        paragraphIndex: 0,
        charOffset: 6,
        length: 5,
        text: "Should this be 'earth'?",
      },
    ];

    nextId = 1;
    const result = injectComments(xml, null, comments, AUTHOR, idGen);

    expect(result.documentXml).toContain("w:commentRangeStart");
    expect(result.documentXml).toContain("w:commentRangeEnd");
    expect(result.documentXml).toContain("w:commentReference");
  });

  test("builds comments.xml with comment content", () => {
    const xml = WRAP(P("Hello world"));
    const comments: DocxComment[] = [
      {
        paragraphIndex: 0,
        charOffset: 0,
        length: 5,
        text: "Check greeting",
      },
    ];

    nextId = 1;
    const result = injectComments(xml, null, comments, AUTHOR, idGen);

    expect(result.commentsXml).toContain("w:comments");
    expect(result.commentsXml).toContain("w:comment");
    expect(result.commentsXml).toContain("Check greeting");
    expect(result.commentsXml).toContain('w:author="Stella AI"');
  });

  test("multiple comments get unique IDs", () => {
    const xml = WRAP(P("First paragraph") + P("Second paragraph"));
    const comments: DocxComment[] = [
      {
        paragraphIndex: 0,
        charOffset: 0,
        length: 5,
        text: "Comment 1",
      },
      {
        paragraphIndex: 1,
        charOffset: 0,
        length: 6,
        text: "Comment 2",
      },
    ];

    nextId = 10;
    const result = injectComments(xml, null, comments, AUTHOR, idGen);

    // Both comments should appear
    expect(result.commentsXml).toContain("Comment 1");
    expect(result.commentsXml).toContain("Comment 2");

    // Should have two commentRangeStart elements
    const startCount = (result.documentXml.match(/w:commentRangeStart/gu) ?? [])
      .length;
    expect(startCount).toBe(2);
  });

  test("merges with existing comments.xml", () => {
    const xml = WRAP(P("Hello world"));
    const existingComments =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:comment w:id="1" w:author="Human" w:date="2026-01-01T00:00:00Z">` +
      "<w:p><w:r><w:t>Existing comment</w:t></w:r></w:p>" +
      "</w:comment></w:comments>";

    const comments: DocxComment[] = [
      {
        paragraphIndex: 0,
        charOffset: 0,
        length: 5,
        text: "New comment",
      },
    ];

    nextId = 50;
    const result = injectComments(
      xml,
      existingComments,
      comments,
      AUTHOR,
      idGen,
    );

    expect(result.commentsXml).toContain("Existing comment");
    expect(result.commentsXml).toContain("New comment");
  });

  test("handles out-of-range paragraph gracefully", () => {
    const xml = WRAP(P("Only paragraph"));
    const comments: DocxComment[] = [
      {
        paragraphIndex: 99,
        charOffset: 0,
        length: 5,
        text: "This should not crash",
      },
    ];

    nextId = 1;
    const result = injectComments(xml, null, comments, AUTHOR, idGen);

    // Should not add anchors to document
    expect(result.documentXml).not.toContain("w:commentRangeStart");
    // But comments.xml still gets the comment
    expect(result.commentsXml).toContain("w:comments");
  });

  test("comment reference uses CommentReference style", () => {
    const xml = WRAP(P("Test text"));
    const comments: DocxComment[] = [
      {
        paragraphIndex: 0,
        charOffset: 0,
        length: 4,
        text: "A note",
      },
    ];

    nextId = 1;
    const result = injectComments(xml, null, comments, AUTHOR, idGen);

    expect(result.documentXml).toContain("CommentReference");
  });
});
