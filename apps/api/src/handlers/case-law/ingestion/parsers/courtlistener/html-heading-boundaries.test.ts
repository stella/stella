import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { opinionRow } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/test-records";

import { createTextBudget } from "./outcome";
import { selectOpinionText } from "./select";
import { parsedWords, sourceWords } from "./test-oracle";

// Adjacent heading excerpts pin the independent source walk's word boundaries.
// Sidecars locate each unchanged excerpt in both original HTML fields.
const cases = [
  {
    file: "heading-4696496-discussion-ii",
    opinionId: "4609686",
    headings: ["II. DISCUSSION", "A. RESPONDENT'S ADJUSTMENTS"],
    pageLabel:
      '<span class="star-pagination" number="6" pagescheme="2000 U.S. Tax Ct. LEXIS 40">*45 </span>',
  },
  {
    file: "heading-4696496-discussion-iii",
    opinionId: "4609686",
    headings: ["III. DISCUSSION", "A. INTRODUCTION"],
    pageLabel: null,
  },
  {
    file: "heading-4699792-signature",
    opinionId: "4605100",
    headings: ["W. G. Marbury", "President and Manager"],
    pageLabel: null,
  },
  {
    file: "heading-4699792-members",
    opinionId: "4605100",
    headings: ["VI. Rights Of Members:", "A. On Termination Of the Plan"],
    pageLabel: null,
  },
] as const;

for (const fixture of cases) {
  for (const format of ["html_with_citations", "html_anon_2020"] as const) {
    test(`${format} preserves the real ${fixture.file} heading boundaries on both text walks`, () => {
      const html = readFileSync(
        new URL(`./__fixtures__/html/${fixture.file}.html`, import.meta.url),
        "utf8",
      );
      const parsed = selectOpinionText({
        row: opinionRow({
          id: fixture.opinionId,
          xml_harvard: "",
          [format]: html,
        }),
        type: "020lead",
        budget: createTextBudget(),
      });
      expect(parsed.status).toBe("parsed");
      if (parsed.status !== "parsed")
        throw new TypeError(`Unexpected ${parsed.status}`);
      const blocks = parsed.text.units.flatMap((unit) => unit.blocks);
      expect(
        blocks.map(({ type, plainText }) => ({ type, plainText })),
      ).toEqual(
        fixture.headings.map((plainText) => ({ type: "heading", plainText })),
      );
      const expectedWords = fixture.headings.flatMap((text) => text.split(" "));
      expect(parsedWords(blocks)).toEqual(expectedWords);
      const excludedSpans = [];
      if (fixture.pageLabel !== null) {
        const start = html.indexOf(fixture.pageLabel);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(html.indexOf(fixture.pageLabel, start + 1)).toBe(-1);
        excludedSpans.push({ start, end: start + fixture.pageLabel.length });
      }
      expect(sourceWords("html", html, { excludedSpans })).toEqual(
        expectedWords,
      );
    });
  }
}

test("heading boundaries separate words while inline emphasis preserves split words", () => {
  for (const tag of ["em", "b", "span", "emphasis", "content"]) {
    const html = `<h>DIS<${tag}>CUSSION</${tag}></h><h><${tag}>A.</${tag}> INTRODUCTION</h>`;
    expect(sourceWords("html", html)).toEqual([
      "DISCUSSION",
      "A.",
      "INTRODUCTION",
    ]);
  }
});
