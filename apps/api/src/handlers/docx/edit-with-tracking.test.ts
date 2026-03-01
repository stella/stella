import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { editWithTracking } from "./edit-with-tracking";
import type { DocxEditSet, EditWithTrackingResult } from "./types";

const unwrap = (
  result: Result<EditWithTrackingResult, unknown>,
): EditWithTrackingResult => {
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};

/** Build a minimal but complete DOCX buffer. */
const makeDocx = async (
  documentXml: string,
  extras?: Record<string, string>,
): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/settings.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:defaultTabStop w:val="720"/>
</w:settings>`,
  );

  if (extras) {
    for (const [path, content] of Object.entries(extras)) {
      zip.file(path, content);
    }
  }

  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return Buffer.from(buf);
};

const WRAP = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  `<w:body>${body}</w:body></w:document>`;

const P = (text: string) =>
  `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

const AUTHOR = { name: "Stella AI", date: "2026-02-17T12:00:00Z" };

describe("editWithTracking", () => {
  test("applies edits and produces valid DOCX", async () => {
    const docx = await makeDocx(WRAP(P("Hello world") + P("Second line")));
    const editSet: DocxEditSet = {
      edits: [
        {
          kind: "replace",
          paragraphIndex: 0,
          charOffset: 6,
          length: 5,
          text: "earth",
        },
      ],
      comments: [],
      author: AUTHOR,
    };

    const { buffer } = unwrap(await editWithTracking(docx, editSet));

    expect(buffer).toBeInstanceOf(Buffer);
    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file("word/document.xml")?.async("string");
    expect(docXml).toContain("w:del");
    expect(docXml).toContain("w:ins");
    expect(docXml).toContain("earth");
  });

  test("enables track revisions in settings", async () => {
    const docx = await makeDocx(WRAP(P("Test")));
    const editSet: DocxEditSet = {
      edits: [
        {
          kind: "insert",
          paragraphIndex: 0,
          text: " edit",
        },
      ],
      comments: [],
      author: AUTHOR,
    };

    const { buffer } = unwrap(await editWithTracking(docx, editSet));
    const zip = await JSZip.loadAsync(buffer);
    const settings = await zip.file("word/settings.xml")?.async("string");
    expect(settings).toContain("w:trackRevisions");
  });

  test("injects comments and updates content types", async () => {
    const docx = await makeDocx(WRAP(P("Hello world")));
    const editSet: DocxEditSet = {
      edits: [],
      comments: [
        {
          paragraphIndex: 0,
          charOffset: 0,
          length: 5,
          text: "Check this greeting",
        },
      ],
      author: AUTHOR,
    };

    const { buffer } = unwrap(await editWithTracking(docx, editSet));
    const zip = await JSZip.loadAsync(buffer);

    // comments.xml should exist
    const commentsXml = await zip.file("word/comments.xml")?.async("string");
    expect(commentsXml).toBeDefined();
    expect(commentsXml).toContain("Check this greeting");
    expect(commentsXml).toContain("Stella AI");

    // document.xml should have comment anchors
    const docXml = await zip.file("word/document.xml")?.async("string");
    expect(docXml).toContain("w:commentRangeStart");
    expect(docXml).toContain("w:commentRangeEnd");
    expect(docXml).toContain("w:commentReference");

    // Content types should include comments
    const ctXml = await zip.file("[Content_Types].xml")?.async("string");
    expect(ctXml).toContain("comments+xml");

    // Rels should include comments relationship
    const relsXml = await zip
      .file("word/_rels/document.xml.rels")
      ?.async("string");
    expect(relsXml).toContain("comments.xml");
  });

  test("combines edits and comments", async () => {
    const docx = await makeDocx(WRAP(P("The quick brown fox")));
    const editSet: DocxEditSet = {
      edits: [
        {
          kind: "replace",
          paragraphIndex: 0,
          charOffset: 4,
          length: 5,
          text: "slow",
        },
      ],
      comments: [
        {
          paragraphIndex: 0,
          charOffset: 0,
          length: 3,
          text: "Consider removing article",
        },
      ],
      author: AUTHOR,
    };

    const { buffer } = unwrap(await editWithTracking(docx, editSet));
    const zip = await JSZip.loadAsync(buffer);

    const docXml = await zip.file("word/document.xml")?.async("string");
    // Should have both tracked changes and comments
    expect(docXml).toContain("w:del");
    expect(docXml).toContain("w:ins");
    expect(docXml).toContain("w:commentRangeStart");

    const commentsXml = await zip.file("word/comments.xml")?.async("string");
    expect(commentsXml).toContain("Consider removing article");
  });

  test("no-op when edits and comments are empty", async () => {
    const docx = await makeDocx(WRAP(P("Untouched")));
    const editSet: DocxEditSet = {
      edits: [],
      comments: [],
      author: AUTHOR,
    };

    const { buffer } = unwrap(await editWithTracking(docx, editSet));

    expect(buffer).toBeInstanceOf(Buffer);
    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file("word/document.xml")?.async("string");
    expect(docXml).toContain("Untouched");
    expect(docXml).not.toContain("w:del");
    expect(docXml).not.toContain("w:ins");
  });

  test("works on the SPA fixture", async () => {
    const fixture = new URL("./fixtures/spa-template.docx", import.meta.url)
      .pathname;
    const file = Bun.file(fixture);
    const docx = Buffer.from(await file.arrayBuffer());

    const editSet: DocxEditSet = {
      edits: [
        {
          kind: "insert",
          paragraphIndex: 0,
          text: " [DRAFT]",
        },
      ],
      comments: [
        {
          paragraphIndex: 0,
          charOffset: 0,
          length: 1,
          text: "Review this section",
        },
      ],
      author: AUTHOR,
    };

    const { buffer } = unwrap(await editWithTracking(docx, editSet));

    expect(buffer).toBeInstanceOf(Buffer);
    const zip = await JSZip.loadAsync(buffer);
    expect(zip.file("word/document.xml")).toBeTruthy();
    expect(zip.file("word/comments.xml")).toBeTruthy();
  });
});
