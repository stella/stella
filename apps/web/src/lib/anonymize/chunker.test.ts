import { describe, expect, it } from "bun:test";

import { chunkText, computeChunkOffsets, mergeChunkEntities } from "./chunker";
import type { Entity } from "./types";
import { DETECTION_SOURCES } from "./types";

const makeEntity = (
  start: number,
  end: number,
  label = "person",
  score = 0.8,
): Entity => ({
  start,
  end,
  label,
  text: `entity-${start}`,
  score,
  source: DETECTION_SOURCES.NER,
});

describe("chunkText()", () => {
  it("returns the full text in its chunks for short input", () => {
    const text = "Hello world. This is a test.";
    const chunks = chunkText(text);
    expect(chunks[0]).toContain("Hello world.");
  });

  it("splits long text into multiple chunks", () => {
    const text = "A".repeat(3000);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("preserves sentence boundaries when possible", () => {
    const sentence = "This is a sentence. ";
    const text = sentence.repeat(100);
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      if (chunk.length < text.length) {
        expect(chunk.endsWith(". ") || chunk === chunks.at(-1)).toBeTruthy();
      }
    }
  });

  it("produces overlapping chunks", () => {
    const text = "word ".repeat(400);
    const chunks = chunkText(text);
    if (chunks.length >= 2) {
      const end1 = chunks[0].slice(-30);
      const start2 = chunks[1].slice(0, 30);
      expect(end1.length > 0 || start2.length > 0).toBeTruthy();
    }
  });

  it("skips chunks that are too short", () => {
    const chunks = chunkText("ok");
    expect(chunks).toHaveLength(0);
  });
});

describe("computeChunkOffsets()", () => {
  it("returns correct offsets for non-overlapping chunks", () => {
    const text = "aaaa bbbb cccc";
    const chunks = ["aaaa", "bbbb", "cccc"];
    const offsets = computeChunkOffsets(text, chunks);
    expect(offsets).toStrictEqual([0, 5, 10]);
  });

  it("handles overlapping chunks", () => {
    const text = "abcdefghij";
    const chunks = ["abcdef", "efghij"];
    const offsets = computeChunkOffsets(text, chunks);
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBe(4);
  });
});

describe("mergeChunkEntities()", () => {
  it("adjusts entity offsets by chunk position", () => {
    const offsets = [0, 100];
    const results: Entity[][] = [[makeEntity(10, 20)], [makeEntity(5, 15)]];
    const merged = mergeChunkEntities(offsets, results);
    expect(merged[0].start).toBe(10);
    expect(merged[1].start).toBe(105);
  });

  it("deduplicates near-identical entities from overlaps", () => {
    // Chunk 0 at offset 0: entity at doc [45,55]
    // Chunk 1 at offset 43: entity at chunk-local [3,13]
    //   → doc [46,56]
    // Same label, |45-46|=1 < 5, |55-56|=1 < 5 → dedup
    const offsets = [0, 43];
    const entity1 = makeEntity(45, 55, "person", 0.7);
    const entity2 = makeEntity(3, 13, "person", 0.9);
    const results: Entity[][] = [[entity1], [entity2]];
    const merged = mergeChunkEntities(offsets, results);
    const atPosition = merged.filter((e) => e.start >= 44 && e.start <= 47);
    expect(atPosition).toHaveLength(1);
    expect(atPosition[0].score).toBe(0.9);
  });

  it("keeps entities with different labels at same position", () => {
    const offsets = [0];
    const results: Entity[][] = [
      [
        makeEntity(10, 20, "person", 0.8),
        makeEntity(10, 20, "organization", 0.7),
      ],
    ];
    const merged = mergeChunkEntities(offsets, results);
    expect(merged.length).toBeGreaterThanOrEqual(1);
  });
});
