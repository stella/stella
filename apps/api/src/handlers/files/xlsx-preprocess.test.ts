import { describe, expect, it } from "bun:test";
import JSZip from "jszip";

import { applyFitToPage, patchSheetXml } from "./xlsx-preprocess";

// biome-ignore lint/security/noSecrets: not a secret, just an XML attribute
const EXPECTED_FIT_TO_PAGE = 'fitToPage="1"';
const EXPECTED_FIT_TO_WIDTH = 'fitToWidth="1"';
const REGEX_WORKSHEET_WITH_SHEET_PR =
  /<worksheet[^>]*><sheetPr><pageSetUpPr fitToPage="1"\/><\/sheetPr>/;

// ── patchSheetXml ────────────────────────────────────────

describe("patchSheetXml", () => {
  it("inserts sheetPr and pageSetup when neither exists", () => {
    const xml = [
      '<?xml version="1.0"?>',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
      "  <sheetData/>",
      "</worksheet>",
    ].join("\n");

    const out = patchSheetXml(xml);

    expect(out).toContain(EXPECTED_FIT_TO_PAGE);
    expect(out).toContain(EXPECTED_FIT_TO_WIDTH);
    expect(out).toContain('fitToHeight="0"');
  });

  it("inserts sheetPr after worksheet open tag if no anchor elements exist", () => {
    const xml = [
      '<?xml version="1.0"?>',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
      "  <customElement/>",
      "</worksheet>",
    ].join("\n");

    const out = patchSheetXml(xml);
    expect(out).toContain(EXPECTED_FIT_TO_PAGE);
    expect(out).toMatch(REGEX_WORKSHEET_WITH_SHEET_PR);
  });

  it("updates existing pageSetup: removes scale, sets fitToWidth/Height", () => {
    const xml = [
      '<?xml version="1.0"?>',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
      "  <sheetData/>",
      '  <pageSetup scale="75" orientation="landscape"/>',
      "</worksheet>",
    ].join("\n");

    const out = patchSheetXml(xml);

    expect(out).not.toContain('scale="75"');
    expect(out).toContain(EXPECTED_FIT_TO_WIDTH);
    expect(out).toContain('fitToHeight="0"');
    // Existing attributes preserved
    expect(out).toContain('orientation="landscape"');
  });

  it("inserts pageSetUpPr into existing open sheetPr and does not duplicate", () => {
    const xml = [
      '<?xml version="1.0"?>',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
      '  <sheetPr><tabColor rgb="FF00B0F0"/></sheetPr>',
      "  <sheetData/>",
      "</worksheet>",
    ].join("\n");

    const out = patchSheetXml(xml);

    // Verify exactly one fitToPage was inserted
    expect(out.match(/fitToPage="1"/g)?.length).toBe(1);

    // Original sheetPr content preserved and structured correctly
    expect(out).toContain(
      '<sheetPr><tabColor rgb="FF00B0F0"/><pageSetUpPr fitToPage="1"/></sheetPr>',
    );
  });

  it("handles true self-closing sheetPr", () => {
    const xml = [
      '<?xml version="1.0"?>',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
      '  <sheetPr codeName="Sheet1"/>',
      "  <sheetData/>",
      "</worksheet>",
    ].join("\n");

    const out = patchSheetXml(xml);

    expect(out.match(/fitToPage="1"/g)?.length).toBe(1);
    expect(out).toContain(
      '<sheetPr codeName="Sheet1"><pageSetUpPr fitToPage="1"/></sheetPr>',
    );
  });

  it("updates existing pageSetUpPr fitToPage attribute", () => {
    const xml = [
      '<?xml version="1.0"?>',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
      '  <sheetPr><pageSetUpPr fitToPage="0"/></sheetPr>',
      "  <sheetData/>",
      '  <pageSetup fitToWidth="1" fitToHeight="0"/>',
      "</worksheet>",
    ].join("\n");

    const out = patchSheetXml(xml);

    // Should flip fitToPage to 1
    expect(out).toContain(EXPECTED_FIT_TO_PAGE);
    // Should not have duplicate fitToPage
    expect(out.match(/fitToPage/g)?.length).toBe(1);
  });

  it("is idempotent when settings are already correct", () => {
    const xml = [
      '<?xml version="1.0"?>',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
      '  <sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>',
      "  <sheetData/>",
      '  <pageSetup fitToWidth="1" fitToHeight="0"/>',
      "</worksheet>",
    ].join("\n");

    const out = patchSheetXml(xml);
    const out2 = patchSheetXml(out);

    expect(out2).toContain(EXPECTED_FIT_TO_PAGE);
    expect(out2).toContain(EXPECTED_FIT_TO_WIDTH);
    // No duplication
    expect(out2.match(/fitToPage/g)?.length).toBe(1);
    expect(out2.match(/fitToWidth/g)?.length).toBe(1);
  });
});

// ── applyFitToPage ───────────────────────────────────────

/** Build a minimal in-memory XLSX (OOXML ZIP) with 1 sheet. */
const makeXlsx = (sheetXml: string): Promise<ArrayBuffer> => {
  const zip = new JSZip();
  zip.file(
    "xl/workbook.xml",
    '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"></workbook>',
  );
  zip.file("xl/worksheets/sheet1.xml", sheetXml);
  return zip.generateAsync({ type: "arraybuffer" });
};

const sheetXmlWithNoPageSetup = [
  '<?xml version="1.0"?>',
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
  "  <sheetData/>",
  "</worksheet>",
].join("\n");

describe("applyFitToPage", () => {
  it("patches worksheets in a valid XLSX ZIP", async () => {
    const buf = await makeXlsx(sheetXmlWithNoPageSetup);
    const out = await applyFitToPage(buf);

    const zip = await JSZip.loadAsync(out);
    const entry = zip.file("xl/worksheets/sheet1.xml");
    if (!entry) {
      throw new Error("Missing sheet1.xml in ZIP");
    }
    const xml = await entry.async("string");
    expect(xml).toContain(EXPECTED_FIT_TO_PAGE);
    expect(xml).toContain(EXPECTED_FIT_TO_WIDTH);
  });

  it("returns the original buffer when input is not a ZIP", async () => {
    // Plain text: not a ZIP
    const encoder = new TextEncoder();
    const buf = encoder.encode("not a zip file").buffer;
    const out = await applyFitToPage(buf);
    expect(out).toBe(buf);
  });

  it("returns unchanged when ZIP has no xl/workbook.xml (e.g. a DOCX)", async () => {
    // Build a DOCX-like ZIP without xl/workbook.xml
    const zip = new JSZip();
    zip.file("word/document.xml", "<document/>");
    const buf = await zip.generateAsync({ type: "arraybuffer" });

    const out = await applyFitToPage(buf);

    // The xl/workbook.xml guard must fire and return the original buffer
    // reference unchanged — not a re-packed ZIP.
    expect(out).toBe(buf);
  });
});
