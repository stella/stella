import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  ANALYSIS_GUIDELINES,
  analysisInputOf,
  type AnalysisPromptDecision,
  formatDecisionForPrompt,
  type PromptBlock,
} from "./analysis-prompt";

const block = fc.record({
  anchorId: fc.stringMatching(/^[a-z][a-z0-9-]{0,11}$/u),
  plainText: fc
    .string({ minLength: 1, maxLength: 40 })
    .filter((text) => text.trim().length > 0),
  type: fc.constant("paragraph"),
});

const blocks = fc.array(block, { minLength: 1, maxLength: 8 });

const decision = fc.record({
  court: fc.string({ minLength: 1, maxLength: 30 }),
  country: fc.constantFrom("CZE", "SVK", "POL", "AUT"),
  decisionType: fc.option(fc.string({ minLength: 1, maxLength: 12 }), {
    nil: null,
  }),
  language: fc.constantFrom("cs", "sk", "pl", "de", "en"),
});

const systemPrompt = fc.string({ minLength: 1, maxLength: 60 });

const fingerprintOf = (
  input: PromptBlock[],
  meta: AnalysisPromptDecision,
  system = "system prompt",
) =>
  analysisInputOf({ blocks: input, decision: meta, systemPrompt: system })
    .fingerprint;

describe("analysisInputOf", () => {
  test("the fingerprint is a function of the model input alone", () => {
    assertProperty(
      "the fingerprint is a function of the model input alone",
      fc.property(blocks, decision, systemPrompt, (input, meta, system) => {
        expect(fingerprintOf(input, meta, system)).toBe(
          fingerprintOf(structuredClone(input), structuredClone(meta), system),
        );
        expect(fingerprintOf(input, meta, system)).toMatch(/^[0-9a-f]{64}$/u);
      }),
      {},
    );
  });

  test("changes when a re-parse renumbers the anchors and leaves the words alone", () => {
    assertProperty(
      "changes when a re-parse renumbers the anchors and leaves the words alone",
      fc.property(blocks, decision, (input, meta) => {
        const renumbered = input.map((b, index) => ({
          ...b,
          anchorId: `${b.anchorId}-r${index}`,
        }));
        expect(fingerprintOf(renumbered, meta)).not.toBe(
          fingerprintOf(input, meta),
        );
      }),
      {},
    );
  });

  test("changes when the text changes", () => {
    assertProperty(
      "changes when the text changes",
      fc.property(
        blocks,
        decision,
        fc.string({ minLength: 1 }),
        (input, meta, extra) => {
          const [first, ...rest] = input;
          if (first === undefined) {
            return;
          }
          const edited = [
            { ...first, plainText: `${first.plainText}${extra}` },
            ...rest,
          ];
          expect(fingerprintOf(edited, meta)).not.toBe(
            fingerprintOf(input, meta),
          );
        },
      ),
      {},
    );
  });

  test("changes when the court or type the header is built from changes", () => {
    assertProperty(
      "changes when the court or type the header is built from changes",
      fc.property(blocks, decision, (input, meta) => {
        const base = fingerprintOf(input, meta);
        expect(
          fingerprintOf(input, { ...meta, court: `${meta.court} II` }),
        ).not.toBe(base);
        expect(
          fingerprintOf(input, {
            ...meta,
            decisionType: `${meta.decisionType ?? ""}-other`,
          }),
        ).not.toBe(base);
      }),
      {},
    );
  });

  test("changes when the system prompt changes", () => {
    assertProperty(
      "changes when the system prompt changes",
      fc.property(blocks, decision, systemPrompt, (input, meta, system) => {
        expect(fingerprintOf(input, meta, system)).not.toBe(
          fingerprintOf(input, meta, `${system} (revised)`),
        );
      }),
      {},
    );
  });

  test("carries the resolved system prompt and the user message it digested", () => {
    const input = analysisInputOf({
      blocks: [
        { anchorId: "p-1", plainText: "Soud rozhodl.", type: "paragraph" },
      ],
      decision: {
        court: "Nejvyšší soud",
        country: "CZE",
        decisionType: null,
        language: "cs",
      },
      systemPrompt: "Analyse the decision.",
    });
    expect(input.systemPrompt).toBe("Analyse the decision.");
    expect(input.language).toBe("cs");
    expect(input.userMessage).toBe(
      "Court: Nejvyšší soud\nCountry: CZE\nType: unknown\n\n[p-1] Soud rozhodl.",
    );
  });

  test("ignores blocks the prompt omits: whitespace-only text", () => {
    const meta = {
      court: "Court",
      country: "CZE",
      decisionType: null,
      language: "cs",
    };
    const input = [
      { anchorId: "p-1", plainText: "Soud rozhodl.", type: "paragraph" },
    ];
    const padded = [
      ...input,
      { anchorId: "p-2", plainText: "   \n", type: "paragraph" },
    ];
    expect(fingerprintOf(padded, meta)).toBe(fingerprintOf(input, meta));
  });

  test("changes when a paragraph gains or changes its court number", () => {
    assertProperty(
      "changes when a paragraph gains or changes its court number",
      fc.property(
        blocks,
        decision,
        fc.integer({ min: 1, max: 999 }),
        (input, meta, number) => {
          const [first, ...rest] = input;
          if (first === undefined) {
            return;
          }
          const numbered = [{ ...first, number }, ...rest];
          const renumbered = [{ ...first, number: number + 1 }, ...rest];
          expect(fingerprintOf(numbered, meta)).not.toBe(
            fingerprintOf(input, meta),
          );
          expect(fingerprintOf(renumbered, meta)).not.toBe(
            fingerprintOf(numbered, meta),
          );
        },
      ),
      {},
    );
  });
});

// An unnumbered decision shows the model only anchor counters, which count
// headings too; a citation built from one points at the wrong paragraph.
test("the guidelines forbid citing a paragraph the court did not number", () => {
  expect(ANALYSIS_GUIDELINES).toContain(
    'A\n   paragraph without "(¶ N)" has no court number',
  );
  expect(ANALYSIS_GUIDELINES).toContain(
    "never turn an anchorId into a\n   paragraph number",
  );
});

describe("formatDecisionForPrompt", () => {
  test("shows the court's paragraph number after the anchor", () => {
    expect(
      formatDecisionForPrompt([
        { anchorId: "h-1", plainText: "Odůvodnění:", type: "heading" },
        {
          anchorId: "p-2",
          plainText: "Soud rozhodl.",
          type: "paragraph",
          number: 12,
        },
        { anchorId: "p-3", plainText: "Poučení.", type: "paragraph" },
      ]),
    ).toBe("[h-1] Odůvodnění:\n\n[p-2] (¶ 12) Soud rozhodl.\n\n[p-3] Poučení.");
  });

  test("prints no number that is not a citable court paragraph number", () => {
    for (const number of [0, -3, 1.5, Number.NaN]) {
      expect(
        formatDecisionForPrompt([
          { anchorId: "p-1", plainText: "Text.", type: "paragraph", number },
        ]),
      ).toBe("[p-1] Text.");
    }
    expect(
      formatDecisionForPrompt([
        { anchorId: "h-1", plainText: "I.", type: "heading", number: 1 },
      ]),
    ).toBe("[h-1] I.");
  });
});
