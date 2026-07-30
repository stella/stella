import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { LIMITS } from "@/api/lib/limits";

export const SEARCH_PREVIEW_SOURCE_CHARACTER_LIMIT = 50_000;
export const SEARCH_PREVIEW_TITLE_CHARACTER_LIMIT = 1000;
export const SEARCH_PREVIEW_PASSAGE_OVERLAP = LIMITS.searchQueryMaxLength;

export type SearchPreviewPassage = {
  content: string;
  ordinal: number;
};

type PreviewPassageValueRowsOptions = {
  generation: string;
  leadingValues: SQL[];
  passages: readonly SearchPreviewPassage[];
  regconfig: SQL;
  useUnaccent: boolean;
};

const utf16EndForCodePoints = (
  text: string,
  start: number,
  codePointCount: number,
): number => {
  let end = start;
  let remaining = codePointCount;
  while (end < text.length && remaining > 0) {
    const codePoint = text.codePointAt(end);
    if (codePoint === undefined) {
      break;
    }
    end += codePoint > 0xff_ff ? 2 : 1;
    remaining -= 1;
  }
  return end;
};

const codePointLength = (text: string): number => {
  let count = 0;
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    index += codePoint > 0xff_ff ? 2 : 1;
    count += 1;
  }
  return count;
};

export const buildSearchPreviewPassages = (
  title: string,
  body: string,
): SearchPreviewPassage[] => {
  const titleEnd = utf16EndForCodePoints(
    title,
    0,
    SEARCH_PREVIEW_TITLE_CHARACTER_LIMIT,
  );
  const titlePrefix = title.slice(0, titleEnd);
  const bodyCharacterLimit =
    SEARCH_PREVIEW_SOURCE_CHARACTER_LIMIT - codePointLength(titlePrefix) - 1;
  const passageStep = bodyCharacterLimit - SEARCH_PREVIEW_PASSAGE_OVERLAP;
  const passages: SearchPreviewPassage[] = [];
  let bodyStart = 0;
  let ordinal = 0;

  for (;;) {
    const bodyEnd = utf16EndForCodePoints(body, bodyStart, bodyCharacterLimit);
    passages.push({
      content: `${titlePrefix} ${body.slice(bodyStart, bodyEnd)}`,
      ordinal,
    });
    if (bodyEnd >= body.length) {
      return passages;
    }

    bodyStart = utf16EndForCodePoints(body, bodyStart, passageStep);
    ordinal += 1;
  }
};

export const buildSearchPreviewPassageValueRows = ({
  generation,
  leadingValues,
  passages,
  regconfig,
  useUnaccent,
}: PreviewPassageValueRowsOptions): SQL => {
  const values = passages.map(({ content, ordinal }) => {
    const normalized = useUnaccent
      ? sql`unaccent(arabic_normalize(${content}))`
      : sql`arabic_normalize(${content})`;
    return sql`(
      ${sql.join(leadingValues, sql`, `)},
      ${generation}::uuid,
      ${ordinal},
      ${content},
      to_tsvector(${regconfig}::regconfig, ${normalized})
    )`;
  });
  return sql.join(values, sql`, `);
};
