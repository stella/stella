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

  test("preserves tracked-change metadata for marker-only wrappers", () => {
    const paragraph = parseParagraphXml(`
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:ins w:id="12" w:author="Reviewer">
          <w:bookmarkStart w:id="5" w:name="insertedMarker"/>
        </w:ins>
      </w:p>
    `);

    expect(paragraph.content.map((content) => content.type)).toEqual([
      "insertion",
      "bookmarkStart",
    ]);
    const insertion = paragraph.content.at(0);
    expect(insertion?.type).toBe("insertion");
    if (!insertion || insertion.type !== "insertion") {
      return;
    }
    expect(insertion.info).toMatchObject({ id: 12, author: "Reviewer" });
    expect(insertion.content).toHaveLength(0);
  });

  test("preserves inline SDT metadata for marker-only controls", () => {
    const paragraph = parseParagraphXml(`
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:sdt>
          <w:sdtPr>
            <w:alias w:val="Clause marker"/>
            <w:tag w:val="clause-marker"/>
          </w:sdtPr>
          <w:sdtContent>
            <w:bookmarkStart w:id="9" w:name="controlledMarker"/>
          </w:sdtContent>
        </w:sdt>
      </w:p>
    `);

    expect(paragraph.content.map((content) => content.type)).toEqual([
      "inlineSdt",
      "bookmarkStart",
    ]);
    const sdt = paragraph.content.at(0);
    expect(sdt?.type).toBe("inlineSdt");
    if (!sdt || sdt.type !== "inlineSdt") {
      return;
    }
    expect(sdt.properties).toMatchObject({
      alias: "Clause marker",
      tag: "clause-marker",
    });
    expect(sdt.content).toHaveLength(0);
  });

  test("reads inline date-SDT format from <w:dateFormat>, not <w:date w:fullDate>", () => {
    // Regression: parseSdtProperties used to read w:date@w:fullDate as the
    // format, but w:fullDate is the bound *value*; the display format lives
    // in the child <w:dateFormat w:val="..."/>. Picked up from upstream
    // eigenpal/docx-editor#661.
    const paragraph = parseParagraphXml(`
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:sdt>
          <w:sdtPr>
            <w:tag w:val="effective-date"/>
            <w:date w:fullDate="2026-06-02T00:00:00Z">
              <w:dateFormat w:val="d MMMM yyyy"/>
              <w:lid w:val="en-GB"/>
            </w:date>
          </w:sdtPr>
          <w:sdtContent><w:r><w:t>2 June 2026</w:t></w:r></w:sdtContent>
        </w:sdt>
      </w:p>
    `);

    const sdt = paragraph.content.at(0);
    if (!sdt || sdt.type !== "inlineSdt") {
      throw new Error("expected inline SDT");
    }
    expect(sdt.properties).toMatchObject({
      sdtType: "date",
      tag: "effective-date",
      dateFormat: "d MMMM yyyy",
    });
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

// Mirror of upstream eigenpal/docx-editor PR #482 parser tests
// (see commit 29f95751d). OOXML allows simple/complex fields, nested
// SDTs, and math equations directly inside `<w:sdtContent>`. The folio
// fork previously split these out as siblings of the SDT wrapper, so
// docProps-bound title fields (and similar template content) lost their
// wrapper on parse.
describe("parseParagraph SDT content preservation", () => {
  test("keeps a simple field that lives inside an inline SDT", () => {
    const paragraph = parseParagraphXml(`
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:sdt>
          <w:sdtPr><w:alias w:val="title-control"/></w:sdtPr>
          <w:sdtContent>
            <w:fldSimple w:instr="TITLE">
              <w:r><w:t>Cached title</w:t></w:r>
            </w:fldSimple>
          </w:sdtContent>
        </w:sdt>
      </w:p>
    `);

    expect(paragraph.content).toHaveLength(1);
    const sdt = paragraph.content[0];
    expect(sdt.type).toBe("inlineSdt");
    if (sdt.type !== "inlineSdt") {
      return;
    }
    expect(sdt.content).toHaveLength(1);
    expect(sdt.content[0].type).toBe("simpleField");
  });

  test("keeps a complex field that lives inside an inline SDT", () => {
    const paragraph = parseParagraphXml(`
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:sdt>
          <w:sdtPr><w:alias w:val="page-ref"/></w:sdtPr>
          <w:sdtContent>
            <w:r><w:fldChar w:fldCharType="begin"/></w:r>
            <w:r><w:instrText> PAGE </w:instrText></w:r>
            <w:r><w:fldChar w:fldCharType="separate"/></w:r>
            <w:r><w:t>3</w:t></w:r>
            <w:r><w:fldChar w:fldCharType="end"/></w:r>
          </w:sdtContent>
        </w:sdt>
      </w:p>
    `);

    expect(paragraph.content).toHaveLength(1);
    const sdt = paragraph.content[0];
    expect(sdt.type).toBe("inlineSdt");
    if (sdt.type !== "inlineSdt") {
      return;
    }
    expect(sdt.content).toHaveLength(1);
    expect(sdt.content[0].type).toBe("complexField");
  });

  test("keeps a nested inline SDT inside an inline SDT", () => {
    const paragraph = parseParagraphXml(`
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:sdt>
          <w:sdtPr><w:alias w:val="outer"/></w:sdtPr>
          <w:sdtContent>
            <w:sdt>
              <w:sdtPr><w:alias w:val="inner"/></w:sdtPr>
              <w:sdtContent>
                <w:r><w:t>Nested text</w:t></w:r>
              </w:sdtContent>
            </w:sdt>
          </w:sdtContent>
        </w:sdt>
      </w:p>
    `);

    const outer = paragraph.content[0];
    expect(outer.type).toBe("inlineSdt");
    if (outer.type !== "inlineSdt") {
      return;
    }
    expect(outer.content).toHaveLength(1);
    expect(outer.content[0].type).toBe("inlineSdt");
  });
});
