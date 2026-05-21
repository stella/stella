import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import {
  extractStamp,
  injectStamp,
  isStampableDocx,
} from "@/api/lib/docx-stamp";

// ── Helpers ─────────────────────────────────────────────

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const CONTENT_TYPES_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
  '  <Default Extension="xml" ContentType="application/xml"/>',
  '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
  "</Types>",
].join("\n");

const makeDocx = async (opts?: {
  documentXml?: string;
  footerXml?: string;
  footerRels?: string;
  customXml?: string;
  contentTypes?: string;
  docRels?: string;
}): Promise<ArrayBuffer> => {
  const zip = new JSZip();

  zip.file(
    "word/document.xml",
    opts?.documentXml ??
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}">`,
        "<w:body>",
        "<w:p><w:r><w:t>Hello</w:t></w:r></w:p>",
        "<w:sectPr></w:sectPr>",
        "</w:body>",
        "</w:document>",
      ].join("\n"),
  );

  zip.file("[Content_Types].xml", opts?.contentTypes ?? CONTENT_TYPES_XML);

  if (opts?.docRels) {
    zip.file("word/_rels/document.xml.rels", opts.docRels);
  }
  if (opts?.footerXml) {
    zip.file("word/footer1.xml", opts.footerXml);
  }
  if (opts?.footerRels) {
    zip.file("word/_rels/footer1.xml.rels", opts.footerRels);
  }
  if (opts?.customXml) {
    zip.file("docProps/custom.xml", opts.customXml);
  }

  return zip.generateAsync({ type: "arraybuffer" });
};

const readZipFile = async (
  buffer: ArrayBuffer,
  path: string,
): Promise<string | null> => {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file(path);
  if (!file) {
    return null;
  }
  return file.async("string");
};

// ── Tests ───────────────────────────────────────────────

describe("isStampableDocx", () => {
  test("returns true for DOCX under 50 MB", () => {
    expect(isStampableDocx(DOCX_MIME, 1024)).toBe(true);
  });

  test("returns false for non-DOCX mime type", () => {
    expect(isStampableDocx("application/pdf", 1024)).toBe(false);
  });

  test("returns false for files over 50 MB", () => {
    expect(isStampableDocx(DOCX_MIME, 51 * 1024 * 1024)).toBe(false);
  });
});

