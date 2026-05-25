import { describe, expect, test } from "bun:test";

import { parseParagraph } from "./paragraphParser";
import type { XmlElement } from "./xmlParser";
import { parseXmlDocument } from "./xmlParser";

function parseParagraphXml(xml: string) {
  const root = parseXmlDocument(xml) as XmlElement | null;
  if (!root) {
    throw new Error("Failed to parse paragraph XML fixture");
  }
  return parseParagraph(root, null, null, null, null, null);
}

describe("parseParagraph tracked-change hardening", () => {
  test("parses deletion text from w:delText runs", () => {
    const paragraph = parseParagraphXml(`
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:del w:id="7" w:author="Reviewer" w:date="2026-02-22T10:00:00Z">
          <w:r>
            <w:delText xml:space="preserve"> removed </w:delText>
          </w:r>
        </w:del>
      </w:p>
    `);

    const deletion = paragraph.content[0];
    expect(deletion?.type).toBe("deletion");
    if (!deletion || deletion.type !== "deletion") {
      return;
    }

    expect(deletion.info.id).toBe(7);
    expect(deletion.info.author).toBe("Reviewer");
    expect(deletion.info.date).toBe("2026-02-22T10:00:00Z");
    expect(deletion.content).toHaveLength(1);
    const run = deletion.content[0];
    expect(run.type).toBe("run");
    if (run.type !== "run") {
      return;
    }

    expect(run.content).toHaveLength(1);
    expect(run.content[0].type).toBe("text");
    if (run.content[0].type !== "text") {
      return;
    }
    expect(run.content[0].text).toBe(" removed ");
    expect(run.content[0].preserveSpace).toBe(true);
  });

  test("parses deletion instruction text from w:delInstrText", () => {
    const paragraph = parseParagraphXml(`
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:del w:id="8" w:author="Reviewer">
          <w:r>
            <w:delInstrText> MERGEFIELD name </w:delInstrText>
          </w:r>
        </w:del>
      </w:p>
    `);

    const deletion = paragraph.content[0];
    expect(deletion?.type).toBe("deletion");
    if (!deletion || deletion.type !== "deletion") {
      return;
    }

    const run = deletion.content[0];
    expect(run.type).toBe("run");
    if (run.type !== "run") {
      return;
    }

    expect(run.content).toHaveLength(1);
    expect(run.content[0].type).toBe("instrText");
    if (run.content[0].type !== "instrText") {
      return;
    }
    expect(run.content[0].text).toBe(" MERGEFIELD name ");
  });

  test("normalizes tracked-change metadata when attributes are invalid or blank", () => {
    const paragraph = parseParagraphXml(`
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:ins w:id="invalid" w:author="   " w:date="   ">
          <w:r><w:t>Added</w:t></w:r>
        </w:ins>
      </w:p>
    `);

    const insertion = paragraph.content[0];
    expect(insertion?.type).toBe("insertion");
    if (!insertion || insertion.type !== "insertion") {
      return;
    }

    expect(insertion.info.id).toBe(0);
    expect(insertion.info.author).toBe("Unknown");
    expect(insertion.info.date).toBeUndefined();
  });

  test("preserves point comment references from runs", () => {
    const paragraph = parseParagraphXml(`
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:r><w:t>Commented text</w:t></w:r>
        <w:r>
          <w:rPr><w:rStyle w:val="CommentReference"/></w:rPr>
          <w:commentReference w:id="42"/>
        </w:r>
      </w:p>
    `);

    expect(paragraph.content.at(0)?.type).toBe("run");
    expect(paragraph.content.at(1)).toEqual({
      type: "commentReference",
      id: 42,
    });
  });

  test("lifts bookmark markers out of tracked-change wrappers", () => {
    const paragraph = parseParagraphXml(`
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:bookmarkStart w:id="5" w:name="deletedRange"/>
        <w:del w:id="7" w:author="Reviewer">
          <w:r><w:delText>removed</w:delText></w:r>
          <w:bookmarkEnd w:id="5"/>
        </w:del>
      </w:p>
    `);

    expect(paragraph.content.map((content) => content.type)).toEqual([
      "bookmarkStart",
      "deletion",
      "bookmarkEnd",
    ]);
    expect(paragraph.content.at(2)).toMatchObject({
      type: "bookmarkEnd",
      id: 5,
    });
  });
});

describe("parseParagraph rendered page break markers", () => {
  test("marks a paragraph when Word rendered-page-break appears before visible text", () => {
    const paragraph = parseParagraphXml(`
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:proofErr w:type="spellStart"/>
        <w:r>
          <w:lastRenderedPageBreak/>
          <w:t>Moved to next page</w:t>
        </w:r>
      </w:p>
    `);

    expect(paragraph.renderedPageBreakBefore).toBe(true);
  });

  test("marks a paragraph when a page break appears before visible text", () => {
    const paragraph = parseParagraphXml(`
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:r>
          <w:br w:type="page"/>
          <w:t>After hard break</w:t>
        </w:r>
      </w:p>
    `);

    expect(paragraph.renderedPageBreakBefore).toBe(true);
  });

  test("does not mark a paragraph when rendered page break follows visible text", () => {
    const paragraph = parseParagraphXml(`
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:r>
          <w:t>Previous page text</w:t>
          <w:lastRenderedPageBreak/>
        </w:r>
      </w:p>
    `);

    expect(paragraph.renderedPageBreakBefore).toBeUndefined();
  });

  test("lastRenderedPageBreak inside a hyperlink wrapper is honored", () => {
    const paragraph = parseParagraphXml(`
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:hyperlink>
          <w:r><w:lastRenderedPageBreak/><w:t>Hyper</w:t></w:r>
        </w:hyperlink>
      </w:p>
    `);

    expect(paragraph.renderedPageBreakBefore).toBe(true);
  });
});

describe("parseParagraph spacing explicit flags", () => {
  test("inline w:before is flagged", () => {
    const paragraph = parseParagraphXml(`
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:pPr><w:spacing w:before="200"/></w:pPr>
      </w:p>
    `);

    expect(paragraph.formatting?.spacingExplicit).toEqual({ before: true });
  });

  test("inline w:after only is flagged", () => {
    const paragraph = parseParagraphXml(`
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:pPr><w:spacing w:after="100"/></w:pPr>
      </w:p>
    `);

    expect(paragraph.formatting?.spacingExplicit).toEqual({ after: true });
  });

  test("paragraph without inline w:spacing has no explicit flags", () => {
    const paragraph = parseParagraphXml(`
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:pPr><w:pStyle w:val="Normal"/></w:pPr>
      </w:p>
    `);

    expect(paragraph.formatting?.spacingExplicit).toBeUndefined();
  });
});
