import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { readDocumentReference } from "@/lib/document-reference";

const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const CUSTOM_PROPS_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties";
const VT_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes";
const FMTID = "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}";

/**
 * Mirrors `buildCustomPropertiesXml` in the API's DOCX stamper: this is the
 * exact bytes the round trip has to read back, so the fixture must be shaped
 * by the producer's format, not by what the parser happens to accept.
 */
const buildCustomPropertiesXml = (stamp: string, code: string): string =>
  [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<Properties xmlns="${CUSTOM_PROPS_NS}"`,
    `            xmlns:vt="${VT_NS}">`,
    `  <property fmtid="${FMTID}" pid="2"`,
    '            name="stella-ref">',
    `    <vt:lpwstr>${stamp}</vt:lpwstr>`,
    "  </property>",
    `  <property fmtid="${FMTID}" pid="3"`,
    '            name="stella-code">',
    `    <vt:lpwstr>${code}</vt:lpwstr>`,
    "  </property>",
    "</Properties>",
  ].join("\n");

/**
 * Mirrors `buildStampParagraph` in the API's DOCX stamper, including the split
 * the hyperlink forces: the reference and the code live in separate `<w:t>`
 * runs, so a parser that reads only one run finds half the line.
 */
const buildFooterXml = (stamp: string, code: string): string =>
  [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    "<w:ftr>",
    "  <w:p>",
    '    <w:pPr><w:jc w:val="right"/></w:pPr>',
    '    <w:bookmarkStart w:id="900" w:name="stella_dms_ref"/>',
    "    <w:r>",
    '      <w:rPr><w:color w:val="999999"/></w:rPr>',
    `      <w:t xml:space="preserve">${stamp}  </w:t>`,
    "    </w:r>",
    '    <w:hyperlink r:id="rIdStellaVerify">',
    "      <w:r>",
    '        <w:rPr><w:color w:val="999999"/></w:rPr>',
    `        <w:t>stl:${code}</w:t>`,
    "      </w:r>",
    "    </w:hyperlink>",
    '    <w:bookmarkEnd w:id="900"/>',
    "  </w:p>",
    "</w:ftr>",
  ].join("\n");

type DocxFixtureOptions = {
  customPropertiesXml?: string;
  fileName?: string;
  footerXml?: string;
  mimeType?: string;
};

const buildDocx = async ({
  customPropertiesXml,
  fileName = "engagement-letter.docx",
  footerXml,
  mimeType = DOCX_MIME_TYPE,
}: DocxFixtureOptions = {}): Promise<File> => {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types/>',
  );
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8"?><w:document><w:body/></w:document>',
  );
  if (customPropertiesXml !== undefined) {
    zip.file("docProps/custom.xml", customPropertiesXml);
  }
  if (footerXml !== undefined) {
    zip.file("word/footer1.xml", footerXml);
  }
  const bytes = await zip.generateAsync({ type: "uint8array" });
  return new File([bytes], fileName, { type: mimeType });
};

describe("reading a stella reference out of an uploaded file", () => {
  test("resolves the code and reference a stamped DOCX carries", async () => {
    const file = await buildDocx({
      customPropertiesXml: buildCustomPropertiesXml(
        "2026/001/015.v3",
        "kx8mq2n4p3",
      ),
    });

    expect(await readDocumentReference(file)).toEqual({
      verificationCode: "kx8mq2n4p3",
      stamp: "2026/001/015.v3",
    });
  });

  test("resolves when the browser reports no MIME type for a .docx", async () => {
    const file = await buildDocx({
      customPropertiesXml: buildCustomPropertiesXml(
        "2026/001/015.v3",
        "kx8mq2n4p3",
      ),
      mimeType: "",
    });

    expect(await readDocumentReference(file)).not.toBeNull();
  });

  test("answers null for a DOCX that never left stella", async () => {
    expect(await readDocumentReference(await buildDocx())).toBeNull();
  });

  // Another editor's "Save as" can drop `docProps/custom.xml` while leaving
  // the body — and therefore the footer — intact, so the footer is the
  // fallback the API reads too.
  test("falls back to the footer when the custom properties are gone", async () => {
    const file = await buildDocx({
      footerXml: buildFooterXml("2026/001/015.v3", "kx8mq2n4p3"),
    });

    expect(await readDocumentReference(file)).toEqual({
      verificationCode: "kx8mq2n4p3",
      stamp: "2026/001/015.v3",
    });
  });

  test("reads the footer of a stamp that carries no reference", async () => {
    const file = await buildDocx({
      footerXml: buildFooterXml("", "kx8mq2n4p3"),
    });

    expect(await readDocumentReference(file)).toEqual({
      verificationCode: "kx8mq2n4p3",
      stamp: null,
    });
  });

  test("holds the footer to the same code shape as the properties", async () => {
    const file = await buildDocx({
      footerXml: buildFooterXml("2026/001/015.v3", "KX8MQ2N4P3"),
    });

    expect(await readDocumentReference(file)).toBeNull();
  });

  test("ignores a footer without stella's bookmark", async () => {
    const file = await buildDocx({
      footerXml: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<w:ftr><w:p><w:r><w:t>Page 1</w:t></w:r></w:p></w:ftr>",
      ].join("\n"),
    });

    expect(await readDocumentReference(file)).toBeNull();
  });

  // The properties are the reliable copy: a footer edited by hand must not
  // outrank what the stamper wrote.
  test("prefers the custom properties over the footer", async () => {
    const file = await buildDocx({
      customPropertiesXml: buildCustomPropertiesXml(
        "2026/001/015.v3",
        "kx8mq2n4p3",
      ),
      footerXml: buildFooterXml("2019/900/001.v1", "qqqqqqqqqq"),
    });

    expect(await readDocumentReference(file)).toEqual({
      verificationCode: "kx8mq2n4p3",
      stamp: "2026/001/015.v3",
    });
  });

  test("answers null for custom properties without stella's own", async () => {
    const file = await buildDocx({
      customPropertiesXml: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<Properties xmlns="${CUSTOM_PROPS_NS}" xmlns:vt="${VT_NS}">`,
        `  <property fmtid="${FMTID}" pid="2" name="Matter">`,
        "    <vt:lpwstr>Novak v. Horak</vt:lpwstr>",
        "  </property>",
        "</Properties>",
      ].join("\n"),
    });

    expect(await readDocumentReference(file)).toBeNull();
  });

  test("answers null instead of throwing on bytes that are not an archive", async () => {
    const file = new File(
      [new Uint8Array([0x00, 0x01, 0x02, 0x03])],
      "x.docx",
      {
        type: DOCX_MIME_TYPE,
      },
    );

    expect(await readDocumentReference(file)).toBeNull();
  });

  test("answers null instead of throwing on a truncated archive", async () => {
    const intact = await buildDocx({
      customPropertiesXml: buildCustomPropertiesXml(
        "2026/001/015.v3",
        "kx8mq2n4p3",
      ),
    });
    const truncated = new File(
      [(await intact.arrayBuffer()).slice(0, 40)],
      "truncated.docx",
      { type: DOCX_MIME_TYPE },
    );

    expect(await readDocumentReference(truncated)).toBeNull();
  });

  test.each([
    ["a look-alike character the alphabet excludes", "kx8mq2n4pl"],
    ["an uppercase code", "KX8MQ2N4P3"],
    ["a code that is too short", "kx8mq2n4p"],
    ["a code that is too long", "kx8mq2n4p33"],
    ["an empty code", ""],
  ])("answers null for %s", async (_label, code) => {
    const file = await buildDocx({
      customPropertiesXml: buildCustomPropertiesXml("2026/001/015.v3", code),
    });

    expect(await readDocumentReference(file)).toBeNull();
  });

  test("answers null for a non-DOCX file without opening it", async () => {
    const file = new File(["scanned page"], "scan.pdf", {
      type: "application/pdf",
    });

    expect(await readDocumentReference(file)).toBeNull();
  });

  test("keeps the code when the reference property is missing", async () => {
    const file = await buildDocx({
      customPropertiesXml: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<Properties xmlns="${CUSTOM_PROPS_NS}" xmlns:vt="${VT_NS}">`,
        `  <property fmtid="${FMTID}" pid="2" name="stella-code">`,
        "    <vt:lpwstr>kx8mq2n4p3</vt:lpwstr>",
        "  </property>",
        "</Properties>",
      ].join("\n"),
    });

    expect(await readDocumentReference(file)).toEqual({
      verificationCode: "kx8mq2n4p3",
      stamp: null,
    });
  });
});