describe("injectStamp", () => {
  const stamp = "2026/001/015.v3";
  const code = "kx8mq2n4p3";
  const baseUrl = "https://stella.legal";

  test("injects custom properties into new DOCX", async () => {
    const docx = await makeDocx();
    const stamped = await injectStamp(docx, stamp, code, baseUrl);

    const customXml = await readZipFile(stamped, "docProps/custom.xml");
    expect(customXml).not.toBeNull();
    expect(customXml).toContain("stella-ref");
    expect(customXml).toContain(stamp);
    expect(customXml).toContain("stella-code");
    expect(customXml).toContain(code);
  });

  test("injects footer into DOCX without existing footer", async () => {
    const docx = await makeDocx();
    const stamped = await injectStamp(docx, stamp, code, baseUrl);

    const footer = await readZipFile(stamped, "word/footer1.xml");
    expect(footer).not.toBeNull();
    expect(footer).toContain("stella_dms_ref");
    expect(footer).toContain(stamp);
    expect(footer).toContain(`stl:${code}`);
  });

  test("adds footer reference to document.xml sectPr", async () => {
    const docx = await makeDocx();
    const stamped = await injectStamp(docx, stamp, code, baseUrl);

    const docXml = await readZipFile(stamped, "word/document.xml");
    expect(docXml).toContain("footerReference");
    expect(docXml).toContain("rId_stella_footer");
  });

  test("creates hyperlink in footer rels", async () => {
    const docx = await makeDocx();
    const stamped = await injectStamp(docx, stamp, code, baseUrl);

    const rels = await readZipFile(stamped, "word/_rels/footer1.xml.rels");
    expect(rels).not.toBeNull();
    expect(rels).toContain(`https://stella.legal/v/${code}`);
  });

  test("updates Content_Types for custom properties", async () => {
    const docx = await makeDocx();
    const stamped = await injectStamp(docx, stamp, code, baseUrl);

    const ct = await readZipFile(stamped, "[Content_Types].xml");
    expect(ct).toContain("custom-properties");
  });

  test("appends to existing footer without removing content", async () => {
    const relNs =
      "http://schemas.openxmlformats.org/package/2006/relationships";
    const footerRelType =
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer";

    const docx = await makeDocx({
      footerXml: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<w:ftr xmlns:w="${W_NS}" xmlns:r="${R_NS}">`,
        "<w:p><w:r><w:t>Existing footer</w:t></w:r></w:p>",
        "</w:ftr>",
      ].join("\n"),
      docRels: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<Relationships xmlns="${relNs}">`,
        `  <Relationship Id="rId1" Type="${footerRelType}" Target="footer1.xml"/>`,
        "</Relationships>",
      ].join("\n"),
    });

    const stamped = await injectStamp(docx, stamp, code, baseUrl);

    const footer = await readZipFile(stamped, "word/footer1.xml");
    expect(footer).toContain("Existing footer");
    expect(footer).toContain("stella_dms_ref");
    expect(footer).toContain(stamp);
  });

  test("idempotent: updates existing Stella stamp", async () => {
    const docx = await makeDocx();
    const first = await injectStamp(
      docx,
      "2026/001/001.v1",
      "aaaaaaaaaa",
      baseUrl,
    );
    const second = await injectStamp(first, stamp, code, baseUrl);

    const footer = await readZipFile(second, "word/footer1.xml");
    expect(footer).toContain(stamp);
    expect(footer).not.toContain("2026/001/001.v1");
    const bookmarkCount = (footer?.match(/stella_dms_ref/gu) ?? []).length;
    expect(bookmarkCount).toBeLessThanOrEqual(2);

    const customXml = await readZipFile(second, "docProps/custom.xml");
    expect(customXml).toContain(stamp);
    expect(customXml).toContain(code);
    expect(customXml).not.toContain("aaaaaaaaaa");
  });

  test("updates existing custom properties", async () => {
    const fmtid = "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}";
    const propsNs =
      "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties";
    const vtNs =
      "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes";

    const docx = await makeDocx({
      customXml: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<Properties xmlns="${propsNs}" xmlns:vt="${vtNs}">`,
        `  <property fmtid="${fmtid}" pid="2" name="stella-ref">`,
        "    <vt:lpwstr>old/ref</vt:lpwstr>",
        "  </property>",
        `  <property fmtid="${fmtid}" pid="3" name="stella-code">`,
        "    <vt:lpwstr>oldcode123</vt:lpwstr>",
        "  </property>",
        "</Properties>",
      ].join("\n"),
    });

    const stamped = await injectStamp(docx, stamp, code, baseUrl);
    const customXml = await readZipFile(stamped, "docProps/custom.xml");
    expect(customXml).toContain(stamp);
    expect(customXml).toContain(code);
    expect(customXml).not.toContain("old/ref");
    expect(customXml).not.toContain("oldcode123");
  });
});

describe("placeholder replacement", () => {
  const stamp = "2026/001/015.v3";
  const code = "kx8mq2n4p3";
  const baseUrl = "https://stella.legal";

  test("replaces {{STELLA_ID}} with stamp + code", async () => {
    const docx = await makeDocx({
      documentXml: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}">`,
        "<w:body>",
        "<w:p><w:r><w:t>Ref: {{STELLA_ID}}</w:t></w:r></w:p>",
        "<w:sectPr></w:sectPr>",
        "</w:body>",
        "</w:document>",
      ].join("\n"),
    });

    const stamped = await injectStamp(docx, stamp, code, baseUrl);
    const docXml = await readZipFile(stamped, "word/document.xml");
    expect(docXml).toContain(stamp);
    expect(docXml).toContain(`stl:${code}`);
    expect(docXml).not.toContain("{{STELLA_ID}}");
  });

  test("replaces {{STELLA_REF}} and {{STELLA_CODE}} separately", async () => {
    const docx = await makeDocx({
      documentXml: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}">`,
        "<w:body>",
        "<w:p><w:r><w:t>Doc: {{STELLA_REF}}</w:t></w:r></w:p>",
        "<w:p><w:r><w:t>Code: {{STELLA_CODE}}</w:t></w:r></w:p>",
        "<w:sectPr></w:sectPr>",
        "</w:body>",
        "</w:document>",
      ].join("\n"),
    });

    const stamped = await injectStamp(docx, stamp, code, baseUrl);
    const docXml = await readZipFile(stamped, "word/document.xml");
    expect(docXml).toContain(`Doc: ${stamp}`);
    expect(docXml).toContain(`Code: stl:${code}`);
  });

  test("skips auto-footer when placeholders are present", async () => {
    const docx = await makeDocx({
      documentXml: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}">`,
        "<w:body>",
        "<w:p><w:r><w:t>{{STELLA_ID}}</w:t></w:r></w:p>",
        "<w:sectPr></w:sectPr>",
        "</w:body>",
        "</w:document>",
      ].join("\n"),
    });

    const stamped = await injectStamp(docx, stamp, code, baseUrl);

    // No auto-generated footer file
    const footer = await readZipFile(stamped, "word/footer1.xml");
    expect(footer).toBeNull();

    // But custom properties are still injected
    const customXml = await readZipFile(stamped, "docProps/custom.xml");
    expect(customXml).toContain("stella-ref");
  });

  test("injects footer when no placeholders found", async () => {
    const docx = await makeDocx();
    const stamped = await injectStamp(docx, stamp, code, baseUrl);
    const footer = await readZipFile(stamped, "word/footer1.xml");
    expect(footer).not.toBeNull();
    expect(footer).toContain("stella_dms_ref");
  });
});

