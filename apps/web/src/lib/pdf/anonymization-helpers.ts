import type { CharSpan } from "@/lib/anonymize/pdf-coords";

import type {
  EntityOverlay,
  EntitySpan,
  FileAnonymization,
} from "./anonymization-types";

/**
 * Map an entity's character offset range to the CharSpans
 * it overlaps, returning just the page index and clamped
 * offsets. No measurement; pure offset math.
 */
export const getEntitySpans = ({
  charSpans,
  entityStart,
  entityEnd,
}: {
  charSpans: CharSpan[];
  entityStart: number;
  entityEnd: number;
}): EntitySpan[] => {
  const result: EntitySpan[] = [];
  for (const span of charSpans) {
    if (span.end <= entityStart || span.start >= entityEnd) {
      continue;
    }
    result.push({
      start: Math.max(span.start, entityStart),
      end: Math.min(span.end, entityEnd),
      pageIndex: span.bbox.pageIndex,
    });
  }
  return result;
};

export const buildPerPage = (
  entities: EntityOverlay[],
): Map<number, EntityOverlay[]> => {
  const perPage = new Map<number, EntityOverlay[]>();
  for (const entity of entities) {
    const seenPages = new Set<number>();
    for (const span of entity.spans) {
      if (seenPages.has(span.pageIndex)) {
        continue;
      }
      seenPages.add(span.pageIndex);
      const list = perPage.get(span.pageIndex) ?? [];
      list.push(entity);
      perPage.set(span.pageIndex, list);
    }
  }
  return perPage;
};

export const rebuildFileAnonymization = (
  file: FileAnonymization,
  entities: EntityOverlay[],
): FileAnonymization => ({
  ...file,
  entities,
  perPage: buildPerPage(entities),
});
