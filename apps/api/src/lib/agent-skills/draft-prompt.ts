import * as v from "valibot";

import { SKILL_RESOURCE_FOLDERS } from "@stll/skills/format";

import { isAiResourcePath } from "@/api/handlers/skills/ai-resource-path";
import { LIMITS } from "@/api/lib/limits";

/** Companion files one generated draft may carry. */
const AI_RESOURCES_MAX = 8;
// Generated resources pass through the model whole.
const RESOURCE_CONTENT_MAX = LIMITS.agentSkillResourceModelContextMaxChars;
export const RESOURCE_FOLDER_LIST = [...SKILL_RESOURCE_FOLDERS]
  .map((folder) => `${folder}/`)
  .join(", ");

const aiResourceSchema = v.strictObject({
  path: v.pipe(
    v.string(),
    v.description(
      `Relative path inside the skill folder. Must start with one of ${RESOURCE_FOLDER_LIST} and end in .md. Subfolders are allowed to organise material (e.g. references/cz/act-110.md). Use lowercase letters, digits, hyphens, dots, or underscores in each segment.`,
    ),
  ),
  content: v.pipe(
    v.string(),
    v.description("Full Markdown content for the file."),
  ),
});

/** The model's output for every skill draft. */
export const aiGenerationSchema = v.strictObject({
  markdown: v.pipe(
    v.string(),
    v.description(
      "Full SKILL.md including YAML frontmatter (name, description, optional version/license/compatibility) and the Markdown body. No surrounding code fences.",
    ),
  ),
  resources: v.pipe(
    v.array(aiResourceSchema),
    v.description(
      "Optional companion files for the skill folder. Return an empty array if no supporting files are needed.",
    ),
  ),
});

type GeneratedResource = { content: string; path: string };

/** Keep the companion files a skill may hold: valid paths, once, in budget. */
export const sanitizeDraftResources = (
  raw: readonly { content: string; path: string }[],
): GeneratedResource[] => {
  const seen = new Set<string>();
  const result: GeneratedResource[] = [];

  for (const item of raw) {
    if (result.length >= AI_RESOURCES_MAX) {
      break;
    }
    const path = item.path.trim();
    if (!isAiResourcePath(path) || seen.has(path)) {
      continue;
    }
    const content = item.content;
    if (content.length === 0 || content.length > RESOURCE_CONTENT_MAX) {
      continue;
    }
    seen.add(path);
    result.push({ content, path });
  }

  return result;
};

const DRAFT_RULES = `You are drafting a stella agent skill, returned as JSON matching the provided schema.

A skill bundle contains a SKILL.md file at the root and zero or more companion Markdown files under fixed subfolders. The bundle teaches an AI agent when to use the skill and how to follow it.

SKILL.md rules:
- YAML frontmatter delimited by lines containing only "---".
- Required: name (lowercase letters/digits/hyphens, max 64 chars, starts with a letter or digit) and description (one sentence, <= 300 chars, helps the AI decide when to trigger the skill).
- Optional: version (semver), license (SPDX id), compatibility.
- Body: clear, imperative Markdown for the agent. Cover when to use the skill, the steps to follow, and any constraints. Reference companion files by relative path when appropriate (e.g. "see references/01-foundations.md").
- Keep the body under 2,000 words. No code fences around the whole file.

Companion files (the "resources" array):
- Each path must start with one of ${RESOURCE_FOLDER_LIST} and end in .md. Lowercase letters, digits, hyphens, dots, and underscores only. Subfolders are allowed to organise material by topic, jurisdiction, or source type. Examples: references/01-foundations.md, references/draft-summary.prompt.md, references/checklists.md, references/cz/act-110.md, references/case-law/supreme.md.
- scripts/* — Markdown instructions for helper scripts.
- assets/* — supporting text assets.
- references/* — checklists, lookup tables, format guides.
- Each file is plain Markdown. No frontmatter on companion files.
- Return at most ${AI_RESOURCES_MAX} files. Only include a file if it genuinely helps the skill; return an empty array if none are needed.
- Never invent legal facts, jurisdictions, citations, or company details. Stay generic unless the user supplied specifics.`;

// A skill is reused across matters and shared with whoever may use it, so the
// draft keeps the method and leaves this matter's details out; the lawyer
// approves every name that remains before it is stored.
const SOURCE_RULES = `The source below is a finished piece of the lawyer's own work on one matter.
- Learn the method from it: what the lawyer asked for, the steps taken, the structure and tone of the result, the sources relied on, and every correction the lawyer made along the way. Corrections are the lawyer's standards; make them rules of the skill.
- The skill must work for the next matter of the same kind, not this one. Leave out the names, dates, amounts, identifiers and other details of this matter. Where the skill needs a case-specific value, name its role in angle brackets, such as <client name> or <date of the flight>. Name a person or organization only when every such matter involves them (the lawyer's own firm, a regulator).
- Keep legal sources the lawyer relied on when they apply to every such matter (a regulation, a statute, a leading decision), not facts of this case.`;

/** Everything a skill draft is generated from. */
export type SkillDraftPromptInput = {
  intent: string;
  examples?: string | undefined;
  previousDraft?: string | undefined;
  previousResources?: readonly { content: string; path: string }[] | undefined;
  feedback?: string | undefined;
  /** A finished chat, its case details already replaced by placeholders. */
  sourceTranscript?: string | undefined;
};

export const buildSkillDraftPrompt = ({
  intent,
  examples,
  previousDraft,
  previousResources,
  feedback,
  sourceTranscript,
}: SkillDraftPromptInput): string => {
  const sections = [DRAFT_RULES, `User intent:\n${intent.trim()}`];

  const trimmedSource = sourceTranscript?.trim();
  if (trimmedSource) {
    sections.push(
      SOURCE_RULES,
      `Source chat:\n\`\`\`\n${trimmedSource}\n\`\`\``,
    );
  }

  const trimmedExamples = examples?.trim();
  if (trimmedExamples) {
    sections.push(`Example trigger phrases or scenarios:\n${trimmedExamples}`);
  }

  const trimmedPrevious = previousDraft?.trim();
  if (trimmedPrevious) {
    sections.push(
      `Previous SKILL.md to revise:\n\`\`\`\n${trimmedPrevious}\n\`\`\``,
    );
  }

  if (previousResources && previousResources.length > 0) {
    const formatted = previousResources
      .map(
        (resource) =>
          `### ${resource.path}\n\`\`\`\n${resource.content}\n\`\`\``,
      )
      .join("\n\n");
    sections.push(`Previous companion files:\n${formatted}`);
  }

  const trimmedFeedback = feedback?.trim();
  if (trimmedFeedback) {
    sections.push(`Revision feedback to apply:\n${trimmedFeedback}`);
  }

  sections.push(
    "Return the complete updated skill now, including all companion files.",
  );
  return sections.join("\n\n");
};
