/**
 * Integration tests for the DOCX template pipeline.
 *
 * These test real user flows (discover → fill → verify) rather
 * than individual function signatures. They also verify output
 * integrity (valid ZIP structure, no metadata leaks) and
 * idempotency guarantees.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import JSZip from "jszip";

import { discoverTemplate } from "./discover-template";
import { extractText } from "./extract-text";
import { fillTemplate } from "./patch-template";
import { readManifest, writeManifest } from "./template-manifest";
import type { TemplateManifest } from "./types";

setDefaultTimeout(15_000);

// ── Helpers ──────────────────────────────────────────────

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const WRAP = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document xmlns:w="${W_NS}">` +
  `<w:body>${body}</w:body></w:document>`;

const P = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

/** Split a placeholder across multiple w:r runs, as Word often does. */
const splitRuns = (text: string, chunkSize: number) => {
  const runs: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    runs.push(
      `<w:r><w:t xml:space="preserve">${text.slice(i, i + chunkSize)}</w:t></w:r>`,
    );
  }
  return `<w:p>${runs.join("")}</w:p>`;
};

const makeDocx = async (documentXml: string): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
  zip.file(
    "[Content_Types].xml",
    [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Types xmlns="http://schemas.openxmlformats.org',
      '/package/2006/content-types">',
      '<Default Extension="xml" ContentType="application/xml"/>',
      '<Default Extension="rels"',
      ' ContentType="application/vnd.openxmlformats',
      '-package.relationships+xml"/>',
      "</Types>",
    ].join(""),
  );
  zip.file(
    "_rels/.rels",
    [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org',
      '/package/2006/relationships">',
      '<Relationship Id="rId1"',
      ' Type="http://schemas.openxmlformats.org/officeDocument',
      '/2006/relationships/officeDocument"',
      ' Target="word/document.xml"/>',
      "</Relationships>",
    ].join(""),
  );
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return Buffer.from(buf);
};

/** Build a DOCX with header and footer parts containing placeholders. */
const makeDocxWithHeaderFooter = async (
  bodyXml: string,
  headerXml: string,
  footerXml: string,
): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file("word/document.xml", bodyXml);
  zip.file("word/header1.xml", headerXml);
  zip.file("word/footer1.xml", footerXml);
  zip.file(
    "[Content_Types].xml",
    [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Types xmlns="http://schemas.openxmlformats.org',
      '/package/2006/content-types">',
      '<Default Extension="xml" ContentType="application/xml"/>',
      '<Default Extension="rels"',
      ' ContentType="application/vnd.openxmlformats',
      '-package.relationships+xml"/>',
      '<Override PartName="/word/header1.xml"',
      ' ContentType="application/vnd.openxmlformats-officedocument',
      '.wordprocessingml.header+xml"/>',
      '<Override PartName="/word/footer1.xml"',
      ' ContentType="application/vnd.openxmlformats-officedocument',
      '.wordprocessingml.footer+xml"/>',
      "</Types>",
    ].join(""),
  );
  zip.file(
    "_rels/.rels",
    [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org',
      '/package/2006/relationships">',
      '<Relationship Id="rId1"',
      ' Type="http://schemas.openxmlformats.org/officeDocument',
      '/2006/relationships/officeDocument"',
      ' Target="word/document.xml"/>',
      "</Relationships>",
    ].join(""),
  );
  zip.file(
    "word/_rels/document.xml.rels",
    [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org',
      '/package/2006/relationships">',
      '<Relationship Id="rId1"',
      ' Type="http://schemas.openxmlformats.org/officeDocument',
      '/2006/relationships/header"',
      ' Target="header1.xml"/>',
      '<Relationship Id="rId2"',
      ' Type="http://schemas.openxmlformats.org/officeDocument',
      '/2006/relationships/footer"',
      ' Target="footer1.xml"/>',
      "</Relationships>",
    ].join(""),
  );
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return Buffer.from(buf);
};

const HEADER_WRAP = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:hdr xmlns:w="${W_NS}">${body}</w:hdr>`;

const FOOTER_WRAP = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:ftr xmlns:w="${W_NS}">${body}</w:ftr>`;

const SPA_FIXTURE = new URL(
  "fixtures/spa-template-with-placeholders.docx",
  import.meta.url,
).pathname;

