import { slugify } from "@stll/text-normalize";

import type { SafeId } from "@/api/lib/branded-types";

const TAG_ESCAPE = "\\";
const TAG_SEPARATOR = ",";

export const deriveClauseSlug = (
  title: string,
  clauseId: SafeId<"clause">,
  providedSlug: string,
): string =>
  slugify(providedSlug || title, {
    charset: "ascii",
    separator: "-",
    maxLength: 56,
    fallback: `clause-${clauseId}`,
  });

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
