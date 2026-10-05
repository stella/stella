import { Result } from "better-result";

import {
  glyphBoxesByPage,
  locateAnonymizationTerm,
} from "@/lib/anonymize/pdf-anonymization-geometry";
import type { PdfAnonymizationText } from "@/lib/anonymize/pdf-anonymization-geometry";

import type { EntityOverlay, FileAnonymization } from "./anonymization-types";

type LocateOverlayEntitiesOptions = {
  extraction: PdfAnonymizationText;
  term: string;
  label: string;
  allocateId: () => number;
  /** `start:end` of occurrences already overlaid; extended in place. */
  seenRanges: Set<string>;
};

/**
 * One overlay entity per new occurrence of `term`, drawn from the same glyph
 * boxes the redacted export masks. Fails when any occurrence cannot be fully
 * positioned, so the overlay never shows part of a term as covered.
 */
export const locateOverlayEntities = ({
  extraction,
  term,
  label,
  allocateId,
  seenRanges,
}: LocateOverlayEntitiesOptions) => {
  const located = locateAnonymizationTerm(extraction, term);
  if (located.isErr()) {
    return Result.err(located.error);
  }
  const entities: EntityOverlay[] = [];
  for (const { start, end, glyphs } of located.value) {
    const key = `${String(start)}:${String(end)}`;
    if (seenRanges.has(key)) {
      continue;
    }
    seenRanges.add(key);
    entities.push({
      id: allocateId(),
      label,
      // The canonical term, so every occurrence counts under one entry.
      text: term,
      boxesByPage: glyphBoxesByPage(glyphs),
    });
  }
  return Result.ok(entities);
};

export const buildPerPage = (
  entities: EntityOverlay[],
): Map<number, EntityOverlay[]> => {
  const perPage = new Map<number, EntityOverlay[]>();
  for (const entity of entities) {
    for (const pageIndex of entity.boxesByPage.keys()) {
      const existing = perPage.get(pageIndex);
      if (existing) {
        existing.push(entity);
      } else {
        perPage.set(pageIndex, [entity]);
      }
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