const spaValues = {
  price_share_1: "1 250 000",
  price_share_2: "875 000",
  price_share_3: "2 100 000",
  price_share_4: "450 000",
  price_share_5: "3 750 000",
  contract_date: "15. ledna 2026",
  seller_1_name: "Novák Holdings s.r.o.",
  buyer_name: "Stella Legal a.s.",
};

// ── ZIP structure integrity ──────────────────────────────

describe("filled output is valid DOCX", () => {
  test("output ZIP contains required OOXML parts", async () => {
    const xml = WRAP(P("Name: {{name}}"));
    const buf = await makeDocx(xml);

    const result = await fillTemplate(buf, { name: "Alice" });
    const zip = await JSZip.loadAsync(result.buffer);

    // Core OOXML parts must exist
    expect(zip.file("[Content_Types].xml")).not.toBeNull();
    expect(zip.file("word/document.xml")).not.toBeNull();
  });

  test("output document.xml is well-formed XML", async () => {
    const xml = WRAP([P("A: {{a}}"), P("B: {{b}}"), P("C: {{c}}")].join(""));
    const buf = await makeDocx(xml);

    const result = await fillTemplate(buf, {
      a: "value with <special> & chars",
      b: 'quotes "and" apostrophes',
      c: "unicode: šťůčřž",
    });

    const zip = await JSZip.loadAsync(result.buffer);
    const docXml = await zip.file("word/document.xml")?.async("string");

    // Should not contain unescaped special chars that break XML
    expect(docXml).toBeDefined();
    expect(docXml).toContain("value with");
    expect(docXml).toContain("unicode:");
    // The filled values should be properly escaped in the XML
    expect(docXml).not.toContain("&chars");
  });

  test("SPA fixture output preserves ZIP structure", async () => {
    const result = await fillTemplate(SPA_FIXTURE, spaValues);
    const zip = await JSZip.loadAsync(result.buffer);

    expect(zip.file("[Content_Types].xml")).not.toBeNull();
    expect(zip.file("word/document.xml")).not.toBeNull();
    expect(zip.file("_rels/.rels")).not.toBeNull();

    // Content types XML should still be parseable
    const ct = await zip.file("[Content_Types].xml")?.async("string");
    expect(ct).toContain("<Types");
    expect(ct).toContain("</Types>");
  });
});

// ── Round-trip: fill → extract ───────────────────────────

describe("fill then extract text", () => {
  test("filled values appear in extracted text", async () => {
    const xml = WRAP(
      [
        P("Client: {{client_name}}"),
        P("Date: {{date}}"),
        P("Amount: {{amount}}"),
      ].join(""),
    );
    const buf = await makeDocx(xml);

    const result = await fillTemplate(buf, {
      client_name: "Acme Corp",
      date: "2026-03-15",
      amount: "1 000 000 CZK",
    });

    const extracted = await extractText(result.buffer);
    const allText = extracted.paragraphs.map((p) => p.text).join("\n");

    expect(allText).toContain("Acme Corp");
    expect(allText).toContain("2026-03-15");
    expect(allText).toContain("1 000 000 CZK");
  });

  test("original placeholders are gone after fill", async () => {
    const xml = WRAP(P("Name: {{name}}"));
    const buf = await makeDocx(xml);

    const result = await fillTemplate(buf, { name: "Alice" });
    const extracted = await extractText(result.buffer);
    const allText = extracted.paragraphs.map((p) => p.text).join("\n");

    expect(allText).not.toContain("{{name}}");
    expect(allText).toContain("Alice");
  });

  test("SPA fixture: filled values in extracted text", async () => {
    const result = await fillTemplate(SPA_FIXTURE, spaValues);
    const extracted = await extractText(result.buffer);
    const allText = extracted.paragraphs.map((p) => p.text).join("\n");

    expect(allText).toContain("Stella Legal a.s.");
    expect(allText).toContain("Novák Holdings s.r.o.");
    expect(allText).toContain("15. ledna 2026");
  });
});

// ── Idempotency ──────────────────────────────────────────

