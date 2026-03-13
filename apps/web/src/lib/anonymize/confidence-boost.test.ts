import { boostNearMissEntities } from "./confidence-boost";
import type { Entity } from "./types";
import { DETECTION_SOURCES } from "./types";

const entity = (
  start: number,
  score: number,
  source = DETECTION_SOURCES.NER as Entity["source"],
): Entity => ({
  start,
  end: start + 10,
  label: "person",
  text: `entity-${start}`,
  score,
  source,
});

describe("boostNearMissEntities()", () => {
  const threshold = 0.3;

  it("passes through entities above threshold", () => {
    const entities = [entity(0, 0.5)];
    const result = boostNearMissEntities(entities, threshold);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.5);
  });

  it("drops entities far below threshold", () => {
    const entities = [entity(0, 0.05)];
    const result = boostNearMissEntities(entities, threshold);
    expect(result).toHaveLength(0);
  });

  it("promotes near-miss entity with nearby anchor", () => {
    // score 0.26 + 1 neighbour * 0.05 = 0.31 >= 0.30
    const entities = [
      entity(100, 1, DETECTION_SOURCES.REGEX),
      entity(120, 0.26),
    ];
    const result = boostNearMissEntities(entities, threshold);
    const boosted = result.find((e) => e.start === 120);
    expect(boosted).toBeDefined();
    expect(boosted?.score).toBeGreaterThanOrEqual(threshold);
  });

  it("does not promote without nearby anchors", () => {
    const entities = [entity(0, 1, DETECTION_SOURCES.REGEX), entity(500, 0.22)];
    const result = boostNearMissEntities(entities, threshold);
    expect(result.find((e) => e.start === 500)).toBeUndefined();
  });

  it("adds +0.05 per co-located confirmed entity", () => {
    const entities = [
      entity(100, 1, DETECTION_SOURCES.REGEX),
      entity(120, 1, DETECTION_SOURCES.REGEX),
      entity(140, 0.22),
    ];
    const result = boostNearMissEntities(entities, threshold);
    const boosted = result.find((e) => e.start === 140);
    expect(boosted).toBeDefined();
    expect(boosted?.score).toBeCloseTo(0.32, 2);
  });

  it("does not modify scores of confirmed entities", () => {
    const entities = [entity(100, 1, DETECTION_SOURCES.REGEX)];
    const result = boostNearMissEntities(entities, threshold);
    expect(result[0].score).toBe(1);
  });
});
