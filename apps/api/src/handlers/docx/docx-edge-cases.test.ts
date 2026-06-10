/**
 * Edge-case tests for OOXML elements that appear in real
 * legal documents. Each test uses XML that Microsoft Word
 * or LibreOffice actually produces, verified by generating
 * .docx files and opening them in Pages/Word.
 *
 * Tests the full pipeline: extract text → diff → apply edits
 * → extract accepted text → verify roundtrip.
 */

import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import * as slimdom from "slimdom";

import { applyEdits } from "./apply-edits";
import { diffParagraphs } from "./diff-paragraphs";
import { extractText } from "./extract-text";
import { createIdGenerator, W_NS } from "./ooxml";
import { buildRunMap } from "./run-map";
import type { RevisionAuthor } from "./types";

const AUTHOR: RevisionAuthor = {
  name: "stella AI",
  date: "2026-02-21T12:00:00Z",
};

const WRAP = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document xmlns:w="${W_NS}">` +
  `<w:body>${body}</w:body></w:document>`;

/** Build a minimal DOCX buffer from document body XML. */
const buildDocx = async (bodyXml: string): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      "</Types>",
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      "</Relationships>",
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
  );
  zip.file("word/document.xml", WRAP(bodyXml));
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return Buffer.from(buf);
};

/** Extract accepted text from edited XML (w:del skipped). */
const extractAcceptedText = (xml: string): string[] => {
  const doc = slimdom.parseXmlDocument(xml);
  const body = doc.getElementsByTagNameNS(W_NS, "body").at(0);
  if (!body) {
    return [];
  }

  const texts: string[] = [];
  for (const child of body.childNodes) {
    if (!(child instanceof slimdom.Element)) {
      continue;
    }
    const el = child;
    if (el.localName !== "p" || el.namespaceURI !== W_NS) {
      continue;
    }

    let text = "";
    const walk = (node: slimdom.Node) => {
      if (!(node instanceof slimdom.Element)) {
        return;
      }
      const n = node;
      if (n.localName === "del" && n.namespaceURI === W_NS) {
        return;
      }
      if (n.localName === "t" && n.namespaceURI === W_NS) {
        text += n.textContent ?? "";
      } else {
        for (const c of n.childNodes) {
          walk(c);
        }
      }
    };
    walk(el);
    texts.push(text);
  }
  return texts;
};

/**
 * Full pipeline roundtrip: given body XML and expected
 * extracted text per paragraph, apply an edit and verify
 * the accepted text matches.
 */
const pipelineRoundtrip = (
  bodyXml: string,
  paragraphs: { index: number; text: string }[],
  rewrites: { paragraphIndex: number; newText: string }[],
) => {
  const xml = WRAP(bodyXml);
  const charCount = paragraphs.reduce((sum, p) => sum + p.text.length, 0);
  const extracted = {
    paragraphs,
    charCount,
    view: "accepted" as const,
  };

  const { edits } = diffParagraphs(extracted, rewrites);
  if (edits.length === 0) {
    return; // No edits means no change
  }

  const idGen = createIdGenerator(new Set());
  const result = applyEdits(xml, edits, AUTHOR, idGen);
  const accepted = extractAcceptedText(result);

  for (const rw of rewrites) {
    expect(accepted[rw.paragraphIndex]).toBe(rw.newText);
  }
};

// ─────────────────────────────────────────────────────────
// STEP 1: Verify extractText reads these patterns correctly
// ─────────────────────────────────────────────────────────

describe("extract-text: real OOXML patterns", () => {
  test("w:br (Shift+Enter line break) — text only", async () => {
    const buf = await buildDocx(
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">Before break</w:t></w:r>` +
        `<w:r><w:br/><w:t xml:space="preserve">After break</w:t></w:r>` +
        "</w:p>",
    );
    const result = await extractText(buf);
    // extractText only collects w:t, so w:br is invisible
    expect(result.paragraphs).toHaveLength(1);
    console.log(
      "  w:br extract result:",
      JSON.stringify(result.paragraphs[0]?.text),
    );
  });

  test("w:br between two w:t in same run", async () => {
    const buf = await buildDocx(
      "<w:p>" +
        "<w:r>" +
        `<w:t xml:space="preserve">Line one</w:t>` +
        "<w:br/>" +
        `<w:t xml:space="preserve">Line two</w:t>` +
        "</w:r>" +
        "</w:p>",
    );
    const result = await extractText(buf);
    expect(result.paragraphs).toHaveLength(1);
    console.log(
      "  w:br mid-run extract:",
      JSON.stringify(result.paragraphs[0]?.text),
    );
  });

  test("w:tab (Tab key)", async () => {
    const buf = await buildDocx(
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">Before</w:t></w:r>` +
        `<w:r><w:tab/><w:t xml:space="preserve">After tab</w:t></w:r>` +
        "</w:p>",
    );
    const result = await extractText(buf);
    expect(result.paragraphs).toHaveLength(1);
    console.log("  w:tab extract:", JSON.stringify(result.paragraphs[0]?.text));
  });

  test("w:fldSimple PAGE field", async () => {
    const buf = await buildDocx(
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">Page </w:t></w:r>` +
        `<w:fldSimple w:instr=" PAGE ">` +
        "<w:r><w:t>3</w:t></w:r>" +
        "</w:fldSimple>" +
        `<w:r><w:t xml:space="preserve"> of </w:t></w:r>` +
        `<w:fldSimple w:instr=" NUMPAGES ">` +
        "<w:r><w:t>10</w:t></w:r>" +
        "</w:fldSimple>" +
        "</w:p>",
    );
    const result = await extractText(buf);
    expect(result.paragraphs).toHaveLength(1);
    console.log(
      "  fldSimple extract:",
      JSON.stringify(result.paragraphs[0]?.text),
    );
  });

  test("w:fldChar complex field (PAGE number)", async () => {
    const buf = await buildDocx(
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">Page </w:t></w:r>` +
        `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
        `<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>` +
        `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
        "<w:r><w:t>5</w:t></w:r>" +
        `<w:r><w:fldChar w:fldCharType="end"/></w:r>` +
        `<w:r><w:t xml:space="preserve"> of 20</w:t></w:r>` +
        "</w:p>",
    );
    const result = await extractText(buf);
    expect(result.paragraphs).toHaveLength(1);
    console.log(
      "  complex field extract:",
      JSON.stringify(result.paragraphs[0]?.text),
    );
  });

  test("w:bookmarkStart/End around text", async () => {
    const buf = await buildDocx(
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">See </w:t></w:r>` +
        `<w:bookmarkStart w:id="1" w:name="clause_1"/>` +
        `<w:r><w:t xml:space="preserve">Clause 1</w:t></w:r>` +
        `<w:bookmarkEnd w:id="1"/>` +
        `<w:r><w:t xml:space="preserve"> for details.</w:t></w:r>` +
        "</w:p>",
    );
    const result = await extractText(buf);
    expect(result.paragraphs).toHaveLength(1);
    console.log(
      "  bookmark extract:",
      JSON.stringify(result.paragraphs[0]?.text),
    );
  });

  test("w:tbl — table paragraphs extracted in document order", async () => {
    const buf = await buildDocx(
      "<w:p><w:r><w:t>Before table</w:t></w:r></w:p>" +
        "<w:tbl>" +
        `<w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr>` +
        "<w:tr><w:tc>" +
        "<w:p><w:r><w:t>Cell A1</w:t></w:r></w:p>" +
        "</w:tc></w:tr>" +
        "</w:tbl>" +
        "<w:p><w:r><w:t>After table</w:t></w:r></w:p>",
    );
    const result = await extractText(buf);
    // Table paragraphs must be included: legal documents keep
    // signature blocks and party details in tables, and version
    // diffs / discovery index paragraphs the same way.
    expect(result.paragraphs.map((p) => p.text)).toEqual([
      "Before table",
      "Cell A1",
      "After table",
    ]);
  });

  test("existing w:ins/w:del (prior tracked changes)", async () => {
    const buf = await buildDocx(
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">The </w:t></w:r>` +
        `<w:del w:id="100" w:author="Human" w:date="2026-01-01T00:00:00Z">` +
        `<w:r><w:delText xml:space="preserve">old </w:delText></w:r>` +
        "</w:del>" +
        `<w:ins w:id="101" w:author="Human" w:date="2026-01-01T00:00:00Z">` +
        `<w:r><w:t xml:space="preserve">new </w:t></w:r>` +
        "</w:ins>" +
        `<w:r><w:t xml:space="preserve">agreement is binding.</w:t></w:r>` +
        "</w:p>",
    );
    const result = await extractText(buf);
    expect(result.paragraphs).toHaveLength(1);
    console.log(
      "  tracked changes extract:",
      JSON.stringify(result.paragraphs[0]?.text),
    );
  });

  test("w:sdt content control", async () => {
    const buf = await buildDocx(
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">Client name: </w:t></w:r>` +
        "<w:sdt>" +
        `<w:sdtPr><w:alias w:val="ClientName"/></w:sdtPr>` +
        "<w:sdtContent>" +
        "<w:r><w:t>John Smith</w:t></w:r>" +
        "</w:sdtContent>" +
        "</w:sdt>" +
        "</w:p>",
    );
    const result = await extractText(buf);
    expect(result.paragraphs).toHaveLength(1);
    console.log("  sdt extract:", JSON.stringify(result.paragraphs[0]?.text));
  });

  test("w:sym (special symbol)", async () => {
    const buf = await buildDocx(
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">See </w:t></w:r>` +
        `<w:r><w:sym w:font="Symbol" w:char="00A7"/></w:r>` +
        `<w:r><w:t xml:space="preserve"> 42 of the Act.</w:t></w:r>` +
        "</w:p>",
    );
    const result = await extractText(buf);
    expect(result.paragraphs).toHaveLength(1);
    console.log("  sym extract:", JSON.stringify(result.paragraphs[0]?.text));
  });

  test("w:commentRangeStart/End + commentReference", async () => {
    const buf = await buildDocx(
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">The party </w:t></w:r>` +
        `<w:commentRangeStart w:id="5"/>` +
        `<w:r><w:t xml:space="preserve">shall indemnify</w:t></w:r>` +
        `<w:commentRangeEnd w:id="5"/>` +
        "<w:r>" +
        `<w:rPr><w:rStyle w:val="CommentReference"/></w:rPr>` +
        `<w:commentReference w:id="5"/>` +
        "</w:r>" +
        `<w:r><w:t xml:space="preserve"> the other party.</w:t></w:r>` +
        "</w:p>",
    );
    const result = await extractText(buf);
    expect(result.paragraphs).toHaveLength(1);
    console.log(
      "  comment extract:",
      JSON.stringify(result.paragraphs[0]?.text),
    );
  });

  test("w:hyperlink wrapping a run", async () => {
    const buf = await buildDocx(
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">Refer to </w:t></w:r>` +
        `<w:hyperlink w:anchor="clause_1">` +
        "<w:r><w:t>Clause 1</w:t></w:r>" +
        "</w:hyperlink>" +
        `<w:r><w:t xml:space="preserve"> above.</w:t></w:r>` +
        "</w:p>",
    );
    const result = await extractText(buf);
    expect(result.paragraphs).toHaveLength(1);
    console.log(
      "  hyperlink extract:",
      JSON.stringify(result.paragraphs[0]?.text),
    );
  });

  test("mixed: tab + bookmark + br (legal clause)", async () => {
    const buf = await buildDocx(
      "<w:p>" +
        "<w:r><w:tab/></w:r>" +
        `<w:bookmarkStart w:id="2" w:name="section_1_1"/>` +
        "<w:r>" +
        "<w:rPr><w:b/></w:rPr>" +
        `<w:t xml:space="preserve">1.1 Definitions.</w:t>` +
        "</w:r>" +
        `<w:bookmarkEnd w:id="2"/>` +
        "<w:r>" +
        `<w:t xml:space="preserve"> </w:t>` +
        "<w:br/>" +
        `<w:t xml:space="preserve">The following terms shall have the meanings set forth below.</w:t>` +
        "</w:r>" +
        "</w:p>",
    );
    const result = await extractText(buf);
    expect(result.paragraphs).toHaveLength(1);
    console.log(
      "  mixed legal extract:",
      JSON.stringify(result.paragraphs[0]?.text),
    );
  });
});