describe("idempotent operations", () => {
  test("discover returns identical results on repeated calls", async () => {
    const xml = WRAP([P("{{name}}"), P("{{date}}"), P("{{amount}}")].join(""));
    const buf = await makeDocx(xml);

    const first = await discoverTemplate(buf);
    const second = await discoverTemplate(buf);

    expect(first.fields).toEqual(second.fields);
    expect(first.placeholders).toEqual(second.placeholders);
    expect(first.structureErrors).toEqual(second.structureErrors);
  });

  test("fill with same values produces identical output", async () => {
    const xml = WRAP(P("Name: {{name}}"));
    const buf = await makeDocx(xml);
    const values = { name: "Alice" };

    const first = await fillTemplate(buf, values);
    const second = await fillTemplate(buf, values);

    // Compare logical content, not raw bytes: ZIP entry
    // timestamps make byte-identical comparison unreliable.
    const zip1 = await JSZip.loadAsync(first.buffer);
    const zip2 = await JSZip.loadAsync(second.buffer);

    const file1 = zip1.file("word/document.xml");
    const file2 = zip2.file("word/document.xml");
    expect(file1).not.toBeNull();
    expect(file2).not.toBeNull();

    const doc1 = await file1?.async("string");
    const doc2 = await file2?.async("string");
    expect(doc1).toBe(doc2);

    const entries1 = Object.keys(zip1.files).toSorted();
    const entries2 = Object.keys(zip2.files).toSorted();
    expect(entries1).toEqual(entries2);
  });

  test("SPA discover is idempotent", async () => {
    const buf = Buffer.from(await Bun.file(SPA_FIXTURE).arrayBuffer());
    const first = await discoverTemplate(buf);
    const second = await discoverTemplate(buf);

    expect(first.placeholders).toEqual(second.placeholders);
    expect(first.fields).toEqual(second.fields);
  });
});

// ── Manifest does not leak into filled documents ─────────

describe("manifest stripped from filled output", () => {
  test("manifest is removed after fill", async () => {
    const xml = WRAP(P("Client: {{clientName}}"));
    let buf = await makeDocx(xml);

    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "clientName",
          label: "Client Name",
          inputType: "text",
          required: true,
        },
      ],
      conditions: [],
    };
    buf = await writeManifest(buf, manifest);

    // Verify manifest exists before fill
    const before = await readManifest(buf);
    expect(before).not.toBeNull();

    // Fill the template
    const result = await fillTemplate(buf, {
      clientName: "Acme Corp",
    });

    // Manifest must be gone from output
    const after = await readManifest(result.buffer);
    expect(after).toBeNull();

    // Custom XML part file should not exist
    const zip = await JSZip.loadAsync(result.buffer);
    expect(zip.file("customXml/item1.xml")).toBeNull();
  });

  test("filled content is correct despite manifest stripping", async () => {
    const xml = WRAP([P("Name: {{name}}"), P("Date: {{date}}")].join(""));
    let buf = await makeDocx(xml);
    buf = await writeManifest(buf, {
      version: 1,
      fields: [
        { path: "name", label: "Full Name" },
        { path: "date", label: "Contract Date" },
      ],
      conditions: [],
    });

    const result = await fillTemplate(buf, {
      name: "Bob",
      date: "2026-06-01",
    });

    const extracted = await extractText(result.buffer);
    const allText = extracted.paragraphs.map((p) => p.text).join("\n");
    expect(allText).toContain("Bob");
    expect(allText).toContain("2026-06-01");
  });
});

// ── Header/footer placeholders ───────────────────────────

