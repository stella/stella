import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { opinionRow } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/test-records";
import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";

import { composeCourtListenerText } from "./compose";
import { COURTLISTENER_HTML_PARSERS } from "./html";
import { createTextBudget } from "./outcome";
import { selectOpinionText } from "./select";
import { publishedTextDefects } from "./source-defects";
import { courtListenerValidationPolicy } from "./validation-policy";

const select = (html: string) =>
  selectOpinionText({
    row: opinionRow({ xml_harvard: "", html }),
    type: "020lead",
    budget: createTextBudget(),
  });

test("publisher escaped entities and literal tags remain readable and typed", () => {
  const result = select(
    "<p>The company A &amp;amp; B filed.</p><p>The email uses &amp;commat;.</p><p>The expression is &lt;n&gt;.</p>",
  );
  expect(result.status).toBe("parsed");
  if (result.status !== "parsed") {
    return;
  }
  expect(
    result.text.units.flatMap(({ blocks }) =>
      blocks.map(({ plainText }) => plainText),
    ),
  ).toEqual([
    "The company A &amp; B filed.",
    "The email uses &commat;.",
    "The expression is <n>.",
  ]);
  expect(result.sourceDefects.map(({ type }) => type)).toEqual([
    "entity-reference",
    "entity-reference",
    "literal-tag",
  ]);
  expect(
    result.attempts.some(({ reason }) => reason === "markup-residue"),
  ).toBe(false);
});

test("published text defects survive composition without rewriting wording", () => {
  const result = composeCourtListenerText([
    {
      row: opinionRow({
        xml_harvard: "",
        html: "<p>The term &amp;and; is as published.</p>",
      }),
      type: "020lead",
    },
  ]);
  expect(result.status).toBe("parsed");
  if (result.status !== "parsed") {
    return;
  }
  expect(result.blocks.at(0)?.plainText).toBe(
    "The term &and; is as published.",
  );
  expect(result.opinions.at(0)?.sourceDefects).toEqual([
    { type: "entity-reference", anchorId: "o9109419-p1" },
  ]);
});

test("actual RTF control residue is still refused", () => {
  const result = select("<p>Actual \\pard\\plain leaked.</p>");
  expect(result.status).toBe("no-usable-text");
  expect(
    result.attempts.some(({ reason }) => reason === "markup-residue"),
  ).toBe(true);
});

test.each([
  String.raw`Text \loch\hich continues.`,
  String.raw`Judgment. \pard Continued text.`,
  String.raw`Judgment. \fs24 Continued text.`,
])(
  "RTF controls in the sole candidate are refused as residue: %s",
  (wording) => {
    const result = selectOpinionText({
      row: opinionRow({
        xml_harvard: "",
        html_with_citations: `<p>${wording}</p>`,
      }),
      type: "020lead",
      budget: createTextBudget(),
    });
    expect(result.status).toBe("no-usable-text");
    expect(result.attempts).toContainEqual({
      format: "html_with_citations",
      structure: "html",
      reason: "markup-residue",
    });
  },
);

test("ordinary backslash prose in the sole candidate remains usable", () => {
  const wording = String.raw`The exhibit is at C:\file\temp; the literal "\n" is quoted.`;
  const result = selectOpinionText({
    row: opinionRow({
      xml_harvard: "",
      html_with_citations: `<p>${wording}</p>`,
    }),
    type: "020lead",
    budget: createTextBudget(),
  });
  expect(result.status).toBe("parsed");
  if (result.status !== "parsed") {
    return;
  }
  expect(
    result.text.units.flatMap(({ blocks }) =>
      blocks.map(({ plainText }) => plainText),
    ),
  ).toEqual([wording]);
  expect(result.sourceDefects).toEqual([]);
});

test("courtlistener-source-attribution-rejects-injected-plain-text", () => {
  assertProperty(
    "courtlistener-source-attribution-rejects-injected-plain-text",
    fc.property(fc.constantFrom("<n>", "&amp;", "B".repeat(48)), (injected) => {
      const result = COURTLISTENER_HTML_PARSERS.html({
        text: "<p>The invented judgment remains readable.</p>",
        prefix: "invented",
        rowType: "020lead",
        budget: createTextBudget(),
      });
      expect(result.status).toBe("parsed");
      if (result.status !== "parsed") {
        return;
      }
      const text = {
        ...result.text,
        units: result.text.units.map((unit) => ({
          ...unit,
          blocks: unit.blocks.map((block) => ({
            ...block,
            plainText: `${block.plainText} ${injected}`,
          })),
        })),
      };
      const validation = validateAst(
        text.validationHtml,
        text.units.flatMap(({ blocks }) => [...blocks]),
        { sourcePolicy: courtListenerValidationPolicy },
      );
      expect(validation.stats.markupResidue.length).toBeGreaterThan(0);
      expect(publishedTextDefects(text, validation)).toBeNull();
    }),
    { numRuns: 10 },
  );
});