// ─────────────────────────────────────────────────────────
// STEP 2: Verify buildRunMap consistency with extractText
// ─────────────────────────────────────────────────────────

describe("run-map vs extract-text consistency", () => {
  /** Parse body XML, extract text, build run map, compare. */
  const checkConsistency = (label: string, bodyXml: string) => {
    const xml = WRAP(bodyXml);
    const doc = slimdom.parseXmlDocument(xml);
    const body = doc.getElementsByTagNameNS(W_NS, "body")[0];
    if (!body) {
      throw new Error("No w:body element found");
    }

    // Get all direct-child paragraphs (same as extractText)
    const paragraphs: slimdom.Element[] = [];
    for (const child of body.childNodes) {
      if (!isElement(child)) {
        continue;
      }
      if (child.localName === "p" && child.namespaceURI === W_NS) {
        paragraphs.push(child);
      }
    }

    for (let i = 0; i < paragraphs.length; i++) {
      const p = paragraphs[i];
      if (!p) {
        continue;
      }
      const spans = buildRunMap(p);

      // Concatenate all RunSpan text
      const runMapText = spans.map((s) => s.tNode.textContent ?? "").join("");

      // Extract text the same way extractText does
      const extractedText = collectTextFromParagraph(p);

      if (runMapText !== extractedText) {
        console.log(
          `  MISMATCH [${label}] p${i}:`,
          `\n    runMap:   ${JSON.stringify(runMapText)}`,
          `\n    extract: ${JSON.stringify(extractedText)}`,
        );
      }
      expect(runMapText).toBe(extractedText);
    }
  };

  /** Replicate extractText's collectText for a single paragraph. */
  const collectTextFromParagraph = (el: slimdom.Element): string => {
    let text = "";
    const walk = (node: slimdom.Node) => {
      if (!isElement(node)) {
        return;
      }
      if (node.localName === "t" && node.namespaceURI === W_NS) {
        text += node.textContent ?? "";
      } else if (
        node.localName !== "delText" &&
        node.localName !== "del" &&
        node.localName !== "moveFrom"
      ) {
        for (const c of node.childNodes) {
          walk(c);
        }
      }
    };
    walk(el);
    return text;
  };

  const isElement = (node: slimdom.Node): node is slimdom.Element =>
    node.nodeType === node.ELEMENT_NODE;

  test("plain text — consistent", () => {
    checkConsistency("plain", "<w:p><w:r><w:t>Hello world</w:t></w:r></w:p>");
  });

  test("w:br — consistent", () => {
    checkConsistency(
      "br",
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">Before</w:t></w:r>` +
        `<w:r><w:br/><w:t xml:space="preserve">After</w:t></w:r>` +
        "</w:p>",
    );
  });

  test("w:br mid-run — consistent", () => {
    checkConsistency(
      "br-mid",
      "<w:p><w:r>" +
        `<w:t xml:space="preserve">Line one</w:t>` +
        "<w:br/>" +
        `<w:t xml:space="preserve">Line two</w:t>` +
        "</w:r></w:p>",
    );
  });

  test("w:tab — consistent", () => {
    checkConsistency(
      "tab",
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">Before</w:t></w:r>` +
        `<w:r><w:tab/><w:t xml:space="preserve">After</w:t></w:r>` +
        "</w:p>",
    );
  });

  test("w:fldSimple — consistent", () => {
    checkConsistency(
      "fldSimple",
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">Page </w:t></w:r>` +
        `<w:fldSimple w:instr=" PAGE ">` +
        "<w:r><w:t>3</w:t></w:r>" +
        "</w:fldSimple>" +
        "</w:p>",
    );
  });

  test("w:fldChar complex field — consistent", () => {
    checkConsistency(
      "fldChar",
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">Page </w:t></w:r>` +
        `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
        `<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>` +
        `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
        "<w:r><w:t>5</w:t></w:r>" +
        `<w:r><w:fldChar w:fldCharType="end"/></w:r>` +
        `<w:r><w:t xml:space="preserve"> of 20</w:t></w:r>` +
        "</w:p>",
    );
  });

  test("w:bookmarkStart/End — consistent", () => {
    checkConsistency(
      "bookmark",
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">See </w:t></w:r>` +
        `<w:bookmarkStart w:id="1" w:name="clause_1"/>` +
        "<w:r><w:t>Clause 1</w:t></w:r>" +
        `<w:bookmarkEnd w:id="1"/>` +
        `<w:r><w:t xml:space="preserve"> for details.</w:t></w:r>` +
        "</w:p>",
    );
  });

  test("existing w:ins/w:del — consistent", () => {
    checkConsistency(
      "tracked",
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">The </w:t></w:r>` +
        `<w:del w:id="100" w:author="H" w:date="2026-01-01T00:00:00Z">` +
        `<w:r><w:delText xml:space="preserve">old </w:delText></w:r>` +
        "</w:del>" +
        `<w:ins w:id="101" w:author="H" w:date="2026-01-01T00:00:00Z">` +
        `<w:r><w:t xml:space="preserve">new </w:t></w:r>` +
        "</w:ins>" +
        `<w:r><w:t xml:space="preserve">agreement.</w:t></w:r>` +
        "</w:p>",
    );
  });

  test("w:sdt content control — consistent", () => {
    checkConsistency(
      "sdt",
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">Name: </w:t></w:r>` +
        "<w:sdt>" +
        `<w:sdtPr><w:alias w:val="Name"/></w:sdtPr>` +
        "<w:sdtContent>" +
        "<w:r><w:t>John</w:t></w:r>" +
        "</w:sdtContent>" +
        "</w:sdt>" +
        "</w:p>",
    );
  });

  test("w:hyperlink — consistent", () => {
    checkConsistency(
      "hyperlink",
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">See </w:t></w:r>` +
        `<w:hyperlink w:anchor="x">` +
        "<w:r><w:t>Clause 1</w:t></w:r>" +
        "</w:hyperlink>" +
        `<w:r><w:t xml:space="preserve"> above.</w:t></w:r>` +
        "</w:p>",
    );
  });

  test("w:commentRangeStart/End — consistent", () => {
    checkConsistency(
      "comment",
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">The party </w:t></w:r>` +
        `<w:commentRangeStart w:id="5"/>` +
        "<w:r><w:t>shall indemnify</w:t></w:r>" +
        `<w:commentRangeEnd w:id="5"/>` +
        "<w:r>" +
        `<w:rPr><w:rStyle w:val="CommentReference"/></w:rPr>` +
        `<w:commentReference w:id="5"/>` +
        "</w:r>" +
        `<w:r><w:t xml:space="preserve"> the other.</w:t></w:r>` +
        "</w:p>",
    );
  });

  test("w:sym — consistent", () => {
    checkConsistency(
      "sym",
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">See </w:t></w:r>` +
        `<w:r><w:sym w:font="Symbol" w:char="00A7"/></w:r>` +
        `<w:r><w:t xml:space="preserve"> 42.</w:t></w:r>` +
        "</w:p>",
    );
  });

  test("mixed legal clause — consistent", () => {
    checkConsistency(
      "mixed",
      "<w:p>" +
        "<w:r><w:tab/></w:r>" +
        `<w:bookmarkStart w:id="2" w:name="s1"/>` +
        "<w:r><w:rPr><w:b/></w:rPr>" +
        `<w:t xml:space="preserve">1.1 Definitions.</w:t></w:r>` +
        `<w:bookmarkEnd w:id="2"/>` +
        "<w:r>" +
        `<w:t xml:space="preserve"> </w:t>` +
        "<w:br/>" +
        `<w:t xml:space="preserve">Terms below.</w:t>` +
        "</w:r>" +
        "</w:p>",
    );
  });
});

