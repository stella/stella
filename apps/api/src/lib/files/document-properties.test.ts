import { PDF } from "@libpdf/core";
import { describe, expect, it } from "bun:test";
import JSZip from "jszip";

import { DOCUMENT_PROPERTY_KEYS } from "@stll/api-contract";
import type { DocumentProperty } from "@stll/api-contract";

import {
  extractDocumentProperties,
  scrubDocumentProperties,
  writeDocumentProperties,
} from "./document-properties";

const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ODT_MIME_TYPE = "application/vnd.oasis.opendocument.text";
const PDF_MIME_TYPE = "application/pdf";

const toArrayBuffer = (source: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(source.byteLength);
  new Uint8Array(buffer).set(source);
  return buffer;
};

const zipOf = async (entries: Record<string, string>): Promise<ArrayBuffer> => {
  const zip = new JSZip();
  for (const [path, body] of Object.entries(entries)) {
    zip.file(path, body);
  }
  return toArrayBuffer(await zip.generateAsync({ type: "uint8array" }));
};

const availableProperties = async (
  bytes: ArrayBuffer,
  mimeType: string,
): Promise<DocumentProperty[]> => {
  const result = await extractDocumentProperties({ bytes, mimeType });
  if (result.status !== "available") {
    throw new Error(`expected available properties, got ${result.status}`);
  }
  return result.properties;
};

const valueOf = (properties: DocumentProperty[], key: string) =>
  properties.find((property) => property.key === key)?.value;

const CORE_XML = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"',
  ' xmlns:dc="http://purl.org/dc/elements/1.1/"',
  ' xmlns:dcterms="http://purl.org/dc/terms/">',
  "<dc:title>Series Seed SANE</dc:title>",
  "<dc:creator>Jane Novak &amp; Co.</dc:creator>",
  "<cp:lastModifiedBy>tomas</cp:lastModifiedBy>",
  "<cp:revision>7</cp:revision>",
  "<dc:subject></dc:subject>",
  '<dcterms:created xsi:type="dcterms:W3CDTF">2024-03-01T09:15:00Z</dcterms:created>',
  '<dcterms:modified xsi:type="dcterms:W3CDTF">2024-05-06T11:00:00Z</dcterms:modified>',
  "</cp:coreProperties>",
].join("");

const APP_XML = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">',
  "<Application>Microsoft Office Word</Application>",
  "<AppVersion>16.0000</AppVersion>",
  "<Company>Nov&#225;k Legal</Company>",
  "<Manager></Manager>",
  "<TotalTime>135</TotalTime>",
  "<Pages>12</Pages>",
  "<Words>3120</Words>",
  "</Properties>",
].join("");

describe("extractDocumentProperties (OOXML)", () => {
  it("reads core and extended properties, decoding XML entities", async () => {
    const properties = await availableProperties(
      await zipOf({
        "docProps/core.xml": CORE_XML,
        "docProps/app.xml": APP_XML,
      }),
      DOCX_MIME_TYPE,
    );

    expect(valueOf(properties, "author")).toEqual({
      type: "text",
      value: "Jane Novak & Co.",
    });
    expect(valueOf(properties, "company")).toEqual({
      type: "text",
      value: "Novák Legal",
    });
    expect(valueOf(properties, "createdAt")).toEqual({
      type: "date",
      value: "2024-03-01T09:15:00.000Z",
    });
    expect(valueOf(properties, "editingMinutes")).toEqual({
      type: "minutes",
      value: 135,
    });
    expect(valueOf(properties, "words")).toEqual({
      type: "count",
      value: 3120,
    });
  });

  it("omits empty elements instead of showing blank rows", async () => {
    const properties = await availableProperties(
      await zipOf({
        "docProps/core.xml": CORE_XML,
        "docProps/app.xml": APP_XML,
      }),
      DOCX_MIME_TYPE,
    );

    expect(valueOf(properties, "subject")).toBeUndefined();
    expect(valueOf(properties, "manager")).toBeUndefined();
  });

  it("returns the properties in declared display order", async () => {
    const properties = await availableProperties(
      await zipOf({
        "docProps/core.xml": CORE_XML,
        "docProps/app.xml": APP_XML,
      }),
      DOCX_MIME_TYPE,
    );

    const order = properties.map((property) =>
      DOCUMENT_PROPERTY_KEYS.indexOf(property.key),
    );
    expect(order).toEqual([...order].toSorted((a, b) => a - b));
  });

  it("reports a document that carries no property parts as available but empty", async () => {
    const properties = await availableProperties(
      await zipOf({ "word/document.xml": "<w:document/>" }),
      DOCX_MIME_TYPE,
    );

    expect(properties).toEqual([]);
  });
});

