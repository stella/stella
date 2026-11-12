import type { SkillDraftNameKind } from "@stll/api-contract";

/** A skill draft as the API returns it for review. */
export type SkillDraft = {
  markdown: string;
  resources: { content: string; path: string }[];
};

/** One name of a person or organization the draft holds. */
export type SkillDraftName = { kind: SkillDraftNameKind; value: string };

const replaceAll = (
  text: string,
  replacements: ReadonlyMap<string, string>,
) => {
  let next = text;
  for (const [value, role] of replacements) {
    next = next.split(value).join(role);
  }
  return next;
};

/**
 * The draft with each name the author did not keep replaced by its role, in
 * SKILL.md and in every companion file. Paths stay: a name in a path is shown
 * for review like any other and the server checks the draft again.
 */
export const replaceDraftNames = (
  draft: SkillDraft,
  replaced: readonly SkillDraftName[],
  roleOf: (kind: SkillDraftNameKind) => string,
): SkillDraft => {
  // Longer names first, so a name inside another is not replaced half-way.
  const replacements = new Map(
    [...replaced]
      .toSorted((left, right) => right.value.length - left.value.length)
      .map(({ kind, value }) => [value, roleOf(kind)] as const),
  );
  return {
    markdown: replaceAll(draft.markdown, replacements),
    resources: draft.resources.map((resource) => ({
      path: resource.path,
      content: replaceAll(resource.content, replacements),
    })),
  };
};
