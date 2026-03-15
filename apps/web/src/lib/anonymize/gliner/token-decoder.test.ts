import { describe, expect, it } from "bun:test";

import { decodeTokenSpans } from "./token-decoder";

/**
 * Tests for the token-level BIO decoder used by
 * GLiNER TokenGLiNER models (e.g., PII Edge).
 *
 * Output shape: [B, L, C, 3] where 3 = [B, I, O] tags.
 * Logits are pre-sigmoid (raw model output).
 */

// Helper: build a flat logits array for shape [1, L, C, 3]
// where entries is a map of (word, label, tag) → logit value.
// Unset positions default to -10 (sigmoid → ~0).
const buildLogits = (
  numWords: number,
  numLabels: number,
  entries: {
    word: number;
    label: number;
    tag: "B" | "I" | "O";
    logit: number;
  }[],
): number[] => {
  const size = numWords * numLabels * 3;
  const logits = Array.from<number>({ length: size }).fill(-10);
  const tagIdx = { B: 0, I: 1, O: 2 };

  for (const e of entries) {
    const idx = e.word * numLabels * 3 + e.label * 3 + tagIdx[e.tag];
    logits[idx] = e.logit;
  }

  return logits;
};

describe("decodeTokenSpans", () => {
  const idToClass: Record<number, string> = {
    1: "name",
    2: "phone number",
  };

  it("detects a single-word entity (B tag only)", () => {
    // "John works here" — word 0 = John, word 1 = works, word 2 = here
    const logits = buildLogits(3, 2, [
      { word: 0, label: 0, tag: "B", logit: 2 }, // name, sigmoid(2) ≈ 0.88
    ]);

    const result = decodeTokenSpans(
      1,
      3,
      2,
      ["John works here"],
      [0],
      [[0, 5, 11]],
      [[4, 10, 15]],
      idToClass,
      logits,
      0.5,
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(1);

    const entity = result[0]?.[0];
    expect(entity?.[0]).toBe("John"); // text
    expect(entity?.[1]).toBe(0); // start
    expect(entity?.[2]).toBe(4); // end
    expect(entity?.[3]).toBe("name"); // label
    expect(entity?.[4]).toBeGreaterThan(0.8); // score
  });

  it("detects a multi-word entity (B + I tags)", () => {
    // "Call 415 555 1234 please"
    const logits = buildLogits(5, 2, [
      { word: 1, label: 1, tag: "B", logit: 2 }, // phone, B on "415"
      { word: 2, label: 1, tag: "I", logit: 1.5 }, // phone, I on "555"
      { word: 3, label: 1, tag: "I", logit: 1.5 }, // phone, I on "1234"
    ]);

    const result = decodeTokenSpans(
      1,
      5,
      2,
      ["Call 415 555 1234 please"],
      [0],
      [[0, 5, 9, 13, 18]],
      [[4, 8, 12, 17, 24]],
      idToClass,
      logits,
      0.5,
    );

    expect(result[0]).toHaveLength(1);

    const entity = result[0]?.[0];
    expect(entity?.[0]).toBe("415 555 1234"); // text
    expect(entity?.[3]).toBe("phone number"); // label
  });

  it("detects multiple non-overlapping entities", () => {
    // "John called 415"
    const logits = buildLogits(3, 2, [
      { word: 0, label: 0, tag: "B", logit: 2 }, // name: John
      { word: 2, label: 1, tag: "B", logit: 2 }, // phone: 415
    ]);

    const result = decodeTokenSpans(
      1,
      3,
      2,
      ["John called 415"],
      [0],
      [[0, 5, 12]],
      [[4, 11, 15]],
      idToClass,
      logits,
      0.5,
    );

    expect(result[0]).toHaveLength(2);
    expect(result[0]?.[0]?.[3]).toBe("name");
    expect(result[0]?.[1]?.[3]).toBe("phone number");
  });

  it("filters entities below threshold", () => {
    const logits = buildLogits(3, 2, [
      { word: 0, label: 0, tag: "B", logit: -0.5 }, // sigmoid ≈ 0.38, below 0.5
    ]);

    const result = decodeTokenSpans(
      1,
      3,
      2,
      ["John works here"],
      [0],
      [[0, 5, 11]],
      [[4, 10, 15]],
      idToClass,
      logits,
      0.5,
    );

    expect(result[0]).toHaveLength(0);
  });

  it("resolves overlapping spans via greedy selection", () => {
    // Both labels fire on word 0, only highest score survives
    const logits = buildLogits(3, 2, [
      { word: 0, label: 0, tag: "B", logit: 2 }, // name: high
      { word: 0, label: 1, tag: "B", logit: 1 }, // phone: lower
    ]);

    const result = decodeTokenSpans(
      1,
      3,
      2,
      ["John works here"],
      [0],
      [[0, 5, 11]],
      [[4, 10, 15]],
      idToClass,
      logits,
      0.5,
    );

    expect(result[0]).toHaveLength(1);
    expect(result[0]?.[0]?.[3]).toBe("name"); // higher score wins
  });

  it("handles empty text (no words)", () => {
    const result = decodeTokenSpans(
      1,
      0,
      2,
      [""],
      [0],
      [[]],
      [[]],
      idToClass,
      [],
      0.5,
    );

    expect(result[0]).toHaveLength(0);
  });

  it("stops I-tag extension at threshold boundary", () => {
    // B tag on word 0, I tag on word 1 (high), I tag on word 2 (below threshold)
    const logits = buildLogits(4, 2, [
      { word: 0, label: 0, tag: "B", logit: 2 },
      { word: 1, label: 0, tag: "I", logit: 1.5 },
      { word: 2, label: 0, tag: "I", logit: -1 }, // below threshold
    ]);

    const result = decodeTokenSpans(
      1,
      4,
      2,
      ["John Smith works here"],
      [0],
      [[0, 5, 11, 17]],
      [[4, 10, 16, 21]],
      idToClass,
      logits,
      0.5,
    );

    expect(result[0]).toHaveLength(1);
    expect(result[0]?.[0]?.[0]).toBe("John Smith"); // stops before "works"
  });
});
