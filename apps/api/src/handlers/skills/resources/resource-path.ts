import type { AgentSkillResourceKind } from "@/api/db/schema";

// Allowed shapes:
//   references/<file>            (kind = reference)
//   prompts/<file>                (kind = prompt)
//   knowledge/<file>              (kind = knowledge)
//   <file> (no slash)             (kind = asset)
//   <folder>/<file> other folder  (kind = asset)
//
// Rules:
//   - No leading slash, no traversal segments, no empty segments.
//   - Only lowercase letters, digits, dots, hyphens, underscores in each
//     segment. Slashes separate folders.
//   - At least one character per segment.
//
// `update.ts` only enforces a length cap; this helper is used by
// `create.ts` and `rename.ts` to reject paths that the file tree
// would otherwise be unable to render correctly.
export const RESOURCE_PATH_PATTERN =
  /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/u;

const REFERENCE_PREFIX = "references/";
const PROMPT_PREFIX = "prompts/";
const KNOWLEDGE_PREFIX = "knowledge/";

export const inferResourceKind = (path: string): AgentSkillResourceKind => {
  if (path.startsWith(REFERENCE_PREFIX)) {
    return "reference";
  }
  if (path.startsWith(PROMPT_PREFIX)) {
    return "prompt";
  }
  if (path.startsWith(KNOWLEDGE_PREFIX)) {
    return "knowledge";
  }
  return "asset";
};