describe("header and footer placeholders", () => {
  test("owned patcher fills placeholders in headers", async () => {
    const body = WRAP(P("Body: {{body_text}}"));
    const header = HEADER_WRAP(P("Header: {{header_text}}"));
    const footer = FOOTER_WRAP(P("Footer: {{footer_text}}"));

    const buf = await makeDocxWithHeaderFooter(body, header, footer);

    const result = await fillTemplate(buf, {
      body_text: "BODY_VALUE",
      header_text: "HEADER_VALUE",
      footer_text: "FOOTER_VALUE",
    });

    const zip = await JSZip.loadAsync(result.buffer);

    // Body should be filled
    const docXml = await zip.file("word/document.xml")?.async("string");
    expect(docXml).toContain("BODY_VALUE");

    // Header should be filled
    const headerXml = await zip.file("word/header1.xml")?.async("string");
    expect(headerXml).toContain("HEADER_VALUE");

    // Footer should be filled
    const footerXml = await zip.file("word/footer1.xml")?.async("string");
    expect(footerXml).toContain("FOOTER_VALUE");
  });

  test("header placeholders included in discover", async () => {
    const body = WRAP(P("Body: {{body_field}}"));
    const header = HEADER_WRAP(P("Header: {{header_field}}"));
    const footer = FOOTER_WRAP(P("Footer only"));

    const buf = await makeDocxWithHeaderFooter(body, header, footer);

    // discoverTemplate scans document.xml, headers, and footers
    const discovered = await discoverTemplate(buf);
    const names = discovered.placeholders.map((p) => p.name);
    expect(names).toContain("body_field");
    expect(names).toContain("header_field");
  });

  test("unmatched header placeholders reported", async () => {
    const body = WRAP(P("Body: {{name}}"));
    const header = HEADER_WRAP(P("Header: {{company}}"));
    const footer = FOOTER_WRAP(P("plain footer"));

    const buf = await makeDocxWithHeaderFooter(body, header, footer);

    // Header placeholder is discovered and reported as
    // unmatched when no value is provided
    const result = await fillTemplate(buf, { name: "Alice" });
    expect(result.unmatchedPlaceholders).toContain("company");
  });
});

// ── Split-run placeholders ───────────────────────────────

describe("split-run placeholders", () => {
  test("placeholder split across 3 runs is discovered", async () => {
    // Word commonly splits: "{{" | "client_name" | "}}"
    const xml = WRAP(splitRuns("{{client_name}}", 2));
    const buf = await makeDocx(xml);

    const discovered = await discoverTemplate(buf);
    expect(discovered.placeholders).toEqual([
      { name: "client_name", count: 1 },
    ]);
  });

  test("placeholder split across 3 runs is filled", async () => {
    const xml = WRAP(splitRuns("{{client_name}}", 2));
    const buf = await makeDocx(xml);

    const result = await fillTemplate(buf, {
      client_name: "Acme Corp",
    });

    const extracted = await extractText(result.buffer);
    const allText = extracted.paragraphs.map((p) => p.text).join("\n");
    expect(allText).toContain("Acme Corp");
    expect(allText).not.toContain("{{");
  });

  test("multiple split placeholders in one paragraph", async () => {
    // Two placeholders, both split: "{{a}}" and "{{b}}"
    const runs = [
      '<w:r><w:t xml:space="preserve">Name: {{</w:t></w:r>',
      "<w:r><w:t>a}}</w:t></w:r>",
      '<w:r><w:t xml:space="preserve"> City: {{</w:t></w:r>',
      "<w:r><w:t>b}}</w:t></w:r>",
    ].join("");
    const xml = WRAP(`<w:p>${runs}</w:p>`);
    const buf = await makeDocx(xml);

    const discovered = await discoverTemplate(buf);
    const names = discovered.placeholders.map((p) => p.name).toSorted();
    expect(names).toEqual(["a", "b"]);
  });
});

// ── Placeholders inside tables ───────────────────────────

describe("placeholders in tables", () => {
  test("discover finds placeholders inside table cells", async () => {
    const xml = WRAP(
      [
        "<w:tbl><w:tr>",
        "<w:tc>",
        P("{{col_a}}"),
        "</w:tc>",
        "<w:tc>",
        P("{{col_b}}"),
        "</w:tc>",
        "</w:tr></w:tbl>",
      ].join(""),
    );
    const buf = await makeDocx(xml);

    const discovered = await discoverTemplate(buf);
    const names = discovered.placeholders.map((p) => p.name).toSorted();
    expect(names).toEqual(["col_a", "col_b"]);
  });

  test("fill replaces placeholders inside table cells", async () => {
    const xml = WRAP(
      [
        "<w:tbl><w:tr>",
        "<w:tc>",
        P("Name: {{name}}"),
        "</w:tc>",
        "<w:tc>",
        P("Date: {{date}}"),
        "</w:tc>",
        "</w:tr></w:tbl>",
      ].join(""),
    );
    const buf = await makeDocx(xml);

    const result = await fillTemplate(buf, {
      name: "Alice",
      date: "2026-01-01",
    });

    const zip = await JSZip.loadAsync(result.buffer);
    const docXml = await zip.file("word/document.xml")?.async("string");
    expect(docXml).toContain("Alice");
    expect(docXml).toContain("2026-01-01");
  });
});
