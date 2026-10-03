import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  CLAIM_CONTEXT_MAX,
  claimPassage,
} from "@/api/lib/lists/verification/claim-context";

const anchoredBlock = fc
  .constantFrom("x", "😀", "עברית", "العربية", "e\u0301")
  .chain((glyph) =>
    fc
      .record({
        prefixLength: fc.integer({ min: 0, max: 3000 }),
        suffixLength: fc.integer({ min: 0, max: 3000 }),
        repetitions: fc.integer({
          min: 0,
          max: Math.floor((CLAIM_CONTEXT_MAX - 2) / glyph.length),
        }),
      })
      .map(({ prefixLength, suffixLength, repetitions }) => {
        const claim = `⟦${glyph.repeat(repetitions)}⟧`;
        return {
          text: `${"L".repeat(prefixLength)}${claim}${"R".repeat(suffixLength)}`,
          claim,
          anchor: { start: prefixLength, end: prefixLength + claim.length },
        };
      }),
  );

describe("claim passage context", () => {
  test("short block passages stay byte-identical for every anchored span", () => {
    assertProperty(
      "short block passages stay byte-identical for every anchored span",
      fc.property(
        fc.array(
          fc.constantFrom(
            "😀",
            "עברית",
            "العربية",
            "e\u0301",
            "\r\n",
            "\u00a0",
          ),
          { minLength: 1, maxLength: 150 },
        ),
        fc.nat(),
        fc.nat(),
        (parts, offset, length) => {
          const text = parts.join("");
          expect(text.length).toBeLessThanOrEqual(CLAIM_CONTEXT_MAX);
          const start = offset % text.length;
          const end = Math.min(text.length, start + 1 + (length % text.length));
          expect(claimPassage(text, { start, end })).toBe(text);
          expect(claimPassage(text, { start, end })).toBe(
            text.slice(0, CLAIM_CONTEXT_MAX),
          );
        },
      ),
    );
  });

  test("bounded passages contain their anchored claims and preserve short blocks", () => {
    assertProperty(
      "bounded passages contain their anchored claims and preserve short blocks",
      fc.property(anchoredBlock, ({ text, claim, anchor }) => {
        expect(text.slice(anchor.start, anchor.end)).toBe(claim);
        const passage = claimPassage(text, anchor);
        expect(passage.length).toBeLessThanOrEqual(CLAIM_CONTEXT_MAX);
        expect(passage.length).toBe(Math.min(text.length, CLAIM_CONTEXT_MAX));
        expect(passage).toContain(claim);
        expect(text).toContain(passage);
        if (text.length <= CLAIM_CONTEXT_MAX) {
          expect(passage).toBe(text);
          expect(passage).toBe(text.slice(0, CLAIM_CONTEXT_MAX));
        }
        if (
          anchor.start >= CLAIM_CONTEXT_MAX &&
          text.length - anchor.end >= CLAIM_CONTEXT_MAX
        ) {
          const before = passage.indexOf(claim);
          const after = passage.length - before - claim.length;
          expect(Math.abs(before - after)).toBeLessThanOrEqual(1);
        }
      }),
    );
  });

  test("a block at the cap retains every character", () => {
    const text = `😀${"a".repeat(CLAIM_CONTEXT_MAX - 2)}`;
    expect(text.length).toBe(CLAIM_CONTEXT_MAX);
    expect(
      claimPassage(text, { start: text.length - 1, end: text.length }),
    ).toBe(text);
  });

  test("a capped claim keeps its whole span in a longer block", () => {
    const claim = "c".repeat(CLAIM_CONTEXT_MAX);
    expect(
      claimPassage(`before${claim}after`, { start: 6, end: 6 + claim.length }),
    ).toBe(claim);
  });

  test("passages at either edge clamp to the block bounds", () => {
    const text = `A${".".repeat(CLAIM_CONTEXT_MAX - 1)}Z`;
    expect(claimPassage(text, { start: 0, end: 1 })).toBe(
      text.slice(0, CLAIM_CONTEXT_MAX),
    );
    expect(
      claimPassage(text, { start: text.length - 1, end: text.length }),
    ).toBe(text.slice(-CLAIM_CONTEXT_MAX));
  });

  test("a claim longer than the passage cap keeps centred context", () => {
    const claim = `${"a".repeat(990)}${"m".repeat(20)}${"b".repeat(990)}`;
    const text = `${"L".repeat(3000)}${claim}${"R".repeat(3000)}`;
    expect(claimPassage(text, { start: 3000, end: 3000 + claim.length })).toBe(
      `${"a".repeat(740)}${"m".repeat(20)}${"b".repeat(740)}`,
    );
  });
});
