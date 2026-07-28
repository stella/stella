import type { SafeId } from "@/api/lib/branded-types";
import { slugifyAscii } from "@/api/lib/slug";

const TAG_ESCAPE = "\\";
const TAG_SEPARATOR = ",";

export const deriveClauseSlug = (
  title: string,
  clauseId: SafeId<"clause">,
  providedSlug: string,
): string => {
  if (providedSlug) {
    return providedSlug;
  }

  return slugifyAscii(title, {
    fallback: `clause-${clauseId}`,
    maxLength: 56,
  });
};

export const serializeClauseTags = (tags: readonly string[]): string =>
  tags
    .map((tag) =>
      tag
        .replaceAll(TAG_ESCAPE, () => `${TAG_ESCAPE}${TAG_ESCAPE}`)
        .replaceAll(TAG_SEPARATOR, () => `${TAG_ESCAPE}${TAG_SEPARATOR}`),
    )
    .join(TAG_SEPARATOR);

export const parseClauseTags = (serialized: string): string[] => {
  if (!serialized) {
    return [];
  }

  const tags: string[] = [];
  let tag = "";

  for (let index = 0; index < serialized.length; index += 1) {
    const character = serialized[index];
    const nextCharacter = serialized[index + 1];

    if (
      character === TAG_ESCAPE &&
      (nextCharacter === TAG_ESCAPE || nextCharacter === TAG_SEPARATOR)
    ) {
      tag += nextCharacter;
      index += 1;
      continue;
    }

    if (character === TAG_SEPARATOR) {
      const trimmed = tag.trim();
      if (trimmed) {
        tags.push(trimmed);
      }
      tag = "";
      continue;
    }

    tag += character;
  }

  const trimmed = tag.trim();
  if (trimmed) {
    tags.push(trimmed);
  }

  return tags;
};
