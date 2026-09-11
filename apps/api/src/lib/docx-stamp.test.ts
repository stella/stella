import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { DESKTOP_EDIT_FILE_TYPE_CONFIG } from "@/api/lib/desktop-edit-file-types";
import {
  extractStamp,
  injectStamp,
  isStampableDocx,
  stripStamp,
} from "@/api/lib/docx-stamp";

// ── Helpers ─────────────────────────────────────────────

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const DOCX_CONFIG = DESKTOP_EDIT_FILE_TYPE_CONFIG.docx;

const CONTENT_TYPES_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
  '  <Default Extension="xml" ContentType="application/xml"/>',
  '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
  `  <Override PartName="/${DOCX_CONFIG.mainPartPath}" ContentType="${DOCX_CONFIG.mainPartContentType}"/>`,
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
    expect(rels).toContain(`https://stella.legal/verify/${code}`);
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

  test("idempotent: updates existing stella stamp", async () => {
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

describe("special replacement patterns in dynamic values", () => {
  // Workspace `reference` (the source of `stamp`) is free-form user text
  // (see apps/api/src/handlers/workspaces/update-by-id.ts), so it can contain
  // sequences that String.prototype.replace treats specially inside a
  // *replacement* string: $& = the whole match, $' = text after the match,
  // etc. A naive `.replace(needle, dynamicString)` call would silently splice
  // in matched/surrounding XML instead of the literal stamp text. These
  // cases exercise every dynamic-value splice site (custom property upsert,
  // footer paragraph creation and update) with both patterns.
  const baseUrl = "https://stella.legal";
  const specialPatterns = ["$&", "$'"];

  const expectedEscape = (value: string): string =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  for (const pattern of specialPatterns) {
    test(`stamp containing "${pattern}" survives injecting into a fresh DOCX`, async () => {
      const stamp = `2026/001/015${pattern}.v3`;
      const code = "kx8mq2n4p3";
      const docx = await makeDocx();
      const stamped = await injectStamp(docx, stamp, code, baseUrl);

      const customXml = await readZipFile(stamped, "docProps/custom.xml");
      expect(customXml).toContain(expectedEscape(stamp));
      expect(customXml?.match(/<\/Properties>/gu)).toHaveLength(1);

      const footer = await readZipFile(stamped, "word/footer1.xml");
      expect(footer).toContain(expectedEscape(stamp));
      expect(footer?.match(/<\/w:ftr>/gu)).toHaveLength(1);
    });

    test(`stamp containing "${pattern}" survives updating an existing stamp`, async () => {
      const stamp = `2026/002/099${pattern}.v1`;
      const code = "abcdefghjk";
      const docx = await makeDocx();
      const first = await injectStamp(
        docx,
        "2026/001/001.v1",
        "aaaaaaaaaa",
        baseUrl,
      );
      const second = await injectStamp(first, stamp, code, baseUrl);

      const customXml = await readZipFile(second, "docProps/custom.xml");
      expect(customXml).toContain(expectedEscape(stamp));
      expect(customXml?.match(/<\/Properties>/gu)).toHaveLength(1);

      const footer = await readZipFile(second, "word/footer1.xml");
      expect(footer).toContain(expectedEscape(stamp));
      expect(footer?.match(/<\/w:ftr>/gu)).toHaveLength(1);
    });
  }
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

describe("stripStamp", () => {
  const stamp = "2026/001/015.v3";
  const code = "kx8mq2n4p3";
  const baseUrl = "https://stella.legal";
  const fmtid = "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}";
  const propsNs =
    "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties";
  const vtNs =
    "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes";

  const stampedDocx = async (): Promise<ArrayBuffer> =>
    await injectStamp(await makeDocx(), stamp, code, baseUrl);

  const stripped = async (docx: ArrayBuffer): Promise<ArrayBuffer> =>
    (await stripStamp(docx)) ??
    panic("the stamped fixture carried no reference to strip");

  test("round trip: a stamped DOCX comes back carrying nothing", async () => {
    const result = await stripped(await stampedDocx());

    expect(await extractStamp(result)).toEqual({
      stamp: null,
      verificationCode: null,
    });
    expect(await readZipFile(result, "docProps/custom.xml")).toBeNull();
    expect(await readZipFile(result, "word/footer1.xml")).not.toContain(
      "stella_dms_ref",
    );
    expect(await stripStamp(result)).toBeNull();
  });

  test("drops the part declarations with the last custom property", async () => {
    const result = await stripped(await stampedDocx());

    expect(await readZipFile(result, "[Content_Types].xml")).not.toContain(
      "custom.xml",
    );
    expect(await readZipFile(result, "_rels/.rels")).not.toContain(
      "custom.xml",
    );
  });

  test("drops the verification hyperlink relationship", async () => {
    const result = await stripped(await stampedDocx());

    expect(
      await readZipFile(result, "word/_rels/footer1.xml.rels"),
    ).not.toContain("rId_stella_vcode");
  });

  test("keeps custom properties the author set", async () => {
    const docx = await makeDocx({
      customXml: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<Properties xmlns="${propsNs}" xmlns:vt="${vtNs}">`,
        `  <property fmtid="${fmtid}" pid="2" name="Matter partner">`,
        '    <vt:lpwstr>Nováková kept name="stella-ref" as text</vt:lpwstr>',
        "  </property>",
        `  <property fmtid="${fmtid}" pid="3" name="stella-ref">`,
        `    <vt:lpwstr>${stamp}</vt:lpwstr>`,
        "  </property>",
        `  <property fmtid="${fmtid}" pid="4" name="stella-code">`,
        `    <vt:lpwstr>${code}</vt:lpwstr>`,
        "  </property>",
        "</Properties>",
      ].join("\n"),
    });

    const customXml = await readZipFile(
      await stripped(docx),
      "docProps/custom.xml",
    );
    expect(customXml).toContain("Matter partner");
    expect(customXml).toContain('Nováková kept name="stella-ref" as text');
    expect(customXml?.split('name="stella-ref"')).toHaveLength(2);
    expect(customXml).not.toContain('name="stella-code"');
  });

  test("removes every duplicate stella custom property", async () => {
    const docx = await makeDocx({
      customXml: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<Properties xmlns="${propsNs}" xmlns:vt="${vtNs}">`,
        `  <property fmtid="${fmtid}" pid="2" name="Matter partner">`,
        "    <vt:lpwstr>Nováková</vt:lpwstr>",
        "  </property>",
        `  <property fmtid="${fmtid}" pid="3" name="stella-ref">`,
        `    <vt:lpwstr>${stamp}</vt:lpwstr>`,
        "  </property>",
        `  <property fmtid="${fmtid}" pid="4" name="stella-code">`,
        `    <vt:lpwstr>${code}</vt:lpwstr>`,
        "  </property>",
        `  <property fmtid="${fmtid}" pid="5" name="stella-ref">`,
        "    <vt:lpwstr>2025/900/001.v1</vt:lpwstr>",
        "  </property>",
        `  <property fmtid="${fmtid}" pid="6" name="stella-code">`,
        "    <vt:lpwstr>mnpqrstuvw</vt:lpwstr>",
        "  </property>",
        "</Properties>",
      ].join("\n"),
    });

    const result = await stripped(docx);
    const customXml = await readZipFile(result, "docProps/custom.xml");

    expect(customXml).toContain("Matter partner");
    expect(customXml).not.toContain("stella-ref");
    expect(customXml).not.toContain("stella-code");
    expect(await extractStamp(result)).toEqual({
      stamp: null,
      verificationCode: null,
    });
  });

  test("removes every duplicated stamped footer paragraph", async () => {
    const stampedParagraph = (bookmarkId: number): string =>
      [
        "<w:p>",
        `  <w:bookmarkStart w:id="${String(bookmarkId)}" w:name="stella_dms_ref"/>`,
        `  <w:r><w:t xml:space="preserve">${stamp}  </w:t></w:r>`,
        '  <w:hyperlink r:id="rId_stella_vcode">',
        `    <w:r><w:t>stl:${code}</w:t></w:r>`,
        "  </w:hyperlink>",
        `  <w:bookmarkEnd w:id="${String(bookmarkId)}"/>`,
        "</w:p>",
      ].join("\n");
    const docx = await makeDocx({
      footerXml: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<w:ftr xmlns:w="${W_NS}" xmlns:r="${R_NS}">`,
        stampedParagraph(0),
        stampedParagraph(1),
        "</w:ftr>",
      ].join("\n"),
      footerRels: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        '  <Relationship Id="rId_stella_vcode" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://stella.legal/v/kx8mq2n4p3" TargetMode="External"/>',
        "</Relationships>",
      ].join("\n"),
    });

    const result = await stripped(docx);
    const footer = await readZipFile(result, "word/footer1.xml");

    expect(footer).not.toContain("stella_dms_ref");
    expect(footer).not.toContain(`stl:${code}`);
    expect(
      await readZipFile(result, "word/_rels/footer1.xml.rels"),
    ).not.toContain("rId_stella_vcode");
    expect(await extractStamp(result)).toEqual({
      stamp: null,
      verificationCode: null,
    });
  });

  test("keeps edited footer text without stella's machine metadata", async () => {
    const docx = await makeDocx({
      footerXml: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<w:ftr xmlns:w="${W_NS}" xmlns:r="${R_NS}">`,
        "<w:p>",
        '  <w:bookmarkStart w:id="0" w:name="stella_dms_ref"/>',
        '  <w:bookmarkStart w:id="1" w:name="stella_dms_ref"/>',
        `  <w:r><w:t xml:space="preserve">Draft — ${stamp}  </w:t></w:r>`,
        '  <w:hyperlink r:id="rId_stella_vcode">',
        `    <w:r><w:t>stl:${code.slice(0, 5)}</w:t></w:r>`,
        `    <w:r><w:t>${code.slice(5)} (do not send)</w:t></w:r>`,
        "  </w:hyperlink>",
        "  <w:r><w:t> and </w:t></w:r>",
        "  <w:r><w:t>author token stl:abcdefghjk </w:t></w:r>",
        '  <w:hyperlink r:id="rId_stella_vcode">',
        "    <w:r><w:t>stl:mnpqrstuvw (keep this note)</w:t></w:r>",
        "  </w:hyperlink>",
        '  <w:bookmarkEnd w:id="1"/>',
        '  <w:bookmarkEnd w:id="0"/>',
        "</w:p>",
        "</w:ftr>",
      ].join("\n"),
      footerRels: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        '  <Relationship Id="rId_stella_vcode" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://stella.legal/v/kx8mq2n4p3" TargetMode="External"/>',
        "</Relationships>",
      ].join("\n"),
    });

    const result = await stripped(docx);
    const footer = await readZipFile(result, "word/footer1.xml");

    expect(footer).toContain(`Draft — ${stamp}`);
    expect(footer).toContain("(do not send)");
    expect(footer).toContain("(keep this note)");
    expect(footer).toContain("author token stl:abcdefghjk");
    expect(footer).not.toContain("stella_dms_ref");
    expect(footer).not.toContain("<w:hyperlink");
    expect(
      [...(footer?.matchAll(/<w:t[^>]*>(?<text>[^<]*)<\/w:t>/gu) ?? [])]
        .map((match) => match.groups?.["text"] ?? "")
        .join(""),
    ).not.toContain(`stl:${code}`);
    expect(footer).not.toContain("stl:mnpqrstuvw");
    expect(
      await readZipFile(result, "word/_rels/footer1.xml.rels"),
    ).not.toContain("rId_stella_vcode");
    expect(await extractStamp(result)).toEqual({
      stamp: null,
      verificationCode: null,
    });
  });

  test("returns null for a DOCX that carries no reference", async () => {
    expect(await stripStamp(await makeDocx())).toBeNull();
  });

  test("does not rewrite a non-DOCX OOXML archive", async () => {
    const { mainPartContentType, mainPartPath } =
      DESKTOP_EDIT_FILE_TYPE_CONFIG.xlsx;
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        `  <Override PartName="/${mainPartPath}" ContentType="${mainPartContentType}"/>`,
        "</Types>",
      ].join("\n"),
    );
    zip.file(mainPartPath, "<workbook/>");
    zip.file(
      "docProps/custom.xml",
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<Properties xmlns="${propsNs}" xmlns:vt="${vtNs}">`,
        `  <property fmtid="${fmtid}" pid="2" name="stella-code">`,
        `    <vt:lpwstr>${code}</vt:lpwstr>`,
        "  </property>",
        "</Properties>",
      ].join("\n"),
    );

    expect(
      await stripStamp(await zip.generateAsync({ type: "arraybuffer" })),
    ).toBeNull();
  });

  test("returns null for a corrupt archive", async () => {
    expect(await stripStamp(new TextEncoder().encode("not a zip"))).toBeNull();
  });

  test("re-stamping a stripped file yields the same reference again", async () => {
    const result = await stripped(await stampedDocx());
    const restamped = await injectStamp(result, stamp, code, baseUrl);

    expect(await extractStamp(restamped)).toEqual({
      stamp,
      verificationCode: code,
    });
  });
});
