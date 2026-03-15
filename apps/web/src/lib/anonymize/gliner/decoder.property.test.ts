import { describe, expect, it } from "bun:test";
import fc from "fast-check";

import { decodeSpans } from "@stella/anonymize";

// ── Property-based tests for decodeSpans ─────────────

describe("decodeSpans properties", () => {
  /**
   * Generate a random NER scenario: random text, word
   * boundaries, logits tensor, and parameters.
   */
  const nerScenario = () =>
    fc
      .record({
        numWords: fc.integer({ min: 1, max: 20 }),
        maxWidth: fc.integer({ min: 1, max: 6 }),
        numEntities: fc.integer({ min: 1, max: 4 }),
        threshold: fc.double({ min: 0.1, max: 0.9 }),
        flatNer: fc.boolean(),
        multiLabel: fc.boolean(),
      })
      .chain((params) => {
        const { numWords, maxWidth, numEntities } = params;
        const totalLogits = numWords * maxWidth * numEntities;

        return fc
          .record({
            // Random logits in [-5, 5] range
            logits: fc.array(fc.double({ min: -5, max: 5, noNaN: true }), {
              minLength: totalLogits,
              maxLength: totalLogits,
            }),
          })
          .map(({ logits }) => ({ ...params, logits }));
      });

  const buildWordBoundaries = (numWords: number) => {
    const words: string[] = [];
    const starts: number[] = [];
    const ends: number[] = [];
    let pos = 0;
    for (let i = 0; i < numWords; i++) {
      const word = `word${i}`;
      words.push(word);
      starts.push(pos);
      pos += word.length;
      ends.push(pos);
      pos += 1; // space
    }
    const text = words.join(" ");
    return { text, starts, ends };
  };

  it("all scores are >= threshold", () => {
    fc.assert(
      fc.property(nerScenario(), (scenario) => {
        const { numWords, maxWidth, numEntities, threshold } = scenario;
        const { text, starts, ends } = buildWordBoundaries(numWords);
        const idToClass: Record<number, string> = {};
        for (let i = 1; i <= numEntities; i++) {
          idToClass[i] = `entity_${i}`;
        }

        const result = decodeSpans(
          1,
          numWords,
          maxWidth,
          numEntities,
          [text],
          [0],
          [starts],
          [ends],
          idToClass,
          scenario.logits,
          scenario.flatNer,
          threshold,
          scenario.multiLabel,
        );

        for (const span of result[0] ?? []) {
          expect(span[4]).toBeGreaterThanOrEqual(threshold);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("no overlapping spans in flat NER mode", () => {
    fc.assert(
      fc.property(nerScenario(), (scenario) => {
        const { numWords, maxWidth, numEntities, threshold } = scenario;
        const { text, starts, ends } = buildWordBoundaries(numWords);
        const idToClass: Record<number, string> = {};
        for (let i = 1; i <= numEntities; i++) {
          idToClass[i] = `entity_${i}`;
        }

        const result = decodeSpans(
          1,
          numWords,
          maxWidth,
          numEntities,
          [text],
          [0],
          [starts],
          [ends],
          idToClass,
          scenario.logits,
          true, // flatNer
          threshold,
          false, // no multiLabel
        );

        const spans = result[0] ?? [];
        for (let i = 0; i < spans.length; i++) {
          for (let j = i + 1; j < spans.length; j++) {
            const aStart = spans[i]?.[1] ?? 0;
            const aEnd = spans[i]?.[2] ?? 0;
            const bStart = spans[j]?.[1] ?? 0;
            const bEnd = spans[j]?.[2] ?? 0;
            // Spans must not overlap
            const overlaps = !(aStart >= bEnd || bStart >= aEnd);
            expect(overlaps).toBeFalsy();
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("output spans are always sorted by start position", () => {
    fc.assert(
      fc.property(nerScenario(), (scenario) => {
        const { numWords, maxWidth, numEntities, threshold } = scenario;
        const { text, starts, ends } = buildWordBoundaries(numWords);
        const idToClass: Record<number, string> = {};
        for (let i = 1; i <= numEntities; i++) {
          idToClass[i] = `entity_${i}`;
        }

        const result = decodeSpans(
          1,
          numWords,
          maxWidth,
          numEntities,
          [text],
          [0],
          [starts],
          [ends],
          idToClass,
          scenario.logits,
          scenario.flatNer,
          threshold,
          scenario.multiLabel,
        );

        const spans = result[0] ?? [];
        for (let i = 1; i < spans.length; i++) {
          expect(spans[i]?.[1]).toBeGreaterThanOrEqual(spans[i - 1]?.[1] ?? 0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("span text matches slice from original text", () => {
    fc.assert(
      fc.property(nerScenario(), (scenario) => {
        const { numWords, maxWidth, numEntities, threshold } = scenario;
        const { text, starts, ends } = buildWordBoundaries(numWords);
        const idToClass: Record<number, string> = {};
        for (let i = 1; i <= numEntities; i++) {
          idToClass[i] = `entity_${i}`;
        }

        const result = decodeSpans(
          1,
          numWords,
          maxWidth,
          numEntities,
          [text],
          [0],
          [starts],
          [ends],
          idToClass,
          scenario.logits,
          scenario.flatNer,
          threshold,
          scenario.multiLabel,
        );

        for (const span of result[0] ?? []) {
          const [spanText, start, end] = span;
          expect(spanText).toBe(text.slice(start, end));
        }
      }),
      { numRuns: 200 },
    );
  });

  it("entity labels come from idToClass mapping", () => {
    fc.assert(
      fc.property(nerScenario(), (scenario) => {
        const { numWords, maxWidth, numEntities, threshold } = scenario;
        const { text, starts, ends } = buildWordBoundaries(numWords);
        const idToClass: Record<number, string> = {};
        for (let i = 1; i <= numEntities; i++) {
          idToClass[i] = `entity_${i}`;
        }
        const validLabels = new Set(Object.values(idToClass));

        const result = decodeSpans(
          1,
          numWords,
          maxWidth,
          numEntities,
          [text],
          [0],
          [starts],
          [ends],
          idToClass,
          scenario.logits,
          scenario.flatNer,
          threshold,
          scenario.multiLabel,
        );

        for (const span of result[0] ?? []) {
          expect(validLabels.has(span[3])).toBeTruthy();
        }
      }),
      { numRuns: 200 },
    );
  });
});
