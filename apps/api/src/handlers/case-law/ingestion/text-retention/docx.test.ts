import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { readBinaryText } from "./binary";
import { TEXT_ORACLE_LIMITS } from "./types";

const wordXml = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:x="urn:unknown"><w:body>${body}</w:body></w:document>`;
const archiveOf = async (parts: Record<string, string>) => {
  const zip = new JSZip();
  for (const [path, xml] of Object.entries(parts)) {
    zip.file(path, xml);
  }
  return await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
  });
};
const baselineOf = async (body: string) => {
  const raw = await archiveOf({ "word/document.xml": wordXml(body) });
  const result = await readBinaryText({ raw, format: "docx" });
  expect(result.isOk()).toBe(true);
  if (result.isErr()) {
    throw result.error;
  }
  return result.value.text.trim();
};

describe("independent DOCX visible text baseline", () => {
  test("run segmentation and unfamiliar containers preserve every character", async () => {
    const text = "Napadnuté rozhodnutie obsahuje opakované opakované slová.";
    for (let split = 0; split <= text.length; split += 1) {
      const before = text.slice(0, split);
      const after = text.slice(split);
      const body = `<w:p><x:opaque><w:r><w:t>${before}</w:t></w:r></x:opaque><w:r><w:t>${after}</w:t></w:r></w:p>`;
      expect(await baselineOf(body)).toBe(text);
    }
  });

  test("field results, nested tables, drawing text and text boxes remain visible", async () => {
    const body = `<w:p><w:fldSimple w:instr="metadata"><w:r><w:t>FIELDRESULT</w:t></w:r></w:fldSimple><w:r><w:instrText>INSTRUCTION</w:instrText></w:r><w:r><w:t>RESULT</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>TABLE</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>NESTED</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl><w:p><w:r><w:drawing><a:p><a:r><a:t>DRAWING</a:t></a:r></a:p></w:drawing><w:txbxContent><w:p><w:r><w:t>TEXTBOX</w:t></w:r></w:p></w:txbxContent></w:r></w:p>`;
    const text = await baselineOf(body);
    for (const expected of [
      "FIELDRESULT",
      "RESULT",
      "TABLE",
      "NESTED",
      "DRAWING",
      "TEXTBOX",
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain("INSTRUCTION");
  });

  test("insertions count while deleted and moved-from runs do not", async () => {
    const body = `<w:p><w:del><w:r><w:delText>DELETED</w:delText><w:t>ALSO_DELETED</w:t></w:r></w:del><w:moveFrom><w:r><w:t>MOVED_FROM</w:t></w:r></w:moveFrom><w:ins><w:r><w:t>INSERTED</w:t></w:r></w:ins><w:moveTo><w:r><w:t>MOVED_TO</w:t></w:r></w:moveTo></w:p>`;
    expect(await baselineOf(body)).toBe("INSERTEDMOVED_TO");
  });

  test("notes, headers and footers are counted once per package part", async () => {
    const raw = await archiveOf({
      "word/document.xml": wordXml("<w:p><w:r><w:t>BODY</w:t></w:r></w:p>"),
      "word/footnotes.xml": wordXml(
        '<w:footnote w:id="1"><w:p><w:r><w:t>FOOTNOTE</w:t></w:r></w:p></w:footnote>',
      ),
      "word/endnotes.xml": wordXml(
        '<w:endnote w:id="2"><w:p><w:r><w:t>ENDNOTE</w:t></w:r></w:p></w:endnote>',
      ),
      "word/header1.xml": wordXml("<w:p><w:r><w:t>HEADER</w:t></w:r></w:p>"),
      "word/footer1.xml": wordXml("<w:p><w:r><w:t>FOOTER</w:t></w:r></w:p>"),
    });
    const result = await readBinaryText({ raw, format: "docx" });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      throw result.error;
    }
    for (const token of ["BODY", "FOOTNOTE", "ENDNOTE", "HEADER", "FOOTER"]) {
      expect(result.value.text.split(token)).toHaveLength(2);
    }
  });

  test("ambiguous visibility and nonconventional relationship targets fail closed", async () => {
    for (const body of [
      "<w:sym/>",
      "<w:footnoteReference/>",
      "<w:vanish/>",
      "<w:specVanish/>",
    ]) {
      const raw = await archiveOf({ "word/document.xml": wordXml(body) });
      const result = await readBinaryText({ raw, format: "docx" });
      expect(result.isErr() && result.error.reason).toBe("unsupported");
    }
    const raw = await archiveOf({
      "word/document.xml": wordXml("<w:p><w:r><w:t>BODY</w:t></w:r></w:p>"),
      "word/_rels/document.xml.rels":
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="custom/note.xml"/></Relationships>',
      "word/custom/note.xml": wordXml(
        "<w:p><w:r><w:t>NONCONVENTIONAL_NOTE</w:t></w:r></w:p>",
      ),
    });
    const result = await readBinaryText({ raw, format: "docx" });
    expect(result.isErr() && result.error.reason).toBe("unsupported");
    const malformedLeaf = await archiveOf({
      "word/document.xml": wordXml(
        "<w:p><w:r><w:t>OUTER<w:t>INNER</w:t></w:t></w:r></w:p>",
      ),
    });
    const leafResult = await readBinaryText({
      raw: malformedLeaf,
      format: "docx",
    });
    expect(leafResult.isErr() && leafResult.error.reason).toBe("malformed");
  });

  test("external text, malformed archives and zip bombs never certify clean text", async () => {
    const external = await archiveOf({
      "word/document.xml": wordXml(
        '<w:altChunk r:id="external" xmlns:r="urn:relationships"/>',
      ),
    });
    const externalResult = await readBinaryText({
      raw: external,
      format: "docx",
    });
    expect(externalResult.isErr() && externalResult.error.reason).toBe(
      "unsupported",
    );
    const malformed = await readBinaryText({
      raw: new Uint8Array([1, 2, 3]),
      format: "docx",
    });
    expect(malformed.isErr() && malformed.error.reason).toBe("malformed");
    const bomb = await archiveOf({
      "word/document.xml": "x".repeat(TEXT_ORACLE_LIMITS.rawBytes + 1),
    });
    expect(bomb.byteLength).toBeLessThan(TEXT_ORACLE_LIMITS.rawBytes);
    const limited = await readBinaryText({ raw: bomb, format: "docx" });
    expect(limited.isErr() && limited.error.reason).toBe("resource_limit");
  });
});
