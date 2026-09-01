import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  analysisInputFingerprint,
  formatDecisionForPrompt,
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

const fingerprintOf = (input: PromptBlock[]) =>
  analysisInputFingerprint(formatDecisionForPrompt(input));

describe("analysisInputFingerprint", () => {
  test("is a function of the prompt text alone", () => {
    fc.assert(
      fc.property(blocks, (input) => {
        expect(fingerprintOf(input)).toBe(
          fingerprintOf(structuredClone(input)),
        );
        expect(fingerprintOf(input)).toMatch(/^[0-9a-f]{64}$/u);
      }),
      propertyConfig(),
    );
  });

  test("changes when a re-parse renumbers the anchors and leaves the words alone", () => {
    fc.assert(
      fc.property(blocks, (input) => {
        const renumbered = input.map((b, index) => ({
          ...b,
          anchorId: `${b.anchorId}-r${index}`,
        }));
        expect(fingerprintOf(renumbered)).not.toBe(fingerprintOf(input));
      }),
      propertyConfig(),
    );
  });

  test("changes when the text changes", () => {
    fc.assert(
      fc.property(blocks, fc.string({ minLength: 1 }), (input, extra) => {
        const [first, ...rest] = input;
        if (first === undefined) {
          return;
        }
        const edited = [
          { ...first, plainText: `${first.plainText}${extra}` },
          ...rest,
        ];
        expect(fingerprintOf(edited)).not.toBe(fingerprintOf(input));
      }),
      propertyConfig(),
    );
  });

  test("ignores blocks the prompt omits: whitespace-only text", () => {
    const input = [
      { anchorId: "p-1", plainText: "Soud rozhodl.", type: "paragraph" },
    ];
    const padded = [
      ...input,
      { anchorId: "p-2", plainText: "   \n", type: "paragraph" },
    ];
    expect(fingerprintOf(padded)).toBe(fingerprintOf(input));
  });
});
