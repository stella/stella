/**
 * The prompt inputs serialize a picked skill as the markdown link
 * `[label](#stella-skill-ref=slug)`. This module is the API's one reader of
 * that form.
 */
export const SKILL_REF_HREF_PREFIX = "#stella-skill-ref=";

// The slug sits inside the link target, so it runs up to the closing paren or
// whitespace. The prefix carries no pattern metacharacters.
const SKILL_REF_PATTERN = new RegExp(
  `${SKILL_REF_HREF_PREFIX}(?<slug>[^)\\s]+)`,
  "gu",
);

/** Distinct skill slugs a text references, in order of first reference. */
export const extractSkillRefSlugs = (text: string): string[] => {
  const slugs = new Set<string>();
  for (const match of text.matchAll(SKILL_REF_PATTERN)) {
    const slug = match.groups?.["slug"];
    if (slug !== undefined) {
      slugs.add(slug);
    }
  }
  return [...slugs];
};
