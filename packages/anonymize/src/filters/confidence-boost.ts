import type { Entity } from "../types";

const NEAR_MISS_BAND = 0.15;
const BOOST_PER_NEIGHBOUR = 0.05;
const CONTEXT_WINDOW_CHARS = 150;
const HIGH_CONFIDENCE_FLOOR = 0.9;

/**
 * Boost confidence of near-miss NER entities that appear
 * near high-confidence detections (regex, trigger phrase).
 *
 * If an NER entity scored between (threshold - 0.15) and
 * threshold, count how many confirmed entities exist within
 * a 150-char window. Add +0.05 per co-located entity.
 * If the boosted score crosses the threshold, include it.
 *
 * Only mutates score on near-miss entities; high-confidence
 * entities pass through unchanged.
 */
export const boostNearMissEntities = (
  entities: Entity[],
  threshold: number,
): Entity[] => {
  const nearMissBand = Math.max(0, threshold - NEAR_MISS_BAND);
  const confirmed = entities.filter((e) => e.score >= HIGH_CONFIDENCE_FLOOR);

  const boosted: Entity[] = [];

  for (const entity of entities) {
    if (entity.score >= threshold) {
      boosted.push(entity);
      continue;
    }

    if (entity.score < nearMissBand) {
      continue;
    }

    const midpoint = (entity.start + entity.end) / 2;
    let neighbourCount = 0;

    for (const anchor of confirmed) {
      const anchorMid = (anchor.start + anchor.end) / 2;
      if (Math.abs(midpoint - anchorMid) <= CONTEXT_WINDOW_CHARS) {
        neighbourCount++;
      }
    }

    const boostedScore = entity.score + neighbourCount * BOOST_PER_NEIGHBOUR;

    if (boostedScore >= threshold) {
      boosted.push({ ...entity, score: boostedScore });
    }
  }

  return boosted;
};
