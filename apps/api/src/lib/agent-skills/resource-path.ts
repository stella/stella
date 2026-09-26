import { SKILL_RESOURCE_PATH_PATTERN } from "@stll/api-contract";
import { getSkillResourceKind } from "@stll/skills/resource-kinds";
import type { SkillResourceKind } from "@stll/skills/resource-kinds";

// Rules:
//   - No leading slash, no traversal segments, no empty segments.
//   - Only lowercase letters, digits, dots, hyphens, underscores in each
//     segment. Slashes separate folders.
//   - At least one character per segment.
//
// `update.ts` only enforces a length cap; this helper is used by
// `create.ts` and `rename.ts` to reject paths that the file tree
// would otherwise be unable to render correctly. The browser-safe pattern is
// shared with the editor through @stll/api-contract.
export const RESOURCE_PATH_PATTERN = SKILL_RESOURCE_PATH_PATTERN;

// Authored files may live outside the skill package resource folders; those
// are assets. Inside them the package classifier decides, so an authored file
// and an imported one at the same path always get the same kind.
export const inferResourceKind = (path: string): SkillResourceKind =>
  getSkillResourceKind(path) ?? "asset";