describe("extractDocumentProperties (OpenDocument)", () => {
  const META_XML = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
    ' xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"',
    ' xmlns:dc="http://purl.org/dc/elements/1.1/"><office:meta>',
    "<meta:generator>LibreOffice/24.2</meta:generator>",
    "<meta:initial-creator>Jana Dvorak</meta:initial-creator>",
    "<dc:creator>Petr Sova</dc:creator>",
    "<meta:creation-date>2023-11-02T08:00:00</meta:creation-date>",
    "<meta:editing-duration>PT1H23M30S</meta:editing-duration>",
    "<meta:editing-cycles>4</meta:editing-cycles>",
    '<meta:document-statistic meta:page-count="9" meta:word-count="2400"/>',
    "</office:meta></office:document-meta>",
  ].join("");

  it("maps initial-creator to author and dc:creator to last editor", async () => {
    const properties = await availableProperties(
      await zipOf({ "meta.xml": META_XML }),
      ODT_MIME_TYPE,
    );

    expect(valueOf(properties, "author")).toEqual({
      type: "text",
      value: "Jana Dvorak",
    });
    expect(valueOf(properties, "lastModifiedBy")).toEqual({
      type: "text",
      value: "Petr Sova",
    });
  });

  it("converts an ISO-8601 editing duration to whole minutes", async () => {
    const properties = await availableProperties(
      await zipOf({ "meta.xml": META_XML }),
      ODT_MIME_TYPE,
    );

    expect(valueOf(properties, "editingMinutes")).toEqual({
      type: "minutes",
      value: 84,
    });
  });

  it("reads the document statistics off attributes", async () => {
    const properties = await availableProperties(
      await zipOf({ "meta.xml": META_XML }),
      ODT_MIME_TYPE,
    );

    expect(valueOf(properties, "pages")).toEqual({ type: "count", value: 9 });
    expect(valueOf(properties, "words")).toEqual({
      type: "count",
      value: 2400,
    });
  });
});

