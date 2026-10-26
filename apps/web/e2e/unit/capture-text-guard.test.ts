import { describe, expect, test } from "bun:test";

import { findCaptureTextViolations } from "../marketing/capture-text-guard";

const scan = (text: string) =>
  findCaptureTextViolations([{ descriptor: "main > article", text }]);

describe("marketing capture text guard", () => {
  test("rejects a synthetic decision and names its element and text", () => {
    expect(scan("DEMO 31 ÚS 903/2026")).toEqual([
      { element: "main > article", marker: "DEMO", matchedText: "DEMO" },
      {
        element: "main > article",
        marker: "synthetic case number",
        matchedText: "DEMO 31 ÚS 903/2026",
      },
    ]);
  });

  test.each([
    "Ústavní soud odmítl ústavní stížnost jako zjevně neopodstatněnou.",
    "Zůstavitel pořídil testament před dvěma svědky.",
    "Barcelona",
    "Advokátní komora",
    "Bar association",
    "demonstrace",
  ])("accepts real copy: %s", (text) => {
    expect(scan(text)).toEqual([]);
  });

  test.each([
    "DEMO",
    "TEST",
    "Lorem",
    "ipsum",
    "placeholder",
    "example.com",
    "foo",
    "bar",
    "TODO",
    "synthetic",
  ])("rejects the whole-word marker: %s", (marker) => {
    expect(scan(`Visible ${marker} copy`).map((hit) => hit.marker)).toContain(
      marker,
    );
  });

  test("reports every hit across elements, each with its own element", () => {
    expect(
      findCaptureTextViolations([
        { descriptor: "nav", text: "Case Law" },
        { descriptor: "main > li:nth-of-type(1)", text: "TODO" },
        { descriptor: "main > li:nth-of-type(2)", text: "Lorem" },
      ]).map(({ element }) => element),
    ).toEqual(["main > li:nth-of-type(1)", "main > li:nth-of-type(2)"]);
  });

  test("accepts representative visible text from every capture scene", () => {
    const sceneSamples = {
      workspace: "Meridian supply agreement Internal_SAFE_Agreement.docx",
      "tabular-review": "Export Review - Project Atlas Data Room",
      "story-public-data-1": "Case Law Súdny dvor Európskej únie",
      "story-public-data-2": "Case Law Ústavní soud",
      "story-public-data-3": "Case Law Nejvyšší soud",
      editor: "Supplier_Agreement.docx Document content",
      agent: "Change of control Review the cited provisions",
      templates: "Templates Supply Agreement",
      anonymization: "Redacted_Due_Diligence_Extract.docx",
      contacts: "Bratislava Legal Group, s.r.o.",
      "time-tracking": "Timesheets Total",
      invoicing: "INV-2025-0003 Linked time entries",
      "import-export": "Export table Export XLSX",
      "case-law-search": "Case Law Newest decisions",
    } as const;

    for (const [scene, text] of Object.entries(sceneSamples)) {
      expect(
        findCaptureTextViolations([
          { descriptor: `main[data-scene="${scene}"]`, text },
        ]),
      ).toEqual([]);
    }
  });
});
