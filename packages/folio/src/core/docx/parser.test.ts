import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { parseDocx } from "./parser";
import { RELATIONSHIP_TYPES } from "./relsParser";

const XML_DECLARATION = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;

/**
 * A doc whose theme leaves `<a:ea>` empty (the Office default) and lists the
 * real CJK typeface in `<a:font script="Jpan">`, plus `w:themeFontLang` selects
 * Japanese and a run references `minorEastAsia`. Phase 2 must resolve the run's
 * EastAsian font to the Japanese face rather than an empty string.
 */
async function createEmptyEaThemeFixture(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `${XML_DECLARATION}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `${XML_DECLARATION}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${RELATIONSHIP_TYPES.officeDocument}" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `${XML_DECLARATION}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
  );
  zip.file(
    "word/settings.xml",
    `${XML_DECLARATION}
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:themeFontLang w:val="en-US" w:eastAsia="ja-JP"/>
</w:settings>`,
  );
  zip.file(
    "word/theme/theme1.xml",
    `${XML_DECLARATION}
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme">
  <a:themeElements>
    <a:clrScheme name="Office"/>
    <a:fontScheme name="Office">
      <a:majorFont>
        <a:latin typeface="Calibri Light"/>
        <a:ea typeface=""/>
        <a:cs typeface=""/>
        <a:font script="Jpan" typeface="ＭＳ ゴシック"/>
      </a:majorFont>
      <a:minorFont>
        <a:latin typeface="Calibri"/>
        <a:ea typeface=""/>
        <a:cs typeface=""/>
        <a:font script="Jpan" typeface="ＭＳ 明朝"/>
      </a:minorFont>
    </a:fontScheme>
  </a:themeElements>
</a:theme>`,
  );
  zip.file(
    "word/document.xml",
    `${XML_DECLARATION}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p>
      <w:r>
        <w:rPr><w:rFonts w:eastAsiaTheme="minorEastAsia"/></w:rPr>
        <w:t>日本語</w:t>
      </w:r>
    </w:p>
  </w:body>
</w:document>`,
  );
  return zip.generateAsync({ type: "arraybuffer" });
}

describe("parseDocx — w:themeFontLang resolves empty EastAsian theme slots", () => {
  test("a minorEastAsia run resolves to the Japanese theme face", async () => {
    const buffer = await createEmptyEaThemeFixture();
    const doc = await parseDocx(buffer);

    const paragraph = doc.package.document.content.at(0);
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") {
      throw new Error("expected a paragraph");
    }

    const run = paragraph.content.at(0);
    expect(run?.type).toBe("run");
    if (run?.type !== "run") {
      throw new Error("expected a run");
    }

    // Without Phase 2 this is the empty string (or falls back to ascii/hAnsi);
    // with themeFontLang it is the script-specific Japanese face.
    expect(run.formatting?.fontFamily?.eastAsia).toBe("ＭＳ 明朝");
    expect(run.formatting?.fontFamily?.eastAsiaTheme).toBe("minorEastAsia");
  });
});