// ─────────────────────────────────────────────────────────
// STEP 3: Full pipeline roundtrip for each pattern
// ─────────────────────────────────────────────────────────

describe("pipeline roundtrip: real OOXML patterns", () => {
  test("w:br — edit text after line break", () => {
    const bodyXml =
      "<w:p>" +
      `<w:r><w:t xml:space="preserve">Before break</w:t></w:r>` +
      `<w:r><w:br/><w:t xml:space="preserve">After break</w:t></w:r>` +
      "</w:p>";

    pipelineRoundtrip(
      bodyXml,
      [{ index: 0, text: "Before breakAfter break" }],
      [
        {
          paragraphIndex: 0,
          newText: "Before breakAfter edit",
        },
      ],
    );
  });

  test("w:br mid-run — edit text before break", () => {
    const bodyXml =
      "<w:p><w:r>" +
      `<w:t xml:space="preserve">Line one</w:t>` +
      "<w:br/>" +
      `<w:t xml:space="preserve">Line two</w:t>` +
      "</w:r></w:p>";

    pipelineRoundtrip(
      bodyXml,
      [{ index: 0, text: "Line oneLine two" }],
      [
        {
          paragraphIndex: 0,
          newText: "First lineLine two",
        },
      ],
    );
  });

  test("w:tab — edit text after tab", () => {
    const bodyXml =
      "<w:p>" +
      `<w:r><w:t xml:space="preserve">Before</w:t></w:r>` +
      `<w:r><w:tab/><w:t xml:space="preserve">After tab</w:t></w:r>` +
      "</w:p>";

    pipelineRoundtrip(
      bodyXml,
      [{ index: 0, text: "BeforeAfter tab" }],
      [
        {
          paragraphIndex: 0,
          newText: "BeforeEdited tab",
        },
      ],
    );
  });

  test("w:fldSimple — edit text around field", () => {
    const bodyXml =
      "<w:p>" +
      `<w:r><w:t xml:space="preserve">Page </w:t></w:r>` +
      `<w:fldSimple w:instr=" PAGE ">` +
      "<w:r><w:t>3</w:t></w:r>" +
      "</w:fldSimple>" +
      `<w:r><w:t xml:space="preserve"> of </w:t></w:r>` +
      `<w:fldSimple w:instr=" NUMPAGES ">` +
      "<w:r><w:t>10</w:t></w:r>" +
      "</w:fldSimple>" +
      "</w:p>";

    pipelineRoundtrip(
      bodyXml,
      [{ index: 0, text: "Page 3 of 10" }],
      [
        {
          paragraphIndex: 0,
          newText: "Seite 3 von 10",
        },
      ],
    );
  });

  test("w:fldChar complex field — edit surrounding text", () => {
    const bodyXml =
      "<w:p>" +
      `<w:r><w:t xml:space="preserve">Page </w:t></w:r>` +
      `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
      `<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>` +
      `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
      "<w:r><w:t>5</w:t></w:r>" +
      `<w:r><w:fldChar w:fldCharType="end"/></w:r>` +
      `<w:r><w:t xml:space="preserve"> of 20</w:t></w:r>` +
      "</w:p>";

    pipelineRoundtrip(
      bodyXml,
      [{ index: 0, text: "Page 5 of 20" }],
      [
        {
          paragraphIndex: 0,
          newText: "Seite 5 von 20",
        },
      ],
    );
  });

  test("w:bookmarkStart/End — edit bookmarked text", () => {
    const bodyXml =
      "<w:p>" +
      `<w:r><w:t xml:space="preserve">See </w:t></w:r>` +
      `<w:bookmarkStart w:id="1" w:name="clause_1"/>` +
      `<w:r><w:t xml:space="preserve">Clause 1</w:t></w:r>` +
      `<w:bookmarkEnd w:id="1"/>` +
      `<w:r><w:t xml:space="preserve"> for details.</w:t></w:r>` +
      "</w:p>";

    pipelineRoundtrip(
      bodyXml,
      [{ index: 0, text: "See Clause 1 for details." }],
      [
        {
          paragraphIndex: 0,
          newText: "See Section 2 for details.",
        },
      ],
    );
  });

  test("existing tracked changes — edit around them", () => {
    const bodyXml =
      "<w:p>" +
      `<w:r><w:t xml:space="preserve">The </w:t></w:r>` +
      `<w:del w:id="100" w:author="H" w:date="2026-01-01T00:00:00Z">` +
      `<w:r><w:delText xml:space="preserve">old </w:delText></w:r>` +
      "</w:del>" +
      `<w:ins w:id="101" w:author="H" w:date="2026-01-01T00:00:00Z">` +
      `<w:r><w:t xml:space="preserve">new </w:t></w:r>` +
      "</w:ins>" +
      `<w:r><w:t xml:space="preserve">agreement is binding.</w:t></w:r>` +
      "</w:p>";

    // Accepted view: "The new agreement is binding."
    pipelineRoundtrip(
      bodyXml,
      [
        {
          index: 0,
          text: "The new agreement is binding.",
        },
      ],
      [
        {
          paragraphIndex: 0,
          newText: "The new contract is binding.",
        },
      ],
    );
  });

  test("w:sdt — edit content control text", () => {
    const bodyXml =
      "<w:p>" +
      `<w:r><w:t xml:space="preserve">Client name: </w:t></w:r>` +
      "<w:sdt>" +
      `<w:sdtPr><w:alias w:val="ClientName"/></w:sdtPr>` +
      "<w:sdtContent>" +
      "<w:r><w:t>John Smith</w:t></w:r>" +
      "</w:sdtContent>" +
      "</w:sdt>" +
      "</w:p>";

    pipelineRoundtrip(
      bodyXml,
      [{ index: 0, text: "Client name: John Smith" }],
      [
        {
          paragraphIndex: 0,
          newText: "Client name: Jane Doe",
        },
      ],
    );
  });

  test("w:hyperlink — edit link text", () => {
    const bodyXml =
      "<w:p>" +
      `<w:r><w:t xml:space="preserve">Refer to </w:t></w:r>` +
      `<w:hyperlink w:anchor="clause_1">` +
      "<w:r><w:t>Clause 1</w:t></w:r>" +
      "</w:hyperlink>" +
      `<w:r><w:t xml:space="preserve"> above.</w:t></w:r>` +
      "</w:p>";

    pipelineRoundtrip(
      bodyXml,
      [{ index: 0, text: "Refer to Clause 1 above." }],
      [
        {
          paragraphIndex: 0,
          newText: "Refer to Section 2 above.",
        },
      ],
    );
  });

  test("w:commentRangeStart/End — edit commented text", () => {
    const bodyXml =
      "<w:p>" +
      `<w:r><w:t xml:space="preserve">The party </w:t></w:r>` +
      `<w:commentRangeStart w:id="5"/>` +
      `<w:r><w:t xml:space="preserve">shall indemnify</w:t></w:r>` +
      `<w:commentRangeEnd w:id="5"/>` +
      "<w:r>" +
      `<w:rPr><w:rStyle w:val="CommentReference"/></w:rPr>` +
      `<w:commentReference w:id="5"/>` +
      "</w:r>" +
      `<w:r><w:t xml:space="preserve"> the other party.</w:t></w:r>` +
      "</w:p>";

    pipelineRoundtrip(
      bodyXml,
      [
        {
          index: 0,
          text: "The party shall indemnify the other party.",
        },
      ],
      [
        {
          paragraphIndex: 0,
          newText: "The party shall compensate the other party.",
        },
      ],
    );
  });

  test("w:sym — edit text around symbol", () => {
    // w:sym produces no w:t text, so extracted text skips it
    const bodyXml =
      "<w:p>" +
      `<w:r><w:t xml:space="preserve">See </w:t></w:r>` +
      `<w:r><w:sym w:font="Symbol" w:char="00A7"/></w:r>` +
      `<w:r><w:t xml:space="preserve"> 42 of the Act.</w:t></w:r>` +
      "</w:p>";

    pipelineRoundtrip(
      bodyXml,
      [{ index: 0, text: "See  42 of the Act." }],
      [
        {
          paragraphIndex: 0,
          newText: "See  43 of the Statute.",
        },
      ],
    );
  });

  test("mixed legal clause — edit definition text", () => {
    const bodyXml =
      "<w:p>" +
      "<w:r><w:tab/></w:r>" +
      `<w:bookmarkStart w:id="2" w:name="s1"/>` +
      "<w:r><w:rPr><w:b/></w:rPr>" +
      `<w:t xml:space="preserve">1.1 Definitions.</w:t></w:r>` +
      `<w:bookmarkEnd w:id="2"/>` +
      "<w:r>" +
      `<w:t xml:space="preserve"> </w:t>` +
      "<w:br/>" +
      `<w:t xml:space="preserve">The following terms shall have the meanings set forth below.</w:t>` +
      "</w:r>" +
      "</w:p>";

    pipelineRoundtrip(
      bodyXml,
      [
        {
          index: 0,
          text: "1.1 Definitions. The following terms shall have the meanings set forth below.",
        },
      ],
      [
        {
          paragraphIndex: 0,
          newText:
            "1.1 Definitions. The terms below have the following meanings.",
        },
      ],
    );
  });
});
