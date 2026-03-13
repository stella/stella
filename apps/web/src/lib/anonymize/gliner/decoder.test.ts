import { describe, expect, it } from "bun:test";

import { decodeSpans } from "./decoder";

/**
 * Build a flat logits array for the span-level model.
 *
 * Shape: [batch, inputLength, maxWidth, numEntities].
 * Values default to -10 (sigmoid ≈ 0), override specific
 * positions with high values to simulate detected entities.
 */
const buildLogits = (
  batchSize: number,
  inputLength: number,
  maxWidth: number,
  numEntities: number,
  overrides: {
    batch: number;
    startToken: number;
    widthOffset: number;
    entity: number;
    value: number;
  }[] = [],
): number[] => {
  const size = batchSize * inputLength * maxWidth * numEntities;
  const logits = Array.from<number>({ length: size }).fill(-10);

  for (const o of overrides) {
    const idx =
      o.batch * (inputLength * maxWidth * numEntities) +
      o.startToken * (maxWidth * numEntities) +
      o.widthOffset * numEntities +
      o.entity;
    logits[idx] = o.value;
  }

  return logits;
};

describe("decodeSpans()", () => {
  const text = "Jan Novák works at Stella";
  const wordsStarts = [0, 4, 10, 16, 19];
  const wordsEnds = [3, 9, 15, 18, 25];
  const idToClass: Record<number, string> = {
    1: "person",
    2: "organization",
  };

  it("returns empty spans when all logits are below threshold", () => {
    const logits = buildLogits(1, 5, 3, 2);
    const result = decodeSpans(
      1,
      5,
      3,
      2,
      [text],
      [0],
      [wordsStarts],
      [wordsEnds],
      idToClass,
      logits,
      true,
      0.5,
      false,
    );
    expect(result).toStrictEqual([[]]);
  });

  it("detects a single-word entity", () => {
    // "Jan" is at token 0, width 0 (span [0,0]), entity 0 (person)
    const logits = buildLogits(1, 5, 3, 2, [
      { batch: 0, startToken: 0, widthOffset: 0, entity: 0, value: 5 },
    ]);
    const result = decodeSpans(
      1,
      5,
      3,
      2,
      [text],
      [0],
      [wordsStarts],
      [wordsEnds],
      idToClass,
      logits,
      true,
      0.5,
      false,
    );
    expect(result[0]).toHaveLength(1);
    expect(result[0][0][0]).toBe("Jan");
    expect(result[0][0][1]).toBe(0);
    expect(result[0][0][2]).toBe(3);
    expect(result[0][0][3]).toBe("person");
    expect(result[0][0][4]).toBeGreaterThan(0.99);
  });

  it("detects a multi-word entity", () => {
    // "Jan Novák" spans tokens 0-1, width 1, entity 0 (person)
    const logits = buildLogits(1, 5, 3, 2, [
      { batch: 0, startToken: 0, widthOffset: 1, entity: 0, value: 4 },
    ]);
    const result = decodeSpans(
      1,
      5,
      3,
      2,
      [text],
      [0],
      [wordsStarts],
      [wordsEnds],
      idToClass,
      logits,
      true,
      0.5,
      false,
    );
    expect(result[0]).toHaveLength(1);
    expect(result[0][0][0]).toBe("Jan Novák");
    expect(result[0][0][3]).toBe("person");
  });

  it("keeps higher-scoring span in flat NER mode", () => {
    // Both "Jan" (score 3) and "Jan Novák" (score 5) detected
    const logits = buildLogits(1, 5, 3, 2, [
      { batch: 0, startToken: 0, widthOffset: 0, entity: 0, value: 3 },
      { batch: 0, startToken: 0, widthOffset: 1, entity: 0, value: 5 },
    ]);
    const result = decodeSpans(
      1,
      5,
      3,
      2,
      [text],
      [0],
      [wordsStarts],
      [wordsEnds],
      idToClass,
      logits,
      true,
      0.5,
      false,
    );
    // Greedy search keeps only the higher-scoring span
    expect(result[0]).toHaveLength(1);
    expect(result[0][0][0]).toBe("Jan Novák");
  });

  it("allows nested spans in non-flat mode", () => {
    // "Jan" (person, score 3) nested inside "Jan Novák" (person, score 5)
    const logits = buildLogits(1, 5, 3, 2, [
      { batch: 0, startToken: 0, widthOffset: 0, entity: 0, value: 3 },
      { batch: 0, startToken: 0, widthOffset: 1, entity: 0, value: 5 },
    ]);
    const result = decodeSpans(
      1,
      5,
      3,
      2,
      [text],
      [0],
      [wordsStarts],
      [wordsEnds],
      idToClass,
      logits,
      false,
      0.5,
      false,
    );
    // Non-flat allows nested spans
    expect(result[0]).toHaveLength(2);
  });

  it("detects multiple non-overlapping entities", () => {
    // "Jan" (person) and "Stella" (organization)
    const logits = buildLogits(1, 5, 3, 2, [
      { batch: 0, startToken: 0, widthOffset: 0, entity: 0, value: 5 },
      { batch: 0, startToken: 4, widthOffset: 0, entity: 1, value: 5 },
    ]);
    const result = decodeSpans(
      1,
      5,
      3,
      2,
      [text],
      [0],
      [wordsStarts],
      [wordsEnds],
      idToClass,
      logits,
      true,
      0.5,
      false,
    );
    expect(result[0]).toHaveLength(2);
    const labels = result[0].map((s) => s[3]);
    expect(labels).toContain("person");
    expect(labels).toContain("organization");
  });

  it("respects threshold parameter", () => {
    // logit of 0 gives sigmoid ≈ 0.5
    const logits = buildLogits(1, 5, 3, 2, [
      { batch: 0, startToken: 0, widthOffset: 0, entity: 0, value: 0 },
    ]);

    const resultLow = decodeSpans(
      1,
      5,
      3,
      2,
      [text],
      [0],
      [wordsStarts],
      [wordsEnds],
      idToClass,
      logits,
      true,
      0.4,
      false,
    );
    expect(resultLow[0]).toHaveLength(1);

    const resultHigh = decodeSpans(
      1,
      5,
      3,
      2,
      [text],
      [0],
      [wordsStarts],
      [wordsEnds],
      idToClass,
      logits,
      true,
      0.6,
      false,
    );
    expect(resultHigh[0]).toHaveLength(0);
  });

  it("handles multi-label mode (same span, different labels)", () => {
    // Same span [0,0] detected as both person and organization
    const logits = buildLogits(1, 5, 3, 2, [
      { batch: 0, startToken: 0, widthOffset: 0, entity: 0, value: 5 },
      { batch: 0, startToken: 0, widthOffset: 0, entity: 1, value: 4 },
    ]);

    const withoutMultiLabel = decodeSpans(
      1,
      5,
      3,
      2,
      [text],
      [0],
      [wordsStarts],
      [wordsEnds],
      idToClass,
      logits,
      true,
      0.5,
      false,
    );
    expect(withoutMultiLabel[0]).toHaveLength(1);

    const withMultiLabel = decodeSpans(
      1,
      5,
      3,
      2,
      [text],
      [0],
      [wordsStarts],
      [wordsEnds],
      idToClass,
      logits,
      true,
      0.5,
      true,
    );
    expect(withMultiLabel[0]).toHaveLength(2);
  });

  it("handles multiple batches", () => {
    const texts = ["Jan works", "at Stella"];
    const starts = [
      [0, 4],
      [0, 3],
    ];
    const ends = [
      [3, 9],
      [2, 9],
    ];

    const logits = buildLogits(2, 2, 2, 1, [
      { batch: 0, startToken: 0, widthOffset: 0, entity: 0, value: 5 },
      { batch: 1, startToken: 1, widthOffset: 0, entity: 0, value: 5 },
    ]);

    const result = decodeSpans(
      2,
      2,
      2,
      1,
      texts,
      [0, 1],
      starts,
      ends,
      { 1: "entity" },
      logits,
      true,
      0.5,
      false,
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(1);
    expect(result[0][0][0]).toBe("Jan");
    expect(result[1]).toHaveLength(1);
    expect(result[1][0][0]).toBe("Stella");
  });

  it("output spans are sorted by start position", () => {
    // Detect entities at positions 4 and 0 (reversed order by score)
    const logits = buildLogits(1, 5, 3, 2, [
      { batch: 0, startToken: 4, widthOffset: 0, entity: 1, value: 8 },
      { batch: 0, startToken: 0, widthOffset: 0, entity: 0, value: 3 },
    ]);
    const result = decodeSpans(
      1,
      5,
      3,
      2,
      [text],
      [0],
      [wordsStarts],
      [wordsEnds],
      idToClass,
      logits,
      true,
      0.5,
      false,
    );
    expect(result[0]).toHaveLength(2);
    // Should be sorted by start position, not score
    expect(result[0][0][1]).toBeLessThan(result[0][1][1]);
  });
});