describe("extractStamp", () => {
  const stamp = "2026/001/015.v3";
  const code = "kx8mq2n4p3";
  const fmtid = "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}";
  const propsNs =
    "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties";
  const vtNs =
    "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes";

  test("extracts from custom properties", async () => {
    const docx = await makeDocx({
      customXml: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<Properties xmlns="${propsNs}" xmlns:vt="${vtNs}">`,
        `  <property fmtid="${fmtid}" pid="2" name="stella-ref">`,
        `    <vt:lpwstr>${stamp}</vt:lpwstr>`,
        "  </property>",
        `  <property fmtid="${fmtid}" pid="3" name="stella-code">`,
        `    <vt:lpwstr>${code}</vt:lpwstr>`,
        "  </property>",
        "</Properties>",
      ].join("\n"),
    });

    const result = await extractStamp(docx);
    expect(result.stamp).toBe(stamp);
    expect(result.verificationCode).toBe(code);
  });

  test("falls back to footer bookmark", async () => {
    const docx = await makeDocx({
      footerXml: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<w:ftr xmlns:w="${W_NS}" xmlns:r="${R_NS}">`,
        "<w:p>",
        '  <w:bookmarkStart w:id="0" w:name="stella_dms_ref"/>',
        "  <w:r><w:rPr/>",
        `    <w:t xml:space="preserve">${stamp}  </w:t>`,
        "  </w:r>",
        '  <w:hyperlink r:id="rId1">',
        `    <w:r><w:t>stl:${code}</w:t></w:r>`,
        "  </w:hyperlink>",
        '  <w:bookmarkEnd w:id="0"/>',
        "</w:p>",
        "</w:ftr>",
      ].join("\n"),
    });

    const result = await extractStamp(docx);
    expect(result.stamp).toBe(stamp);
    expect(result.verificationCode).toBe(code);
  });

  test("returns nulls for plain DOCX", async () => {
    const docx = await makeDocx();
    const result = await extractStamp(docx);
    expect(result.stamp).toBeNull();
    expect(result.verificationCode).toBeNull();
  });

  test("round-trip: inject then extract", async () => {
    const docx = await makeDocx();
    const stamped = await injectStamp(
      docx,
      stamp,
      code,
      "https://stella.legal",
    );
    const result = await extractStamp(stamped);
    expect(result.stamp).toBe(stamp);
    expect(result.verificationCode).toBe(code);
  });

  test("custom properties take priority over footer", async () => {
    const docx = await makeDocx({
      customXml: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<Properties xmlns="${propsNs}" xmlns:vt="${vtNs}">`,
        `  <property fmtid="${fmtid}" pid="2" name="stella-code">`,
        "    <vt:lpwstr>propscode99</vt:lpwstr>",
        "  </property>",
        "</Properties>",
      ].join("\n"),
      footerXml: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<w:ftr xmlns:w="${W_NS}" xmlns:r="${R_NS}">`,
        "<w:p>",
        '  <w:bookmarkStart w:id="0" w:name="stella_dms_ref"/>',
        "  <w:r>",
        `    <w:t xml:space="preserve">${stamp}  </w:t>`,
        "  </w:r>",
        '  <w:hyperlink r:id="rId1">',
        "    <w:r><w:t>stl:footercode</w:t></w:r>",
        "  </w:hyperlink>",
        '  <w:bookmarkEnd w:id="0"/>',
        "</w:p>",
        "</w:ftr>",
      ].join("\n"),
    });

    const result = await extractStamp(docx);
    expect(result.verificationCode).toBe("propscode99");
  });
});
