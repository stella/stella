import type { Result } from "better-result";

import { sanitizeDraftResources } from "@/api/lib/agent-skills/draft-prompt";
import { stripMarkdownFences } from "@/api/lib/agent-skills/markdown-fences";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { ParsedSkillPackage } from "@/api/lib/skills/skill-package";
import { parseSkillFiles } from "@/api/lib/skills/skill-package";

const encoder = new TextEncoder();

/** A skill draft as a model writes it and its author reviews it. */
export type SkillDraft = {
  markdown: string;
  resources: { content: string; path: string }[];
};

/**
 * Tidy a draft the way every draft path does (no code fences around
 * SKILL.md, only companion files a skill may hold) and validate it as the
 * package every install path stores.
 */
export const parseSkillDraft = (raw: {
  markdown: string;
  resources: readonly { content: string; path: string }[];
}): {
  draft: SkillDraft;
  parsed: Result<ParsedSkillPackage, HandlerError>;
} => {
  const draft = {
    markdown: stripMarkdownFences(raw.markdown),
    resources: sanitizeDraftResources(raw.resources),
  };
  return {
    draft,
    parsed: parseSkillFiles([
      {
        content: draft.markdown,
        path: "SKILL.md",
        sizeBytes: encoder.encode(draft.markdown).byteLength,
      },
      ...draft.resources.map((resource) => ({
        ...resource,
        sizeBytes: encoder.encode(resource.content).byteLength,
      })),
    ]),
  };
};

/** Every text of a draft a name could sit in: SKILL.md, file paths, files. */
export const skillDraftTexts = (draft: SkillDraft): string[] => [
  draft.markdown,
  ...draft.resources.flatMap(({ content, path }) => [path, content]),
];
