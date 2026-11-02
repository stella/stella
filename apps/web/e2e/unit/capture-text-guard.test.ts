import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "../../src/test-dom-environment";
import {
  collectCaptureText,
  findCaptureTextViolations,
} from "../marketing/capture-text-guard";

describe("marketing capture text collection", () => {
  beforeAll(() => {
    GlobalRegistrator.register({ url: "https://app.example.test" });
  });
  afterAll(async () => {
    await unregisterDomEnvironment();
  });

  // happy-dom has no layout, so these pages skip the layout test.
  const markersOn = (html: string) => {
    // safe-html: the fixed string literals of the tests below; no external input.
    document.body.innerHTML = html;
    return findCaptureTextViolations(
      collectCaptureText({ checkLayout: false }),
    ).map(({ element, marker }) => ({ element, marker }));
  };

  test("reads a decision row's text with its landmark", () => {
    expect(
      markersOn('<main><p role="row">DEMO 31 ÚS 903/2026</p></main>'),
    ).toEqual([
      { element: 'p[role="row"]', marker: "DEMO" },
      { element: 'p[role="row"]', marker: "synthetic case number" },
    ]);
  });

  test("reads text that inline markup splits as one line", () => {
    expect(
      markersOn("<p>Visit example<strong>.com</strong> today</p>"),
    ).toEqual([{ element: "p", marker: "example.com" }]);
  });

  test("reports a marker inside inline markup once", () => {
    expect(
      markersOn("<main><p>Draft <strong><em>TODO</em></strong></p></main>"),
    ).toEqual([{ element: "main", marker: "TODO" }]);
  });

  test("does not join text across separate blocks", () => {
    expect(markersOn("<div>DE<div>MO</div></div>")).toEqual([]);
  });

  test("reads the value a form field shows", () => {
    expect(
      markersOn(
        '<form aria-label="Contact"><input value="example.com"></form>',
      ),
    ).toEqual([
      { element: 'form[aria-label="Contact"]', marker: "example.com" },
    ]);
  });

  test("reads the placeholder an empty field shows", () => {
    expect(
      markersOn(
        '<main><input placeholder="Lorem ipsum"><textarea placeholder="TODO"></textarea></main>',
      ),
    ).toEqual([
      { element: "main", marker: "Lorem" },
      { element: "main", marker: "ipsum" },
      { element: "main", marker: "TODO" },
    ]);
  });

  test("does not read what a field hides", () => {
    expect(
      markersOn(
        '<main><input type="password" value="TEST"><input type="hidden" value="TODO"></main>',
      ),
    ).toEqual([]);
  });

  test("accepts a real search field and real decisions", () => {
    expect(
      markersOn(
        '<main><input placeholder="Case number, ECLI or words, e.g. 22 Cdo 2653/2012"><p>10 As 124/2025</p><p>Nejvyšší správní soud</p></main>',
      ),
    ).toEqual([]);
  });
});

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
