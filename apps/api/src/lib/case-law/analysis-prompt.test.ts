import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  analysisInputOf,
  type AnalysisPromptDecision,
} from "./analysis-prompt";

type PromptBlock = { anchorId: string; plainText: string; type: string };

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
    fc.assert(
      fc.property(blocks, decision, systemPrompt, (input, meta, system) => {
        expect(fingerprintOf(input, meta, system)).toBe(
          fingerprintOf(structuredClone(input), structuredClone(meta), system),
        );
        expect(fingerprintOf(input, meta, system)).toMatch(/^[0-9a-f]{64}$/u);
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

  test("changes when the court or type the header is built from changes", () => {
    fc.assert(
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
      propertyConfig(),
    );
  });

  test("changes when the system prompt changes", () => {
    fc.assert(
      fc.property(blocks, decision, systemPrompt, (input, meta, system) => {
        expect(fingerprintOf(input, meta, system)).not.toBe(
          fingerprintOf(input, meta, `${system} (revised)`),
        );
      }),
      propertyConfig(),
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
});