test("frontmatter entity literals are preserved with typed anchors", () => {
  const result = composeCourtListenerText(
    [
      {
        row: opinionRow({
          xml_harvard: "",
          html: "<p>The invented judgment is affirmed.</p>",
        }),
        type: "020lead",
      },
    ],
    { syllabus: "The label is &quot;LABEL&quot; as published." },
  );
  expect(result.status).toBe("parsed");
  if (result.status !== "parsed") {
    return;
  }
  expect(result.textFields.syllabus).toBe(
    "The label is &quot;LABEL&quot; as published.",
  );
  expect(result.sourceDefects).toEqual([
    { type: "entity-reference", anchorId: "cl-syllabus-p1" },
  ]);
});

test("courtlistener-published-malformed-identifiers-remain-typed", () => {
  assertProperty(
    "courtlistener-published-malformed-identifiers-remain-typed",
    fc.property(fc.stringMatching(/^[a-f0-9]{40}$/u), (identifier) => {
      const wording = `Wallet Owner x${identifier} is as published.`;
      const result = select(`<p>${wording}</p>`);
      expect(result.status).toBe("parsed");
      if (result.status !== "parsed") {
        return;
      }
      expect(
        result.text.units.flatMap(({ blocks }) =>
          blocks.map(({ plainText }) => plainText),
        ),
      ).toEqual([wording]);
      expect(result.sourceDefects.at(0)?.type).toBe("malformed-identifier");
      expect(select(`<p>Unlabelled x${identifier} payload.</p>`).status).toBe(
        "no-usable-text",
      );
      expect(select(`<p>${wording} ${"abcdef12".repeat(5)}</p>`).status).toBe(
        "no-usable-text",
      );
    }),
    { numRuns: 20 },
  );
});

test("courtlistener-published-repeated-glyphs-remain-typed", () => {
  assertProperty(
    "courtlistener-published-repeated-glyphs-remain-typed",
    fc.property(
      fc.constantFrom("B", "4"),
      fc.integer({ min: 48, max: 300 }),
      (glyph, length) => {
        const wording = `Published OCR ${glyph.repeat(length)} continues.`;
        const result = select(`<p>${wording}</p>`);
        expect(result.status).toBe("parsed");
        if (result.status !== "parsed") {
          return;
        }
        expect(
          result.text.units
            .flatMap(({ blocks }) => blocks.map(({ plainText }) => plainText))
            .join(" "),
        ).toBe(wording);
        expect(result.sourceDefects.at(0)?.type).toBe("repeated-glyph");
        const binary = select(
          `<p>Payload ${glyph.repeat(length)}abcdef01 remains.</p>`,
        );
        expect(binary.status).toBe("no-usable-text");
      },
    ),
    { numRuns: 30 },
  );
});

test("courtlistener-published-entities-decode-once", () => {
  assertProperty(
    "courtlistener-published-entities-decode-once",
    fc.property(
      fc.constantFrom(
        "amp",
        "commat",
        "and",
        "CounterClockwiseContourIntegral",
        "NotEqualTilde",
      ),
      fc.integer({ min: 1, max: 8 }),
      (name, count) => {
        const literal = `&${name};`;
        const wording = Array.from(
          { length: count },
          () => `The published token ${literal} stays.`,
        ).join(" ");
        const result = select(`<p>${Bun.escapeHTML(wording)}</p>`);
        expect(result.status).toBe("parsed");
        if (result.status !== "parsed") {
          return;
        }
        expect(
          result.text.units
            .flatMap(({ blocks }) => blocks.map(({ plainText }) => plainText))
            .join(" "),
        ).toBe(wording);
        expect(result.sourceDefects.at(0)?.type).toBe("entity-reference");
      },
    ),
  );
});

test("courtlistener-large-html-retains-only-visible-text", () => {
  assertProperty(
    "courtlistener-large-html-retains-only-visible-text",
    fc.property(fc.integer({ min: 400, max: 800 }), (count) => {
      const wording = "The invented court preserves every word. "
        .repeat(count)
        .trim();
      const result = COURTLISTENER_HTML_PARSERS.html({
        text: `<div><p><strong>${wording}</strong></p></div>`,
        prefix: "invented",
        rowType: "020lead",
        budget: createTextBudget(),
      });
      expect(result.status).toBe("parsed");
      if (result.status !== "parsed") {
        return;
      }
      const plain = result.text.units
        .flatMap(({ blocks }) => blocks.map(({ plainText }) => plainText))
        .join(" ");
      expect(plain.length).toBeGreaterThan(5000);
      expect(plain).toBe(wording);
    }),
    { numRuns: 20 },
  );
});