describe("scrubDocumentProperties", () => {
  const scrubbed = async (
    bytes: ArrayBuffer,
    mimeType: string,
  ): Promise<Uint8Array> => {
    const result = await scrubDocumentProperties({
      bytes,
      mimeType,
      scrubbedAt: new Date("2026-01-01T00:00:00Z"),
    });
    if (result.status !== "scrubbed") {
      throw new Error(`expected scrubbed bytes, got ${result.status}`);
    }
    return result.bytes;
  };

  /**
   * The only assertion that means anything for a scrub: the identifying
   * strings are gone from the bytes, not merely hidden from our own reader.
   */
  const assertNoTrace = (bytes: Uint8Array, needles: string[]) => {
    // latin1, not utf-8: a PDF's compressed and binary sections are not valid
    // utf-8, and a lossy decode could drop the very bytes under test.
    const raw = Buffer.from(bytes).toString("latin1");
    for (const needle of needles) {
      expect(raw).not.toContain(needle);
    }
  };

  it("removes names, company and drafting history from an OOXML package", async () => {
    const source = await zipOf({
      "docProps/core.xml": CORE_XML,
      "docProps/app.xml": APP_XML,
    });

    const result = await scrubbed(source, DOCX_MIME_TYPE);

    assertNoTrace(result, ["Jane Novak", "tomas", "Novák Legal"]);
    const buffer = toArrayBuffer(result);
    const after = await availableProperties(buffer, DOCX_MIME_TYPE);
    expect(valueOf(after, "author")).toBeUndefined();
    expect(valueOf(after, "company")).toBeUndefined();
    expect(valueOf(after, "lastModifiedBy")).toBeUndefined();
    expect(valueOf(after, "createdAt")).toBeUndefined();
    expect(valueOf(after, "editingMinutes")).toBeUndefined();
  });

  it("keeps the counts and the producing application, which identify nobody", async () => {
    const source = await zipOf({
      "docProps/core.xml": CORE_XML,
      "docProps/app.xml": APP_XML,
    });

    const after = await availableProperties(
      toArrayBuffer(await scrubbed(source, DOCX_MIME_TYPE)),
      DOCX_MIME_TYPE,
    );

    expect(valueOf(after, "words")).toEqual({ type: "count", value: 3120 });
    expect(valueOf(after, "application")).toEqual({
      type: "text",
      value: "Microsoft Office Word",
    });
  });

  it("leaves docProps/custom.xml alone so stella's own stamp survives", async () => {
    const custom =
      '<?xml version="1.0"?><Properties><property name="stella_dms_ref">' +
      "<vt:lpwstr>2026/001/015.v3</vt:lpwstr></property></Properties>";
    const source = await zipOf({
      "docProps/core.xml": CORE_XML,
      "docProps/custom.xml": custom,
    });

    const result = await scrubbed(source, DOCX_MIME_TYPE);

    assertNoTrace(result, ["Jane Novak"]);
    const archive = await new JSZip().loadAsync(result);
    const preserved = await archive
      .file("docProps/custom.xml")
      ?.async("string");
    expect(preserved).toContain("2026/001/015.v3");
  });

  it("clears the OpenDocument meta part, statistics included", async () => {
    const meta = [
      '<?xml version="1.0"?>',
      "<office:document-meta><office:meta>",
      "<meta:initial-creator>Jana Dvorak</meta:initial-creator>",
      "<dc:creator>Petr Sova</dc:creator>",
      "<meta:editing-duration>PT1H23M30S</meta:editing-duration>",
      '<meta:document-statistic meta:page-count="9"/>',
      "</office:meta></office:document-meta>",
    ].join("");

    const result = await scrubbed(
      await zipOf({ "meta.xml": meta }),
      ODT_MIME_TYPE,
    );

    assertNoTrace(result, ["Jana Dvorak", "Petr Sova", "PT1H23M30S"]);
    expect(
      await availableProperties(toArrayBuffer(result), ODT_MIME_TYPE),
    ).toEqual([]);
  });

  it("removes PDF Info and the XMP packet that duplicates it", async () => {
    const doc = PDF.create();
    doc.addPage();
    doc.setTitle("Project Falcon draft 3");
    doc.setAuthor("Jana Novakova");
    doc.setSubject("Internal only");
    doc.setKeywords(["confidential"]);
    doc.setProducer("Acme PDF 9");
    doc.setCreationDate(new Date("2024-03-01T09:15:00Z"));
    const source = toArrayBuffer(await doc.save());

    const result = await scrubbed(source, PDF_MIME_TYPE);

    assertNoTrace(result, [
      "Project Falcon",
      "Jana Novakova",
      "Internal only",
      "confidential",
      "Acme PDF 9",
    ]);
    const reloaded = await PDF.load(result);
    expect(reloaded.getAuthor()).toBeFalsy();
    expect(reloaded.getTitle()).toBeFalsy();
    // The copy is dated when it was produced, not when the original was drafted.
    expect(reloaded.getCreationDate()?.toISOString()).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("refuses a signed PDF rather than silently breaking the signature", async () => {
    const doc = PDF.create();
    doc.addPage();
    doc.getOrCreateForm().createSignatureField("Signature1");
    const source = toArrayBuffer(await doc.save());

    const result = await scrubDocumentProperties({
      bytes: source,
      mimeType: PDF_MIME_TYPE,
    });

    expect(result.status).toBe("signed");
  });

  it("refuses a format it cannot clean instead of returning it untouched", async () => {
    const result = await scrubDocumentProperties({
      bytes: new ArrayBuffer(8),
      mimeType: "application/msword",
    });

    expect(result).toEqual({ status: "unsupported-format" });
  });
});

describe("extractDocumentProperties (failure modes)", () => {
  it("reports a format it cannot read rather than an empty list", async () => {
    const result = await extractDocumentProperties({
      bytes: new ArrayBuffer(8),
      mimeType: "application/msword",
    });

    expect(result).toEqual({ status: "unsupported-format" });
  });

  it("reports bytes that are not the archive their MIME type claims", async () => {
    const result = await extractDocumentProperties({
      bytes: toArrayBuffer(new TextEncoder().encode("not a zip at all")),
      mimeType: DOCX_MIME_TYPE,
    });

    expect(result).toEqual({ status: "unreadable" });
  });
});

describe("writeDocumentProperties", () => {
  const source = async () =>
    await zipOf({
      "docProps/core.xml": CORE_XML,
      "docProps/app.xml": APP_XML,
      "word/document.xml": "<w:document/>",
    });

  const writtenBytes = async (
    values: Parameters<typeof writeDocumentProperties>[0]["values"],
  ): Promise<ArrayBuffer> => {
    const result = await writeDocumentProperties({
      bytes: await source(),
      mimeType: DOCX_MIME_TYPE,
      values,
    });
    if (result.status !== "written") {
      throw new Error(`expected written bytes, got ${result.status}`);
    }
    return toArrayBuffer(result.bytes);
  };

  it("writes each property into the part it belongs to", async () => {
    const written = await writtenBytes({
      author: "Petra Harbrook",
      company: "Harbrook & Partners",
    });

    const properties = await availableProperties(written, DOCX_MIME_TYPE);
    expect(valueOf(properties, "author")).toEqual({
      type: "text",
      value: "Petra Harbrook",
    });
    // core.xml and app.xml have different roots and namespaces, so a value
    // written into the wrong part reads back missing.
    expect(valueOf(properties, "company")).toEqual({
      type: "text",
      value: "Harbrook & Partners",
    });
  });

  it("escapes markup so a value cannot forge a sibling property", async () => {
    const injection = "</dc:title><dc:creator>forged</dc:creator><dc:title>";
    const written = await writtenBytes({ title: injection });

    const properties = await availableProperties(written, DOCX_MIME_TYPE);
    expect(valueOf(properties, "title")).toEqual({
      type: "text",
      value: injection,
    });
    // The forged element must not have displaced the real author.
    expect(valueOf(properties, "author")).toEqual({
      type: "text",
      value: "Jane Novak & Co.",
    });
  });

  it("writes replacement patterns literally", async () => {
    // JS interprets $&, $$, $` and $' in a replacement string even when the
    // search is a plain string, so a value containing them would otherwise
    // splice the surrounding markup into the property.
    const value = "Dollar $& and $$ and $` and $' and $1";
    const written = await writtenBytes({ company: value });

    expect(
      valueOf(await availableProperties(written, DOCX_MIME_TYPE), "company"),
    ).toEqual({ type: "text", value });
  });

  it("fills an element the document left empty", async () => {
    const written = await writtenBytes({ manager: "Tomas" });

    expect(
      valueOf(await availableProperties(written, DOCX_MIME_TYPE), "manager"),
    ).toEqual({ type: "text", value: "Tomas" });
  });

  it("adds a property the document never carried", async () => {
    // CORE_XML has no cp:category at all, so this can only be satisfied by
    // appending a new element before the closing root.
    const written = await writtenBytes({ category: "Financing" });

    expect(
      valueOf(await availableProperties(written, DOCX_MIME_TYPE), "category"),
    ).toEqual({ type: "text", value: "Financing" });
  });

  it("leaves properties it was not asked to change alone", async () => {
    const written = await writtenBytes({ author: "Someone Else" });

    const properties = await availableProperties(written, DOCX_MIME_TYPE);
    expect(valueOf(properties, "title")).toEqual({
      type: "text",
      value: "Series Seed SANE",
    });
    expect(valueOf(properties, "lastModifiedBy")).toEqual({
      type: "text",
      value: "tomas",
    });
  });

  it("creates the properties parts a document never carried", async () => {
    // Plenty of generators emit no docProps at all. Skipping the write there
    // reported success and changed nothing, so every edit to such a file was
    // silently discarded.
    const bare = await zipOf({
      "[Content_Types].xml":
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        "</Types>",
      "_rels/.rels":
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        "</Relationships>",
      "word/document.xml": "<w:document/>",
    });

    const result = await writeDocumentProperties({
      bytes: bare,
      mimeType: DOCX_MIME_TYPE,
      values: { author: "Petra Harbrook", company: "Harbrook & Partners" },
    });
    if (result.status !== "written") {
      throw new Error(`expected written bytes, got ${result.status}`);
    }
    const written = toArrayBuffer(result.bytes);

    const properties = await availableProperties(written, DOCX_MIME_TYPE);
    expect(valueOf(properties, "author")).toEqual({
      type: "text",
      value: "Petra Harbrook",
    });
    expect(valueOf(properties, "company")).toEqual({
      type: "text",
      value: "Harbrook & Partners",
    });

    // A part no reader can find is the same as no part at all, so both
    // manifests must declare it and the relationship id must not collide.
    const archive = await JSZip.loadAsync(written);
    const contentTypes = await archive
      .file("[Content_Types].xml")
      ?.async("string");
    const rels = await archive.file("_rels/.rels")?.async("string");
    expect(contentTypes).toContain("/docProps/core.xml");
    expect(contentTypes).toContain("/docProps/app.xml");
    expect(rels).toContain("docProps/core.xml");
    expect(rels).toContain("docProps/app.xml");
    expect(rels).toContain('Id="rId2"');
    expect(rels).toContain('Id="rId3"');
  });

  it("refuses a format it cannot write rather than returning the input unchanged", async () => {
    const result = await writeDocumentProperties({
      bytes: await zipOf({
        "meta.xml":
          '<office:document-meta xmlns:office="urn:office"></office:document-meta>',
      }),
      mimeType: ODT_MIME_TYPE,
      values: { author: "Petra" },
    });

    expect(result).toEqual({ status: "unsupported-format" });
  });

  it("reports bytes that are not the archive their MIME type claims", async () => {
    const result = await writeDocumentProperties({
      bytes: toArrayBuffer(new TextEncoder().encode("not a zip at all")),
      mimeType: DOCX_MIME_TYPE,
      values: { author: "Petra" },
    });

    expect(result).toEqual({ status: "unreadable" });
  });
});
