import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  analysisInputOf,
  type AnalysisPromptDecision,
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

const fingerprintOf = (
  input: { anchorId: string; plainText: string; type: string }[],
  meta: AnalysisPromptDecision,
) => analysisInputOf(input, meta).fingerprint;

describe("analysisInputOf", () => {
  test("the fingerprint is a function of the model input alone", () => {
    fc.assert(
      fc.property(blocks, decision, (input, meta) => {
        expect(fingerprintOf(input, meta)).toBe(
          fingerprintOf(structuredClone(input), structuredClone(meta)),
        );
        expect(fingerprintOf(input, meta)).toMatch(/^[0-9a-f]{64}$/u);
      }),
      propertyConfig(),
    );
  });

  test("changes when a re-parse renumbers the anchors and leaves the words alone", () => {
    fc.assert(
      fc.property(blocks, decision, (input, meta) => {
        const renumbered = input.map((b, index) => ({
          ...b,
          anchorId: `${b.anchorId}-r${index}`,
        }));
        expect(fingerprintOf(renumbered, meta)).not.toBe(
          fingerprintOf(input, meta),
        );
      }),
      propertyConfig(),
    );
  });

  test("changes when the text changes", () => {
    fc.assert(
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
      propertyConfig(),
    );
  });

  test("changes when the language, court or type the prompt is built from changes", () => {
    fc.assert(
      fc.property(blocks, decision, (input, meta) => {
        const base = fingerprintOf(input, meta);
        expect(
          fingerprintOf(input, { ...meta, language: `${meta.language}-x` }),
        ).not.toBe(base);
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
      propertyConfig(),
    );
  });

  test("the user message carries the header and the anchored text", () => {
    const { userMessage } = analysisInputOf(
      [{ anchorId: "p-1", plainText: "Soud rozhodl.", type: "paragraph" }],
      {
        court: "Nejvyšší soud",
        country: "CZE",
        decisionType: null,
        language: "cs",
      },
    );
    expect(userMessage).toBe(
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
});
